# Operations: Agent Queue Framework

## Purpose

This document defines the queue framework and agent-driven orchestration model used by this repository.

It answers:

- What the queue guarantees.
- How agent extensions subscribe to runtime events.
- How queued jobs run on system-owned worker chats.
- How supervisor workflows write transcript insight and optional auto-actions.

This is an implementation contract for current behavior.

## Core Model

The API core runs a generic queue and generic agent runtime. Workflow logic lives in agent extensions under `agents/*`.

Core responsibilities:

- load `agents/*/events.(ts|js|mjs)` modules at startup
- emit named runtime events to registered handlers
- allow handlers to enqueue queue jobs
- run queue jobs with retries, cancelation, and terminal reconciliation
- stream queue lifecycle events over websocket
- maintain system-owned worker sessions per project + agent

Agent extension responsibilities:

- subscribe to runtime events
- build human-readable instruction text for worker jobs
- choose dedupe semantics through queue payload keys
- write workflow outputs through API endpoints (for example transcript upsert, approval decision, steer)

## Invariants

- Foreground user turn streaming is never blocked by background queue workflows.
- Every queue job reaches an explicit terminal state: `completed`, `failed`, or `canceled`.
- Queue recovery never silently drops persisted work due to schema/type mismatch.
- Duplicate user actions are deduped when the queue contract requires single-flight behavior.
- Worker chats are system-owned infrastructure and are not user-operable chat sessions.
- Transcript rows are updated idempotently via stable `messageId` keys.

## Queue Runtime

Primary files:

- `apps/api/src/orchestrator-queue.ts`
- `apps/api/src/orchestrator-types.ts`
- `apps/api/src/orchestrator-processors.ts`
- `apps/api/src/index.ts`

Queue supports:

- typed job definitions with payload/result schemas
- per-job dedupe mode (`single_flight`, `drop_duplicate`, `merge_duplicate`, `none`)
- retry classification (`retryable` vs `fatal`)
- retry delay controls, including custom `delayForAttempt(attempt)`
- queue/job capacity limits and fairness controls
- terminal history retention and persisted snapshot recovery

Configured retry behavior for agent-driven jobs:

- immediate-first linear retry delay (`0ms`, then `+60ms` per attempt)
- retryable classification includes transient thread/session materialization failures

## Agent Runtime Event Bus

Primary files:

- `apps/api/src/agent-events-runtime.ts`
- `agents/runtime/events.ts`

Module loading contract:

- API scans `agents/*` directories.
- Directories named `runtime`, `lib`, or dot-prefixed are ignored for event module loading.
- A module is loaded when one of these files exists:
  - `events.ts`
  - `events.js`
  - `events.mjs`
- Module must export `registerAgentEvents(registry)` (directly or via default export).

Event handler tool contract:

- `enqueueJob(input)` queues work through orchestrator queue
- `logger` exposes structured log methods

## Worker Session Model

Worker sessions are owner-scoped and agent-scoped:

- mapping key: `${ownerId}::${agent}`
- `ownerId` is either:
  - real `projectId`
  - `session:<sessionId>` for unassigned-chat queue workflows
- persisted in metadata `projectAgentSessionByKey`
- hidden from session lists
- user chat operations on these sessions are rejected (`403 system_session`)

Worker session lifecycle:

- created lazily on first queued job for `(ownerId, agent)`
- `thread/start` uses project working directory when configured, else workspace root
- optional one-time orientation turn from `agents/<agent>/orientation.md`
- turn policy comes from `agents/<agent>/agent.config.json` when present
- stale mapped worker session is recovered once by clearing mapping and reprovisioning

## Runtime Events Used by Supervisor

Primary file:

- `agents/supervisor/events.ts`

Subscribed events:

- `file_change.approval_requested`
- `turn.completed`
- `suggest_request.requested`

### Event: `file_change.approval_requested`

Payload contract:

- `context`
  - `projectId`
  - `sourceSessionId`
  - `threadId`
  - `turnId`
  - optional: `itemId`, `approvalId`, `anchorItemId`, `userRequest`, `turnTranscript`
- `summary` (string)
- `details` (string; may be structured JSON text)
- `sourceEvent`: `approval_request | approvals_reconcile`
- `fileChangeStatus`: `pending_approval`
- optional `autoActions`
  - `approve`: `{ enabled, threshold }`
  - `reject`: `{ enabled, threshold }`
  - `steer`: `{ enabled, threshold }`
  - thresholds use `none | low | med | high`

Handler behavior:

- builds one `file_change_supervisor_review` instruction
- enqueues one `agent_instruction` job
- dedupe key:
  - `file_change_supervisor_review:${threadId}:${turnId}:${itemId ?? approvalId ?? "na"}`

### Event: `turn.completed`

Payload contract:

- `context`
  - `projectId`
  - `sourceSessionId`
  - `threadId`
  - `turnId`
  - optional `userRequest`
- `hadFileChangeRequests` (boolean)
- `turnTranscriptSnapshot` (string)
- optional `fileChangeRequestCount` (number)
- optional `insights[]` (extension-defined summary input)
  - `itemId`, `change`, `impact`, `riskLevel`, `riskReason`

Handler behavior:

- returns without enqueue when `hadFileChangeRequests` is `false`
- otherwise builds one `turn_supervisor_review` instruction
- enqueues one `agent_instruction` job
- dedupe key:
  - `turn_supervisor_review:${threadId}:${turnId}`

### Event: `suggest_request.requested`

Payload contract:

- `requestKey`
- `sessionId`
- `projectId`
- `threadId`
- `turnId`
- `userRequest`
- `turnTranscript`
- optional `model`
- optional `effort`
- optional `draft`

Handler behavior:

- builds one `suggest_request` instruction
- enqueues one `suggest_request` queue job

## Queue Job Types

### Job: `suggest_request`

Payload schema:

- `requestKey`
- `sessionId`
- `projectId`
- `agent`
- `sourceThreadId`
- `sourceTurnId`
- `instructionText`
- optional `model`
- optional `effort`
- optional `draft`

Dedupe:

- single-flight key: `${projectId}:${sessionId}:suggest_request`

Result schema:

- `suggestion`
- `requestKey`

Execution:

- runs one agent instruction turn with `expectResponse: assistant_text`
- returns assistant text when present
- uses deterministic fallback suggestion when assistant text is empty

### Job: `agent_instruction`

Payload schema:

- `agent`
- `jobKind`
- `projectId`
- `sourceSessionId`
- `threadId`
- `turnId`
- optional `itemId`
- optional `approvalId`
- optional `anchorItemId`
- `instructionText`
- optional `dedupeKey`
- optional `expectResponse`: `none | assistant_text`

Dedupe:

- single-flight key:
  - explicit payload `dedupeKey` when provided
  - otherwise `${projectId}:${threadId}:${turnId}:${jobKind}`

Result schema:

- `status: "ok"`
- optional `outputText`

Execution:

- resolves/creates project agent session
- runs orientation turn once per worker session when configured
- runs instruction turn
- streams assistant output snapshots into transcript row type `agent.jobOutput`
- reconciles expected supplemental entries for supervisor job kinds at terminal state

## Supervisor Instruction Contract

Supervisor instruction text is human-readable markdown and is the execution contract.

File-change instruction structure includes:

- routing context (project/session/thread/turn/item/approval ids)
- fenced user request block:

```user-request.md
...
```

- fenced turn transcript block:

```transcript.md
...
```

- diff details
- explicit deterministic auto-action rules
- explicit API actions in required order

Mandatory execution order for file-change supervision:

1. upsert explainability `streaming`
2. upsert explainability `complete`
3. upsert supervisor insight `streaming`
4. upsert supervisor insight `complete`
5. evaluate and execute eligible auto actions

Auto-action precedence:

- reject wins when both approve and reject conditions match
- user decisions are authoritative in races
- `404 not_found` on approval decision is reconciliation, not retryable failure

## Transcript Contracts

Public upsert endpoint:

- `POST /api/sessions/:sessionId/transcript/upsert`

Upsert body fields:

- `messageId`
- `turnId`
- `role`: `user | assistant | system`
- `type`
- `content`
- `status`: `streaming | complete | canceled | error`
- optional `details`
- optional `startedAt`
- optional `completedAt`

Supervisor message id conventions:

- explainability:
  - `file-change-explain::<threadId>::<turnId>::<anchorItemId>`
- supervisor insight:
  - `file-change-supervisor-insight::<threadId>::<turnId>::<anchorItemId>`
- turn review:
  - `turn-supervisor-review::<threadId>::<turnId>`
- queue output stream:
  - `agent-job-output::<jobId>`

Supervisor transcript types used by UI:

- `fileChange.explainability`
- `fileChange.supervisorInsight`
- `turn.supervisorReview`
- `agent.jobOutput`

Terminal reconciliation:

- queue terminal handlers fill missing/placeholder supervisor rows with deterministic fallback content
- supplemental transcript upsert protects terminal rows from stale `streaming` regression on same `messageId`

## Auto-Action Policy Defaults

Supervisor default policy is read in extension code (`agents/supervisor/events.ts`):

- auto-approve: enabled, threshold `high`
- auto-reject: disabled, threshold `high`
- auto-steer: enabled, threshold `med`

Environment overrides:

- `SUPERVISOR_AUTO_APPROVE_ENABLED`
- `SUPERVISOR_AUTO_APPROVE_THRESHOLD`
- `SUPERVISOR_AUTO_REJECT_ENABLED`
- `SUPERVISOR_AUTO_REJECT_THRESHOLD`
- `SUPERVISOR_AUTO_STEER_ENABLED`
- `SUPERVISOR_AUTO_STEER_THRESHOLD`

Threshold domain:

- `none | low | med | high`

## Timeouts, Retry, and Recovery

Agent turn timing controls:

- `ORCHESTRATOR_AGENT_TURN_TIMEOUT_MS`
- `ORCHESTRATOR_AGENT_POLL_INTERVAL_MS`
- `ORCHESTRATOR_AGENT_INCLUDE_TURNS_GRACE_MS`

Queue timing controls:

- `ORCHESTRATOR_QUEUE_DEFAULT_TIMEOUT_MS`
- `ORCHESTRATOR_QUEUE_MAX_ATTEMPTS`

Runtime behavior:

- worker turn completion is resolved from runtime notifications first
- `thread/read(includeTurns)` polling is fallback
- include-turns non-materialized windows are bounded by grace timer
- grace overflow throws retryable error instead of waiting full turn timeout

Recovery behavior:

- stale mapped worker session triggers one mapping reset + reprovision retry
- persisted unknown-type or invalid-payload jobs become explicit terminal failures on recovery

## Websocket and UI Coupling

Queue lifecycle websocket events:

- `orchestrator_job_queued`
- `orchestrator_job_started`
- `orchestrator_job_progress`
- `orchestrator_job_completed`
- `orchestrator_job_failed`
- `orchestrator_job_canceled`

Transcript websocket delta:

- `transcript_updated` carries full upserted entry payload
- active chat applies delta immediately
- REST transcript reload remains reconcile fallback

Approval bubble grouping behavior:

- file-change diff + explainability + supervisor insight + queue output are grouped by anchor item/approval metadata
- grouped rows render inline in the same thought bubble context

## Extending the Framework

To add a new workflow:

1. create/update an agent extension event handler under `agents/<agent>/events.ts`
2. subscribe to one or more runtime event names
3. construct deterministic markdown instruction text with full routing/context payload
4. enqueue `agent_instruction` or another registered queue job type
5. use transcript upsert and/or other API actions from worker instructions
6. define stable dedupe and transcript message id keys
7. add unit/contract coverage for dedupe, retry, and terminal reconciliation

Core API remains generic while extension code owns workflow semantics.
