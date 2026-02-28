# Operations: Agent Queue Event and Job Contracts

## Purpose

This is the payload contract deep dive for the queue framework.

Use it with `agent-queue-framework.md` when you need exact event/job shapes, dedupe keys, and transcript-message conventions.

## Runtime Events Used by Repository Supervisor

Repository supervisor extension (`agents/supervisor/events.js`) subscribes to:

- `file_change.approval_requested`
- `turn.completed`
- `suggest_request.requested`
- `app_server.item.started`

## `file_change.approval_requested`

Expected payload:

- `context`: `projectId`, `sourceSessionId`, `threadId`, `turnId`
- optional context fields: `itemId`, `approvalId`, `anchorItemId`, `userRequest`, `turnTranscript`
- `summary` (string)
- `details` (string)
- `sourceEvent`: `approval_request | approvals_reconcile`
- `fileChangeStatus`: `pending_approval`
- optional `autoActions` with thresholds (`none|low|med|high`)

Repository dedupe key:

- `file_change_supervisor_review:${threadId}:${turnId}:${itemId ?? approvalId ?? "na"}`

## `turn.completed`

Expected payload:

- `context`: `projectId`, `sourceSessionId`, `threadId`, `turnId`
- optional `context.userRequest`
- `hadFileChangeRequests` (boolean)
- `turnTranscriptSnapshot` (string)
- optional `fileChangeRequestCount`
- optional `insights[]`

Repository dedupe key:

- `turn_supervisor_review:${threadId}:${turnId}`

## `suggest_request.requested`

Expected payload:

- `requestKey`, `sessionId`, `projectId`, `threadId`, `turnId`
- `userRequest`
- `turnTranscript`
- optional `model`, `effort`, `draft`

Repository dedupe key:

- `suggest_request:<sourceSessionId>`

## `app_server.item.started`

Signal envelope includes:

- `source: "app_server"`
- `signalType: "notification"`
- `method: "item/started"`
- `context.threadId`, `context.turnId`
- `params.item`

Repository rename workflow uses this to enqueue one-time initial-title rename checks.

Repository dedupe key:

- `session_initial_rename:<sourceSessionId>`

## Job Contract: `agent_instruction`

Primary fields:

- `agent`, `jobKind`
- `projectId`, `sourceSessionId`, `threadId`, `turnId`
- optional `itemId`, `approvalId`, `anchorItemId`
- `instructionText`
- optional `dedupeKey`
- optional `bootstrapInstruction` (`key`, `instructionText`)
- optional `expectResponse`: `none | assistant_text | action_intents`

Default dedupe when `dedupeKey` missing:

- `${projectId}:${threadId}:${turnId}:${jobKind}`

Execution modes:

- `none`: side effects happen live during worker turn.
- `assistant_text`: assistant snapshots are upserted as `agent.jobOutput`.
- `action_intents`: structured intents parsed/executed server-side with scope/capability enforcement.

## Job Kind: `suggest_request` (inside `agent_instruction`)

Fields (via payload+instruction contract):

- `jobKind: suggest_request`
- routing ids (`projectId`, `sourceSessionId`, `threadId`, `turnId`)
- optional per-job `model`, `effort`, `fallbackSuggestionDraft`
- `completionSignal.kind: suggested_request`
- `completionSignal.requestKey`

Output path:

- worker upserts suggestion state through `POST /api/sessions/:sessionId/suggested-request/upsert`
- websocket emits `suggested_request_updated`

## Job Kind: `session_initial_rename` (inside `agent_instruction`)

Fields:

- `jobKind: session_initial_rename`
- routing ids (`projectId`, `sourceSessionId`, `threadId`, `turnId`)
- deterministic dedupe key per source session

Behavior:

- worker renames only when title is still exactly `New chat`.

## Transcript Upsert Contract

Endpoint:

- `POST /api/sessions/:sessionId/transcript/upsert`

Fields:

- `messageId`, `turnId`, `role`, `type`, `content`, `status`
- optional `details`, `startedAt`, `completedAt`

Repository supervisor message id conventions:

- `file-change-explain::<threadId>::<turnId>::<anchorItemId>`
- `file-change-supervisor-insight::<threadId>::<turnId>::<anchorItemId>`
- `turn-supervisor-review::<threadId>::<turnId>`
- `agent-job-output::<jobId>`

UI-relevant types:

- `fileChange.explainability`
- `fileChange.supervisorInsight`
- `turn.supervisorReview`
- `agent.jobOutput`

## File-Change Policy Settings Contract

Supervisor extension resolves per-session policy via settings tools and settings API (`GET/POST/DELETE /api/sessions/:sessionId/settings...`).

Default policy when unset:

- explainability enabled
- auto-approve disabled (`low`)
- auto-reject disabled (`high`)
- auto-steer disabled (`high`)

Threshold normalization:

- accepts `medium`, normalizes to `med`.

## Related docs

- Queue foundation and invariants: [`agent-queue-framework.md`](./agent-queue-framework.md)
- Runtime settlement/retry/recovery semantics: [`agent-queue-runtime-semantics.md`](./agent-queue-runtime-semantics.md)
- Extension authoring contract: [`agent-extension-authoring.md`](./agent-extension-authoring.md)
- Runtime event family definitions: [`../protocol/harness-runtime-events.md`](../protocol/harness-runtime-events.md)
