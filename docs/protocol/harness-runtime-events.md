# Harness Runtime Event and Upsert Contracts

## Purpose

This document defines repository-specific protocol contracts that are layered on top of Codex app-server:

- server-side agent runtime events (`emitAgentEvent`)
- queue lifecycle websocket events
- transcript delta websocket events
- transcript upsert REST contract

Primary question:

- What payload contracts must extensions and UI clients follow for queue-driven workflows?

## Scope

These contracts are harness/API-level behavior, not native app-server protocol methods.

Related native protocol references remain in:

- `docs/protocol/events.md`
- `docs/protocol/approvals-and-tool-input.md`

## Server-side agent runtime events

Agent event handlers are loaded from `agents/*/events.(ts|js|mjs)` and subscribe by event name.

### `file_change.approval_requested`

Payload:

- `context`
  - `projectId`
  - `sourceSessionId`
  - `threadId`
  - `turnId`
  - optional: `itemId`, `approvalId`, `anchorItemId`, `userRequest`, `turnTranscript`
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

### `suggest_request.requested`

Payload:

- `requestKey`
- `sessionId`
- `projectId` (queue owner id; real project id or `session:<sessionId>` for unassigned-chat workflows)
- `threadId`
- `turnId`
- `userRequest`
- `turnTranscript`
- optional `model`
- optional `effort`
- optional `draft`

## Queue payload extension: `agent_instruction.supplementalTargets`

Agent extensions can attach supplemental transcript reconciliation targets directly on `agent_instruction` payload:

- `supplementalTargets[]`
  - `messageId`
  - `type`
  - optional `placeholderTexts[]` (case-insensitive placeholder content values)
  - optional `completeFallback`
  - optional `errorFallback`
  - optional `canceledFallback`

Contract:

- API core keeps `agent_instruction` generic and does not hard-code workflow-specific transcript types.
- On terminal job states, core reconciles these declared targets to explicit terminal transcript entries when rows are missing or still placeholder content.

## Queue lifecycle websocket events

Event names:

- `orchestrator_job_queued`
- `orchestrator_job_started`
- `orchestrator_job_progress`
- `orchestrator_job_completed`
- `orchestrator_job_failed`
- `orchestrator_job_canceled`

Envelope fields:

- `type` (one of above)
- `threadId` (source session id when present)
- `payload`
  - `jobId`
  - `projectId`
  - `jobType`
  - `state`
  - optional `sourceSessionId`
  - optional `result`
  - optional `error`
  - optional `progress`

Routing contract:

- queue events use `threadId = sourceSessionId` when session-scoped
- UI should treat websocket events as primary and polling/reload as reconcile fallback

## Transcript delta websocket event

Event name:

- `transcript_updated`

Envelope:

- `type: "transcript_updated"`
- `threadId`
- `payload`
  - `threadId`
  - optional `turnId`
  - optional `messageId`
  - optional `type`
  - optional `entry`

`entry` fields:

- `messageId`
- `turnId`
- `role`: `user | assistant | system`
- `type`
- `content`
- `status`: `streaming | complete | canceled | error`
- optional `details`
- optional `startedAt`
- optional `completedAt`

Client contract:

- apply transcript deltas directly for low-latency UI updates
- keep a bounded REST reconcile fallback for missed websocket events

## Transcript upsert REST endpoint

Route:

- `POST /api/sessions/:sessionId/transcript/upsert`

Behavior:

- validates request body
- upserts one supplemental transcript entry by `messageId`
- emits `transcript_updated` websocket event
- returns:
  - `status: "ok"`
  - `sessionId`
  - `entry`

Error behavior:

- `410` for purged session
- `404` when target session does not exist
- `400` for invalid body

## Queue REST inspection endpoints

Single job:

- `GET /api/orchestrator/jobs/:jobId`

Project listing:

- `GET /api/projects/:projectId/orchestrator/jobs`
- optional query: `state`

Cancel:

- `POST /api/orchestrator/jobs/:jobId/cancel`

Queue unavailable behavior:

- endpoints return `503` with `code: "job_conflict"`

## System-owned session safety contract

System-owned worker sessions:

- are filtered from session lists
- reject user chat operations with `403 system_session`
- auto-decline/cancel server requests (approvals/tool-input) for those sessions

## Related references

- `docs/architecture.md`
- `docs/implementation-status.md`
- `docs/operations/agent-queue-framework.md`
