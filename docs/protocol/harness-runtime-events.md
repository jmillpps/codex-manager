# Harness Runtime Event and Lifecycle Contracts

## Purpose

This document defines repository-specific contracts layered on top of Codex app-server:

- server-side extension runtime event dispatch
- typed handler result envelopes and reconciliation semantics
- queue lifecycle websocket events
- transcript delta/upsert contracts
- extension lifecycle list/reload surfaces

These are harness/API contracts, not native app-server JSON-RPC methods.

## Runtime event dispatch contract

Extensions are loaded from deterministic source roots and subscribe by event name.

Dispatch semantics:

- fanout: all subscribed handlers run
- deterministic order:
  - `priority` ascending
  - module name ascending
  - registration index ascending
- per-handler timeout isolation
- handler failure/timeouts are normalized as `handler_error`
- handler invocation is full fanout; action execution is first-wins reconciled per emit pass (after first `performed`, later action requests become `not_eligible` and are not executed)

## App-server signal event family

API core forwards Codex app-server signals into extension dispatch so modules can subscribe to native protocol traffic directly (alongside synthesized repository events).

Event name mapping:

- notifications: `app_server.<normalized_method>`
- server requests: `app_server.request.<normalized_method>`

Method normalization rules:

- split app-server `method` on `/`
- convert each segment from camelCase/PascalCase to `snake_case`
- join normalized segments with `.`

Examples:

- `turn/started` -> `app_server.turn.started`
- `item/fileChange/requestApproval` -> `app_server.request.item.file_change.request_approval`
- `configWarning` -> `app_server.config_warning`

All app-server signal events share one generic payload envelope:

- `source: "app_server"`
- `signalType: "notification" | "request"`
- `eventType` (final emitted extension event name)
- `method` (original app-server method string)
- `receivedAt` (ISO timestamp)
- `context`
  - `threadId` (`string | null`)
  - `turnId` (`string | null`)
- `params` (original `params`, or `null` when absent)
- `session` (`{ id, title, projectId } | null`) from API metadata when thread context is known
- `requestId` (`number | string`) for `signalType: "request"` only

Isolation rules:

- thread-scoped signals are not emitted for purged sessions
- thread-scoped signals are not emitted for system-owned worker sessions
- process/global signals without thread context still emit

Current app-server method catalog is schema-derived from:

- `packages/codex-protocol/generated/stable/json-schema/ServerNotification.json`
- `packages/codex-protocol/generated/stable/json-schema/ServerRequest.json`

### Notification methods -> emitted event names

- `account/login/completed` -> `app_server.account.login.completed`
- `account/rateLimits/updated` -> `app_server.account.rate_limits.updated`
- `account/updated` -> `app_server.account.updated`
- `app/list/updated` -> `app_server.app.list.updated`
- `authStatusChange` -> `app_server.auth_status_change`
- `configWarning` -> `app_server.config_warning`
- `deprecationNotice` -> `app_server.deprecation_notice`
- `error` -> `app_server.error`
- `item/agentMessage/delta` -> `app_server.item.agent_message.delta`
- `item/commandExecution/outputDelta` -> `app_server.item.command_execution.output_delta`
- `item/commandExecution/terminalInteraction` -> `app_server.item.command_execution.terminal_interaction`
- `item/completed` -> `app_server.item.completed`
- `item/fileChange/outputDelta` -> `app_server.item.file_change.output_delta`
- `item/mcpToolCall/progress` -> `app_server.item.mcp_tool_call.progress`
- `item/plan/delta` -> `app_server.item.plan.delta`
- `item/reasoning/summaryPartAdded` -> `app_server.item.reasoning.summary_part_added`
- `item/reasoning/summaryTextDelta` -> `app_server.item.reasoning.summary_text_delta`
- `item/reasoning/textDelta` -> `app_server.item.reasoning.text_delta`
- `item/started` -> `app_server.item.started`
- `loginChatGptComplete` -> `app_server.login_chat_gpt_complete`
- `mcpServer/oauthLogin/completed` -> `app_server.mcp_server.oauth_login.completed`
- `rawResponseItem/completed` -> `app_server.raw_response_item.completed`
- `sessionConfigured` -> `app_server.session_configured`
- `thread/compacted` -> `app_server.thread.compacted`
- `thread/name/updated` -> `app_server.thread.name.updated`
- `thread/started` -> `app_server.thread.started`
- `thread/tokenUsage/updated` -> `app_server.thread.token_usage.updated`
- `turn/completed` -> `app_server.turn.completed`
- `turn/diff/updated` -> `app_server.turn.diff.updated`
- `turn/plan/updated` -> `app_server.turn.plan.updated`
- `turn/started` -> `app_server.turn.started`
- `windows/worldWritableWarning` -> `app_server.windows.world_writable_warning`

### Server-request methods -> emitted event names

- `account/chatgptAuthTokens/refresh` -> `app_server.request.account.chatgpt_auth_tokens.refresh`
- `applyPatchApproval` -> `app_server.request.apply_patch_approval`
- `execCommandApproval` -> `app_server.request.exec_command_approval`
- `item/commandExecution/requestApproval` -> `app_server.request.item.command_execution.request_approval`
- `item/fileChange/requestApproval` -> `app_server.request.item.file_change.request_approval`
- `item/tool/call` -> `app_server.request.item.tool.call`
- `item/tool/requestUserInput` -> `app_server.request.item.tool.request_user_input`

## Core event names and payloads

### `file_change.approval_requested`

Payload:

- `context`
  - `projectId`
  - `sourceSessionId`
  - `threadId`
  - `turnId`
  - optional `itemId`, `approvalId`, `anchorItemId`, `userRequest`, `turnTranscript`
- `summary`
- `details`
- `sourceEvent`: `approval_request | approvals_reconcile`
- `fileChangeStatus`: `pending_approval`

### `turn.completed`

Payload:

- `context`
  - `projectId`
  - `sourceSessionId`
  - `threadId`
  - `turnId`
  - optional `userRequest`
- `hadFileChangeRequests` (boolean)
- `turnTranscriptSnapshot` (string)
- optional `fileChangeRequestCount` (number)

Dispatch notes:

- emitted only when per-turn file-change approval anchors were observed
- if in-memory anchors are absent (process restart), emission gating recovers file-change activity from persisted supplemental `approval.request` rows with `details.method=item/fileChange/requestApproval`
- dispatch is retried with bounded backoff when handlers are present but no actionable enqueue/action result is returned

### `suggest_request.requested`

Payload:

- `requestKey`
- `sessionId`
- `projectId` (real project id or `session:<sessionId>`)
- `threadId`
- `turnId`
- `userRequest`
- `turnTranscript`
- optional `model`, `effort`, `draft`

## Typed handler result envelopes

`emit(event, tools)` returns `AgentEventEmitResult[]` with one of:

- `enqueue_result`
  - `status: "enqueued" | "already_queued"`
  - queue job identity fields
- `action_result`
  - `actionType`
  - `status: "performed" | "already_resolved" | "not_eligible" | "conflict" | "forbidden" | "invalid" | "failed"`
- `handler_result`
  - optional diagnostics payload
- `handler_error`
  - normalized error string and event/module identity

Handlers must return `kind: "action_request"` for side effects; direct `action_result` handler returns are normalized to `status: "invalid"`.

## Reconciliation semantics

- first successful state-changing `action_result` (`status: "performed"`) is authoritative
- loser-path statuses are reconciled non-fatal outcomes:
  - `already_resolved`
  - `not_eligible`
  - `conflict`
- late agent actions after user resolution are expected reconciliation behavior

Queue winner selection for routes requiring one job id:

1. first `enqueue_result` with `status: "enqueued"`
2. otherwise first `enqueue_result` with `status: "already_queued"`
3. otherwise explicit queue conflict behavior

## Queue payload extension: `agent_instruction.supplementalTargets`

`agent_instruction` payload may include `supplementalTargets[]`:

- `messageId`
- `type`
- optional `placeholderTexts[]`
- optional terminal fallbacks (`completeFallback`, `errorFallback`, `canceledFallback`)

On terminal job states, core reconciles these transcript targets to explicit terminal entries.

## Worker action-intent contract

`agent_instruction` jobs may run with `expectResponse: "action_intents"`.

Worker output must be one JSON object:

- `kind: "action_intents"`
- `intents[]` of `kind: "action_request"` envelopes

API core validates and executes intents internally with:

- trust/capability checks
- idempotency replay/conflict handling
- scope lock to owning `sourceSessionId` + `turnId` for transcript/approval/steer actions
- deterministic fallback idempotency key derivation when worker omits `idempotencyKey` (stable across JSON key-order variance)

`agent_instruction` jobs may also run with `expectResponse: "none"`; in that mode, workers perform side effects live during the turn (for example via CLI) and no structured output envelope is required.

## Queue lifecycle websocket events

Event names:

- `orchestrator_job_queued`
- `orchestrator_job_started`
- `orchestrator_job_progress`
- `orchestrator_job_completed`
- `orchestrator_job_failed`
- `orchestrator_job_canceled`
- `suggested_request_updated`

Envelope fields:

- `type`
- `threadId` (source session id when present)
- `payload` (`jobId`, `projectId`, `jobType`, `state`, optional `sourceSessionId`, `result`, `error`, `progress`)
- for `suggested_request_updated`, payload includes `sessionId`, `requestKey`, `status` (`streaming|complete|error|canceled`), and optional `suggestion`/`error`

Client rule:

- websocket events are primary; REST polling/reload is reconcile fallback.

## Transcript delta and upsert contract

### Websocket delta event

Event name: `transcript_updated`

Envelope:

- `type: "transcript_updated"`
- `threadId`
- `payload`
  - `threadId`
  - optional `turnId`, `messageId`, `type`
  - optional `entry`

`entry` fields:

- `messageId`
- `turnId`
- `role: user | assistant | system`
- `type`
- `content`
- `status: streaming | complete | canceled | error`
- optional `details`, `startedAt`, `completedAt`

### Transcript upsert route

`POST /api/sessions/:sessionId/transcript/upsert`

Behavior:

- validates payload
- upserts by `messageId`
- emits `transcript_updated`

Error behavior:

- `410` for deleted/purged sessions
- `404` for unknown sessions
- `400` for invalid bodies

## Extension lifecycle API contract

### `GET /api/agents/extensions`

Returns active snapshot metadata and loaded module inventory including:

- origin metadata (`repo_local` | `installed_package` | `configured_root`)
- compatibility summary
- declared capabilities
- trust evaluation

### `POST /api/agents/extensions/reload`

Triggers atomic reload:

- success swaps active snapshot
- failure preserves prior snapshot
- concurrent reload attempts return `reload_in_progress`

RBAC and auth error contract:

- role mode: `AGENT_EXTENSION_RBAC_MODE=disabled|header|jwt`
- `header` mode validates shared token (`x-codex-rbac-token`) then reads `x-codex-role`, optional `x-codex-actor`
- `jwt` mode reads `Authorization: Bearer <token>` and validates role/actor claims from verified JWT payload
- errors:
  - `403 rbac_disabled_remote_forbidden`
  - `401 missing_header_token`
  - `401 invalid_header_token`
  - `401 missing_role`
  - `400 invalid_role`
  - `401 missing_bearer_token`
  - `401 invalid_bearer_token`
  - `403 invalid_role_claim`
  - `403 insufficient_role`

Trust behavior is controlled by `AGENT_EXTENSION_TRUST_MODE=disabled|warn|enforced`.

## Related references

- `docs/operations/agent-extension-authoring.md`
- `docs/operations/agent-extension-lifecycle-and-conformance.md`
- `docs/operations/agent-queue-framework.md`
- `docs/implementation-status.md`
