# Harness Deep Dive: Websocket, Transcript, and Lifecycle Surfaces

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
