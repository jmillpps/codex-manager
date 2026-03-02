# Harness Runtime: Websocket, Transcript, and Lifecycle Surfaces

## Purpose

Detailed harness contract for websocket event families, transcript upsert/delta behavior, and extension lifecycle endpoints.

Use with [`harness-runtime-events.md`](./harness-runtime-events.md) for operational client/server integration work.

## Typed Handler Result Envelopes

Runtime `emit()` normalizes to:

- `enqueue_result`
- `action_result`
- `handler_result`
- `handler_error`

Action execution is first-wins reconciled within one emit pass.

## Queue Lifecycle Websocket Events

- `orchestrator_job_queued`
- `orchestrator_job_started`
- `orchestrator_job_progress`
- `orchestrator_job_completed`
- `orchestrator_job_failed`
- `orchestrator_job_canceled`
- `suggested_request_updated`

## Interactive Request Websocket Events

- `approval` / `approval_resolved`
- `tool_user_input_requested` / `tool_user_input_resolved`
- `tool_call_requested` / `tool_call_resolved`

## Raw Compatibility Websocket Events

codex-manager also emits raw compatibility envelopes for diagnostics/fallback routing:

- `notification` (raw app-server notification payload)
- `server_request` (raw server-initiated request payload for unsupported methods)

For supported interactive request methods (approval/tool-input/tool-call), specialized events are emitted instead of `server_request`.

## Notification-Derived Alias Websocket Events

codex-manager emits focused websocket aliases for several high-value app-server notifications:

- `turn_plan_updated`
- `turn_diff_updated`
- `thread_token_usage_updated`
- `app_list_updated` (global broadcast)
- `mcp_oauth_completed` (global broadcast)
- `account_updated` (global broadcast)
- `account_login_completed` (global broadcast)
- `account_rate_limits_updated` (global broadcast)

## `/api/stream` Control-Message Contract

Connection and control frames:

- server sends `{"type":"ready","threadId":<initial|null>}` immediately after connect
- client may send `{"type":"subscribe","threadId":"<sessionId>"}` to set/replace thread filter
- client may send `{"type":"unsubscribe"}` to clear thread filter
- client may send `{"type":"ping"}` and receives `{"type":"pong"}`
- invalid command payloads receive `{"type":"error","message":"invalid websocket command"}`

Event envelope shape:

- normal event frames are published as `{"type": "...", "threadId": "...|null", "payload": ...}`
- control frames (`ready`, `pong`, `error`) do not carry normal event payloads

Thread-filter behavior:

- when a socket has a thread filter, it receives only events for that thread
- filtered sockets do not receive `threadId: null` events unless event is published as global broadcast
- global broadcast events bypass normal thread filters
- system-owned thread events are force-filtered and only delivered to sockets explicitly subscribed to that exact thread

## Transcript Contracts

Websocket delta event:

- `transcript_updated` with `threadId` and upserted entry payload

Upsert API:

- `POST /api/sessions/:sessionId/transcript/upsert`

Entry fields include:

- `messageId`, `turnId`, `role`, `type`, `content`, `status`
- optional `details`, `startedAt`, `completedAt`

## Extension Lifecycle Endpoints

- `GET /api/agents/extensions`
- `POST /api/agents/extensions/reload`

Lifecycle controls are governed by RBAC mode (`disabled|header|jwt`) and trust mode (`disabled|warn|enforced`).

## Supplemental Targets Contract

`agent_instruction` payload can include `supplementalTargets[]` for terminal transcript reconciliation with deterministic fallback behavior.

## Related docs

- Harness event index: [`harness-runtime-events.md`](./harness-runtime-events.md)
- Event catalog and normalization: [`harness-runtime-event-catalog.md`](./harness-runtime-event-catalog.md)
- Extension lifecycle runbook: [`../operations/agent-extension-lifecycle-and-conformance.md`](../operations/agent-extension-lifecycle-and-conformance.md)
