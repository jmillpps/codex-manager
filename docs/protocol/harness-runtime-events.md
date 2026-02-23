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
