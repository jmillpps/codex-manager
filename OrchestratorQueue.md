# Orchestrator Queue

## Purpose

Define an implementation-ready plan for upgrading project orchestration into a robust, resilient, and extensible queued job framework.

Primary question this document answers:

- How do we process project-scoped orchestration work deterministically and safely, while making new job workflows easy to add?

Status:

- Implemented baseline (Phases 1-5 completed in repository code).
- Last updated: February 21, 2026.

---

## Product Decisions (Locked)

These decisions are now requirements.

1. `suggest_reply` is single-flight per source chat.
- If user clicks Suggest Reply repeatedly before completion, only one queued/running suggest job is allowed for that chat.
- Duplicate clicks during in-flight execution return the existing job identity; no second job is created.
- After completion/failure/cancel, user can click again and enqueue a new one.

2. Diff explainability has no SLA.
- `file_change_explain` is best-effort eventual background processing.
- No strict completion deadline is required for product behavior.

3. Project orchestrator sessions are system-owned and hidden.
- Users must not see or interact with orchestrator sessions as regular chats.
- Users must not be able to send/interrupt/rollback/archive/delete those sessions directly through normal chat UI/API paths.

4. Queued work must never be silently lost during deploy/schema changes.
- Recovery cannot drop jobs because of unknown type/version/schema drift.
- Any unrecoverable replay mismatch must be represented as explicit terminal job state with failure reason.

5. Every queue job must end in an explicit terminal state.
- Jobs must always resolve to one of: `completed`, `failed`, `canceled`.
- This is mandatory for observability, client reconciliation, and deterministic restart semantics.

---

## Scope

In scope:

- Queue-backed orchestration for Suggest Reply.
- Queue-backed explainability for completed `fileChange` events.
- Deterministic lifecycle/state/retry/cancellation semantics.
- Safe result routing to composer and transcript.
- Extensible job framework primitives so new workflows are straightforward to add.

Out of scope:

- Distributed queueing / multi-node workers.
- Helper-offload autoscaling.
- Advanced token compaction policies beyond practical caps.

---

## Current-State Summary (As-Is)

1. Project-level orchestrator session mapping exists (`projectOrchestratorSessionById`).
2. Suggested reply executes directly on request path (orchestrator first, helper fallback).
3. No persistent orchestrator job queue exists.
4. `item/completed` transcript ingest exists for all item types, including `fileChange`.
5. Supplemental transcript merge/upsert exists and supports synthetic rows.
6. WebSocket fanout supports typed envelopes and thread-scoped filters.

---

## Target-State Summary (To-Be)

1. Per-project serialized queue lane (`max concurrent running jobs per project = 1`).
2. Typed job registry with schemas, dedupe policy, retry policy, timeout/cancel policy, and side-effect sink.
3. `suggest_reply` becomes queued single-flight work per source chat.
4. Completed eligible `fileChange` items enqueue explainability jobs automatically.
5. Queue events are observable over WebSocket with explicit routing guarantees.
6. Explainability text appears in transcript as synthetic, anchored rows.
7. Job failure never breaks user turn streaming.
8. Hidden/system-owned orchestrator sessions cannot be used as user chats.

Core invariants:

- User chat turn latency cannot be blocked by background explain jobs.
- Queue behavior must be deterministic and testable.
- Side effects must be idempotent.
- Restart recovery must not create duplicate sink effects.

---

## Non-Negotiable Contracts

### 1) Orchestrator Session Isolation

Orchestrator sessions are worker infrastructure, not user conversations.

Required controls:

1. Mark orchestration sessions as `systemOwned: true` in persisted metadata.
2. Exclude system-owned sessions from session listing endpoints and project chat collections.
3. Reject user chat operations targeting system-owned sessions with `403 system_session`:
- send message
- interrupt
- rollback
- archive/unarchive
- rename via chat surfaces
- delete via normal chat path
4. Keep internal worker access allowed for queue processors.

### 2) WebSocket Routing Contract

All orchestrator job events must include explicit routing metadata.

Required fields:

- `jobId`
- `projectId`
- `jobType`
- `state`
- `sourceSessionId` when the job is session-driven
- `threadId` for socket routing when UI session-scoped delivery is expected

Routing rule:

- For Suggest Reply job events, `threadId` MUST be the source chat session id.
- For diff explainability lifecycle rows, transcript updates are authoritative; separate job events are optional but if sent must include source `threadId`.

No payload-only routing assumptions.

### 3) Idempotent Side-Effects

Every processor must define deterministic sink keys.

- `suggest_reply`: sink key = `sessionId + suggestRequestKey`.
- `file_change_explain`: sink key = `threadId + turnId + itemId`, transcript message id stable.

On retry/recovery, sink writes must upsert/replace by key, never append duplicates.

---

## Queue Framework Architecture

Create:

- `apps/api/src/orchestrator-queue.ts`
- `apps/api/src/orchestrator-processors.ts`
- `apps/api/src/orchestrator-job-definitions.ts`
- `apps/api/src/orchestrator-store.ts`

### JobDefinition Registry (Extensibility Core)

Every job type must be declared through one typed definition object.

```ts
type JobPriority = "interactive" | "background";
type JobState = "queued" | "running" | "completed" | "failed" | "canceled";

type JobDefinition<TPayload, TResult> = {
  type: string;
  version: number;
  priority: JobPriority;
  payloadSchema: z.ZodType<TPayload>;
  resultSchema: z.ZodType<TResult>;
  dedupe: {
    key: (payload: TPayload) => string | null;
    mode: "single_flight" | "drop_duplicate" | "merge_duplicate" | "none";
    merge?: (existing: TPayload, incoming: TPayload) => TPayload;
  };
  retry: {
    maxAttempts: number;
    classify: (error: unknown) => "retryable" | "fatal";
    baseDelayMs: number;
    maxDelayMs: number;
    jitter: boolean;
  };
  timeoutMs: number | null;
  cancel: {
    strategy: "interrupt_turn" | "mark_canceled";
    gracefulWaitMs: number;
  };
  run: (ctx: JobRunContext, payload: TPayload) => Promise<TResult>;
  onQueued?: (ctx: JobRunContext, payload: TPayload, jobId: string) => Promise<void>;
  onStarted?: (ctx: JobRunContext, payload: TPayload, jobId: string) => Promise<void>;
  onCompleted?: (ctx: JobRunContext, payload: TPayload, result: TResult, jobId: string) => Promise<void>;
  onFailed?: (ctx: JobRunContext, payload: TPayload, error: string, jobId: string) => Promise<void>;
  onCanceled?: (ctx: JobRunContext, payload: TPayload, jobId: string) => Promise<void>;
};
```

New workflow integration requirement:

1. Add schema + JobDefinition.
2. Register in definitions map.
3. Add tests for dedupe/retry/sink behavior.
4. Optionally expose API trigger endpoint.

No ad-hoc processor paths outside registry.

### Queue Manager

Responsibilities:

- Per-project lane scheduler.
- State transitions and persistence.
- Dedupe/coalescing enforcement.
- Retry/backoff execution.
- Cancellation and interruption.
- Event publishing.

Required API:

- `enqueue(input)`
- `get(jobId)`
- `cancel(jobId)`
- `listByProject(projectId)`
- `start()`
- `stop({ drainMs })`

### Scheduling and Fairness

Base ordering:

- Higher priority first.
- FIFO inside same priority.

Starvation guard (required):

- If background jobs are waiting beyond `BACKGROUND_AGING_MS`, scheduler must run one aged background job after at most `MAX_INTERACTIVE_BURST` consecutive interactive jobs for that project.

Suggested defaults:

- `MAX_INTERACTIVE_BURST=3`
- `BACKGROUND_AGING_MS=15000`

---

## Job Types (v1)

## `suggest_reply`

Purpose:

- Populate source chat composer with one suggested reply.

Dedupe mode:

- `single_flight` keyed by `projectId:sourceSessionId:suggest_reply`.

Behavior:

1. If queued/running job with same dedupe key exists, return that existing job (`status: already_queued`).
2. Run on hidden project orchestrator session.
3. No helper fallback in queue mode unless explicitly enabled by feature flag.
4. Result sink publishes completion event routed to source session thread.
5. UI applies suggestion only if request guards still match (session/draft/request id).

## `file_change_explain`

Purpose:

- Produce explainability for completed file changes.

Dedupe mode:

- `drop_duplicate` keyed by `projectId:threadId:turnId:itemId`.

Eligibility filter (required):

- Notification is `item/completed`.
- Item `type === fileChange`.
- Source thread belongs to a project.
- Source thread is not system-owned helper/orchestrator thread.
- Item indicates completed/successful change payload and has non-empty diff/file-change content.
- Diff size within cap, otherwise truncate and mark truncated in output metadata.

SLA:

- Best-effort eventual; no hard product SLA.

Sink:

- Upsert synthetic transcript row by stable message id.

---

## Data Model

```ts
type OrchestratorJob = {
  id: string;
  type: string;
  version: number;
  projectId: string;
  sourceSessionId: string | null;
  priority: "interactive" | "background";
  state: "queued" | "running" | "completed" | "failed" | "canceled";
  dedupeKey: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelRequestedAt: string | null;
  runningContext: {
    threadId: string | null;
    turnId: string | null;
  };
};
```

Store file:

- `.data/orchestrator-jobs.json`

Persistence requirements:

1. Atomic write: write temp file, fsync, rename.
2. Schema version with migrations.
3. Corruption handling: quarantine invalid file and start with empty queue.
4. Retention cap: keep bounded terminal history per project.

Recovery requirements:

1. On startup, jobs in `running` become `queued` with incremented attempts.
2. If attempts exceeds max, transition to `failed` with recovery reason.
3. Replayed jobs must preserve idempotent sink behavior.

---

## APIs

### Suggest Reply Endpoints

New async endpoint:

- `POST /api/sessions/:sessionId/suggested-reply/jobs`
- Returns `202`:

```json
{
  "status": "queued",
  "jobId": "...",
  "sessionId": "...",
  "projectId": "...",
  "dedupe": "enqueued|already_queued"
}
```

Legacy compatibility endpoint:

- `POST /api/sessions/:sessionId/suggested-reply`

Required behavior:

1. Internally enqueue same single-flight job.
2. Wait up to `SUGGEST_REPLY_WAIT_MS` for completion.
3. If completed in time: return current shape with `suggestion`.
4. If not completed in time: return `202 { status: "queued", jobId, ... }` (no duplicate enqueue).

### Job Inspection

- `GET /api/orchestrator/jobs/:jobId`
- `GET /api/projects/:projectId/orchestrator/jobs?state=...` (optional but recommended)
- `POST /api/orchestrator/jobs/:jobId/cancel`

### Error Contract

Queue-full and invalid-state errors must be explicit:

- `429 queue_full`
- `409 job_conflict`
- `403 system_session`

---

## WebSocket Events

Add envelope `type` values:

- `orchestrator_job_queued`
- `orchestrator_job_started`
- `orchestrator_job_progress`
- `orchestrator_job_completed`
- `orchestrator_job_failed`
- `orchestrator_job_canceled`

Payload contract:

```ts
{
  jobId: string;
  projectId: string;
  jobType: string;
  state: string;
  sourceSessionId?: string;
  result?: Record<string, unknown>;
  error?: string;
}
```

Routing contract:

- Set envelope `threadId` when session-scoped client delivery is required.
- For Suggest Reply, `threadId = sourceSessionId` is mandatory.

---

## Transcript Integration (Explainability)

### Identity and Anchoring

For each explained diff item:

- `messageId = file-change-explain-${threadId}-${turnId}-${itemId}`
- `turnId = source turn`
- `role = system`
- `type = fileChange.explainability`
- `details` includes `anchorItemId=itemId`

### Lifecycle

1. On queued/start, upsert placeholder row with `status=streaming`.
2. On completion, upsert same row with final explainability and `status=complete`.
3. On failure/cancel, upsert same row with concise error/cancel summary.

### Merge/Placement Rule

Current merge inserts supplemental rows before assistant output.

Required enhancement:

- If `anchorItemId` exists and anchored item exists in same turn, insert explainability row immediately after anchored fileChange row.
- Fallback to current insertion behavior if anchor target is unavailable.

### Renderer Rule

UI thought renderer must special-case `fileChange.explainability` and render markdown-focused explainability block.

---

## Suggest Reply UI Flow

1. On click, call queued endpoint.
2. Store `pendingSuggestReplyJobId` and request guard snapshot (`sessionId`, `draftAtStart`, `requestId`).
3. While pending, disable button or show in-progress state.
4. On completion event for matching job id, apply suggestion only if guard checks pass.
5. On duplicate click while pending, do not create another job.

---

## Cancellation and Timeouts

### Cancellation

Required behavior:

1. Cancel queued job immediately => `canceled`.
2. Cancel running job:
- if running context has `threadId` + `turnId`, call interrupt.
- wait graceful window.
- if still active, mark `canceled` with `interrupt_timeout` reason.

### Timeouts

Processor timeout controls runtime, not product SLA.

- `suggest_reply` has bounded runtime timeout.
- `file_change_explain` can be longer and retried; still best-effort eventual.

A timed-out attempt is retryable if policy marks it transient.

---

## Retry and Backpressure

Retry policy:

- Exponential backoff with jitter.
- Retry only transient classes.
- Fatal validation/payload errors fail immediately.

Backpressure:

- Per-project queue depth cap.
- Global queued jobs cap.
- Structured rejection with retry hint metadata.

---

## Observability

Required metrics:

- queue depth (global + per project)
- enqueue count by type
- dedupe hit count by type
- run latency by type
- attempts/retries by type
- failure count by type + reason
- cancel count by type
- aged background wait time

Required logs:

- state transition logs with `jobId`, `projectId`, `type`, `attempt`, `reason`.

---

## Configuration (env)

Add to `apps/api/src/env.ts`:

- `ORCHESTRATOR_QUEUE_ENABLED` default `true`
- `ORCHESTRATOR_QUEUE_GLOBAL_CONCURRENCY` default `2`
- `ORCHESTRATOR_QUEUE_MAX_PER_PROJECT` default `100`
- `ORCHESTRATOR_QUEUE_MAX_GLOBAL` default `500`
- `ORCHESTRATOR_QUEUE_MAX_ATTEMPTS` default `2`
- `ORCHESTRATOR_QUEUE_DEFAULT_TIMEOUT_MS` default `60000`
- `ORCHESTRATOR_QUEUE_BACKGROUND_AGING_MS` default `15000`
- `ORCHESTRATOR_QUEUE_MAX_INTERACTIVE_BURST` default `3`
- `ORCHESTRATOR_SUGGEST_REPLY_ENABLED` default `true`
- `ORCHESTRATOR_SUGGEST_REPLY_WAIT_MS` default `12000`
- `ORCHESTRATOR_DIFF_EXPLAIN_ENABLED` default `true`
- `ORCHESTRATOR_DIFF_EXPLAIN_MAX_DIFF_CHARS` default `50000`

---

## Implementation Plan

Phase completion status (current repository implementation):

- Phase 1: completed
- Phase 2: completed
- Phase 3: completed
- Phase 4: completed
- Phase 5: completed

### Phase 1: Framework Core

1. Implement `JobDefinition` registry and queue manager.
2. Implement persistent job store with atomic write and recovery migration.
3. Implement state machine, retry, cancellation, fairness scheduler.
4. Add websocket publisher helpers with strict routing contract.
5. Add unit tests for dedupe/fairness/cancel/recovery.

### Phase 2: System-Owned Session Isolation

1. Add metadata field for `systemOwnedSessionIds`.
2. Hide orchestrator sessions from list and UI models.
3. Block user operations on system sessions with explicit `403` errors.
4. Add tests for visibility and operation denial.

### Phase 3: Suggest Reply Queue Integration

1. Add async suggest endpoint and legacy wrapper behavior.
2. Implement `suggest_reply` JobDefinition with single-flight dedupe.
3. Add UI pending job tracking and completion guard logic.
4. Confirm duplicate clicks do not enqueue second job.
5. Add contract tests for `already_queued` and completion application semantics.

### Phase 4: File Change Explainability Integration

1. Add `item/completed fileChange` eligibility filters and enqueue hook.
2. Implement `file_change_explain` JobDefinition.
3. Add anchored transcript synthetic row upsert lifecycle.
4. Add merge enhancement for anchored placement.
5. Add UI renderer for `fileChange.explainability`.
6. Add integration tests for live and reload transcript behavior.

### Phase 5: Operational Hardening

1. Add metrics/logs and troubleshooting hooks.
2. Add startup/shutdown/drain tests.
3. Add queue-full and degraded-mode behavior tests.

---

## Testing Matrix (Required)

1. Scheduler
- per-project serialization
- fairness/aging starvation prevention

2. Dedupe
- suggest single-flight duplicates return existing job
- file explain duplicates drop/merge as configured

3. Cancellation
- queued cancel
- running cancel with interrupt path
- running cancel fallback on interrupt timeout

4. Recovery
- restart requeues previous running jobs
- sink idempotency after recovery replay

5. WebSocket routing
- suggest completion reaches selected session-scoped client
- no cross-session leakage

6. Session isolation
- system-owned session hidden in list
- user operation denial on system-owned session

7. Explainability transcript
- placeholder -> complete lifecycle
- anchored placement after fileChange item
- survives transcript reload without duplication

---

## Risk Register and Mitigations

1. Orchestrator/user contention.
- Mitigation: system-owned isolation and operation deny-list.

2. Background starvation.
- Mitigation: aging + interactive burst limits.

3. Stuck running job blocks project lane.
- Mitigation: interrupt-aware cancellation and watchdog timeout.

4. Duplicate sink writes on retry/restart.
- Mitigation: deterministic sink keys and upsert-only writes.

5. Event delivery misses due to thread filter.
- Mitigation: explicit websocket routing contract using `threadId`.

6. Queue overload from explainability.
- Mitigation: eligibility filter, caps, best-effort eventual semantics.

---

## Acceptance Criteria

1. Suggest Reply is queue-backed and single-flight per source chat.
2. Duplicate Suggest Reply clicks during in-flight processing do not enqueue duplicates.
3. Completed Suggest Reply updates composer only when guard snapshot still matches.
4. Completed eligible file changes enqueue explainability jobs automatically.
5. Explainability rows appear in thought stream live and after reload.
6. Background explain jobs are not starved indefinitely under interactive load.
7. Per-project concurrency never exceeds one running job.
8. Running job cancellation can interrupt active turn and free queue lane.
9. Queue survives restart and avoids duplicate sink effects.
10. System-owned orchestrator sessions are hidden and non-interactable via user chat flows.
11. No regression to approvals/tool-input/turn streaming/session listing.

---

## Coverage Checklist (from review findings)

- WebSocket routing contract hardened.
- Fairness and starvation guard added.
- Running-cancel semantics upgraded with interrupt.
- Orchestrator session isolation made mandatory.
- Transcript adjacency explicitly anchored.
- Legacy endpoint timeout/compat behavior defined.
- Recovery/idempotency requirements explicit.
- Extensibility via typed JobDefinition registry defined.
- FileChange enqueue eligibility tightened.
- Store durability and corruption handling defined.

---

## Post-Review Remediation (Completed)

The following four issues were identified during implementation review and are now resolved in code.

### 1) Queue shutdown/cancel could hang on non-cooperative workers

Issue:

- Queue `stop()` awaited running promises without a hard upper bound.
- Jobs that ignored `AbortSignal` could keep the lane wedged during shutdown.

Resolution:

1. Added bounded shutdown settle window after cancel requests.
2. Added forced terminal transition for lingering running jobs (`shutdown_timeout`) when workers do not cooperate.
3. Added warning logs for forced shutdown cancellation events.
4. Added unit test coverage for non-cooperative worker shutdown behavior.

Resulting contract:

- `stop({ drainMs })` is now bounded and does not hang indefinitely on wedged job runners.

### 2) `suggest_reply` cancel strategy could not interrupt active turn

Issue:

- `suggest_reply` used `interrupt_turn` but did not set queue `runningContext` (`threadId`/`turnId`), so interrupt could not be routed.

Resolution:

1. `suggest_reply` run path now reports active `threadId`/`turnId` via `ctx.setRunningContext(...)` once `turn/start` returns.
2. Suggest worker now runs with `ctx.signal` propagation for cooperative cancel/timeout handling.

Resulting contract:

- Running `suggest_reply` cancel requests can route turn interrupts to the correct active turn context.

### 3) File-change explainability could enqueue from system-owned sessions

Issue:

- Enqueue filter did not explicitly reject system-owned source sessions.

Resolution:

1. Added system-owned session guard to explainability payload eligibility.
2. System-owned source threads are now ignored for `file_change_explain` enqueue.

Resulting contract:

- Explainability enqueue is restricted to eligible user-session file-change completions only.

### 4) Web suggest-reply could remain stuck pending if websocket terminal event was missed

Issue:

- Pending suggest state was websocket-terminal-event dependent with no reconcile fallback.

Resolution:

1. Added client-side reconcile polling for pending suggest jobs using `GET /api/orchestrator/jobs/:jobId`.
2. Poller clears pending state on terminal job states and applies suggestion with existing guard checks.
3. Poller retries transient lookup failures and self-cancels once job is terminal/cleared.

Resulting contract:

- Suggest-reply pending state is self-healing when websocket delivery misses terminal job events.

---

## Deep Review Remediation (Completed)

This section tracks the second deep audit pass across all phases. All findings below are resolved in code.

### 1) Invalid payload jobs could be re-picked forever

Issue:

- Queue execution parsed payload before guarded state transitions.
- Parse failures could leave jobs queued and repeatedly re-selected.

Resolution:

1. Added explicit invalid-payload handling in run path.
2. Invalid payload now transitions job to `failed` terminal state with explicit reason.
3. Added unit coverage asserting invalid queued payloads fail terminal instead of spinning.

Resulting contract:

- Invalid payloads cannot wedge queue lanes via endless re-pick loops.

### 2) Recovery could silently drop unknown job types or schema-invalid payloads

Issue:

- Snapshot recovery previously skipped unknown type jobs and parse-invalid jobs.
- This violated non-loss semantics and removed observability/reconciliation traceability.

Resolution:

1. Recovery now preserves unknown-type jobs as terminal `failed` rows with `recovery_unknown_job_type:*` errors.
2. Recovery now preserves schema-invalid payload jobs as terminal `failed` rows with `recovery_invalid_payload:*` errors.
3. Added unit tests for both recovery paths.

Resulting contract:

- Deploy/schema drift cannot silently discard queued work.

### 3) Transcript loader could remain stuck in loading state after deletion race

Issue:

- `loadSessionTranscript` could early-return on deleted-session handling while final loading reset depended on selected-session identity match.

Resolution:

1. Transcript loader now clears `loadingTranscript` based on request id ownership rather than active-session match.
2. Deleted-session transcript branch now also clears message timing state.

Resulting contract:

- Deleted-session races cannot leave transcript loading spinner stuck indefinitely.

### 4) System-owned suggest endpoints lacked explicit contract coverage

Issue:

- Existing API guards were implemented but not asserted for both suggest endpoints in contract tests.

Resolution:

1. Added contract assertions that system-owned sessions receive `403 system_session` for:
- `POST /api/sessions/:sessionId/suggested-reply/jobs`
- `POST /api/sessions/:sessionId/suggested-reply`

Resulting contract:

- Suggest queue APIs retain system-session isolation guarantees with regression protection.

### 5) Explainability workflow lacked deterministic contract coverage

Issue:

- File-change explainability lifecycle and anchored transcript synthesis were not covered by the contract suite.

Resolution:

1. Added contract harness helpers to inject queued orchestrator jobs via persisted queue snapshot.
2. Added end-to-end contract flow that replays a queued `file_change_explain` job, waits for terminal job state, and verifies:
- synthetic explainability transcript entry exists
- `type === fileChange.explainability`
- `details` preserves `anchorItemId`
3. Added cleanup/unassignment checks to keep project lifecycle assertions deterministic.

Resulting contract:

- Explainability job processing and transcript sink behavior are now regression-tested end-to-end.

### 6) Retry/backoff behavior was untested

Issue:

- Retryable classification and delayed re-attempt semantics were implemented without direct tests.

Resolution:

1. Added queue unit test that forces retryable first failure then success.
2. Test asserts delayed second attempt (backoff honored), attempt count increment, and final terminal completion.

Resulting contract:

- Retry scheduling/backoff behavior has direct regression coverage.

### 7) Explainability surfaced raw orchestrator transport failures to end users

Issue:

- `file_change_explain` jobs could fail with raw RPC errors (for example stale orchestrator session `thread not found`) and write those low-level failures directly into chat transcript explainability rows.

Resolution:

1. Explainability worker now attempts orchestration-session recovery when session mapping is missing/stale.
2. If recovery still fails (and job is not canceled), worker returns synthesized fallback explainability instead of failing terminal.
3. Contract tests now assert explainability transcript content is usable text and not raw `Explainability failed:` transport errors.

Resulting contract:

- Diff explainability remains best-effort and user-readable even when orchestration infrastructure is transiently stale.

### 8) Pending approval cards lacked inline explainability context

Issue:

- Explainability jobs were only enqueued on `item/completed` for `fileChange`.
- Users reviewing pending file-change approvals saw raw diffs but no explainability inside the approval card.

Resolution:

1. Enqueue `file_change_explain` when `item/fileChange/requestApproval` arrives (same dedupe key shape as completion path).
2. Keep completion-path enqueue so already-approved/completed-only paths still get explainability.
3. Reconcile existing pending approvals by enqueueing on approvals fetch (`GET /sessions/:sessionId/approvals`) so already-open approval cards receive explainability without waiting for a new approval event.
4. Render anchored `fileChange.explainability` content inline inside pending file-change approval cards and suppress duplicate standalone row while approval is active.
5. Handle sparse approval payloads by deriving/falling back missing `turnId`/`itemId`, hydrating missing `changes` from matching supplemental `fileChange` transcript details, and include `approvalId` metadata in explainability transcript details for reliable approval-card linkage.
6. Approval-card fallback copy must not claim queued state unless queue lifecycle evidence exists; default to neutral pending wording when no explainability lifecycle row is linked yet.

Resulting contract:

- Approval-time file-change review surfaces explainability directly where approve/deny decisions are made.

### 9) Explainability depth exceeded desired UX scope

Issue:

- Explainability output included deeper sections (why/risk/follow-up) when users only wanted concise change descriptions.

Resolution:

1. Narrowed explainability prompt contract to `What changed` only.
2. Explicitly disallowed rationale/risk/recommendation content in generated explainability.
3. Updated fallback explainability renderer to emit change-focused bullets only.

Resulting contract:

- Diff explainability is now strictly a concise description of what changed.

---

## Supervisor Pipeline Contract (Build-Ready)

Purpose:

- Define an implementation contract for continuous supervisor analysis across diff-time and turn-finalization time with three concrete UI components:
- `fileChange.supervisorInsight`
- `riskRecheck.batch`
- `turn.supervisorReview`

### 1) Job Types (Exact)

#### 1.1 `file_change_supervisor_insight` (new)

Intent:

- Analyze one file-change event and return exactly 4 concise fields (`change`, `impact`, `risk`, `check`).

Queue config:

- `type`: `file_change_supervisor_insight`
- `version`: `1`
- `priority`: `interactive` for approval-time events; `background` for completed-only events (implement via two definitions or payload-routed priority helper).
- `dedupe.mode`: `drop_duplicate`
- `dedupe.key`: `${projectId}:${threadId}:${turnId}:${itemId}:supervisor_insight:v1`
- `retry.classify`: timeout/transient = retryable; schema/prompt/output contract violations = fatal.
- `timeoutMs`: `90_000`
- `cancel.strategy`: `interrupt_turn`

Payload schema:

```json
{
  "threadId": "string",
  "turnId": "string",
  "itemId": "string",
  "projectId": "string",
  "sourceSessionId": "string",
  "sourceEvent": "approval_request | approvals_reconcile | item_completed",
  "fileChangeStatus": "pending_approval | completed",
  "approvalId": "string (optional)",
  "summary": "string",
  "details": "string (serialized normalized diff payload)",
  "anchorItemId": "string"
}
```

Result schema:

```json
{
  "messageId": "string",
  "anchorItemId": "string",
  "approvalId": "string (optional)",
  "insight": {
    "change": "string",
    "impact": "string",
    "risk": {
      "level": "none | low | med | high",
      "reason": "string"
    },
    "check": {
      "instruction": "string",
      "expected": "string"
    },
    "confidence": "low | med | high"
  }
}
```

Output contract:

1. Exactly 4 semantic fields only: `change`, `impact`, `risk`, `check`.
2. `check.instruction` is designed for verbatim execution later.
3. No essay output; all strings short and concrete.
4. `risk.level = none` means no recheck candidate is created.

---

#### 1.2 `risk_recheck_batch` (new)

Intent:

- At turn completion, execute all verbatim check instructions from applied diffs where `risk.level != none`.

Queue config:

- `type`: `risk_recheck_batch`
- `version`: `1`
- `priority`: `background`
- `dedupe.mode`: `single_flight`
- `dedupe.key`: `${projectId}:${threadId}:${turnId}:risk_recheck_batch:v1`
- `retry.classify`: infrastructure timeout/transient = retryable; malformed candidate payload = fatal.
- `timeoutMs`: `300_000`
- `cancel.strategy`: `interrupt_turn`

Payload schema:

```json
{
  "threadId": "string",
  "turnId": "string",
  "projectId": "string",
  "sourceSessionId": "string",
  "checks": [
    {
      "itemId": "string",
      "approvalId": "string (optional)",
      "riskLevel": "low | med | high",
      "riskReason": "string",
      "instruction": "string",
      "expected": "string"
    }
  ],
  "execution": {
    "maxConcurrency": "number (default 3)",
    "perCheckTimeoutMs": "number (default 120000)"
  }
}
```

Result schema:

```json
{
  "messageId": "string",
  "turnId": "string",
  "summary": {
    "total": "number",
    "passed": "number",
    "failed": "number",
    "error": "number",
    "timeout": "number",
    "skipped": "number"
  },
  "checks": [
    {
      "itemId": "string",
      "riskLevel": "low | med | high",
      "instruction": "string",
      "expected": "string",
      "status": "passed | failed | error | timeout | skipped",
      "evidence": "string",
      "durationMs": "number"
    }
  ]
}
```

Execution safety contract:

1. Execute `instruction` verbatim in read-only sandbox with restricted network.
2. Reject execution as `skipped` if instruction violates command safety policy.
3. Enforce per-check timeout and capture explicit status.
4. Batch always ends terminal (`completed`, `failed`, or `canceled`), never stuck.

---

#### 1.3 `turn_supervisor_review` (new)

Intent:

- Produce one whole-turn supervisor review after diff insights (and risk rechecks when present) have settled.

Queue config:

- `type`: `turn_supervisor_review`
- `version`: `1`
- `priority`: `background`
- `dedupe.mode`: `single_flight`
- `dedupe.key`: `${projectId}:${threadId}:${turnId}:turn_supervisor_review:v1`
- `retry.classify`: timeout/transient = retryable; invalid input snapshot = fatal.
- `timeoutMs`: `120_000`
- `cancel.strategy`: `interrupt_turn`

Payload schema:

```json
{
  "threadId": "string",
  "turnId": "string",
  "projectId": "string",
  "sourceSessionId": "string",
  "insights": [
    {
      "itemId": "string",
      "change": "string",
      "impact": "string",
      "riskLevel": "none | low | med | high",
      "riskReason": "string"
    }
  ],
  "riskBatch": {
    "summary": {
      "total": "number",
      "passed": "number",
      "failed": "number",
      "error": "number",
      "timeout": "number",
      "skipped": "number"
    },
    "checks": [
      {
        "itemId": "string",
        "status": "passed | failed | error | timeout | skipped",
        "evidence": "string"
      }
    ]
  },
  "turnTranscriptSnapshot": "string"
}
```

Result schema:

```json
{
  "messageId": "string",
  "turnId": "string",
  "review": {
    "overallChange": "string",
    "topRisks": [
      {
        "itemId": "string",
        "level": "low | med | high",
        "why": "string",
        "state": "open | validated | mitigated"
      }
    ],
    "nextBestAction": "string",
    "suggestReplyGuidance": "string"
  }
}
```

Output contract:

1. Concise final turn-level synthesis.
2. Must reference unresolved/highest-value risks surfaced earlier.
3. Must include one forward-progress action (`nextBestAction`).
4. `suggestReplyGuidance` is consumed by suggest-reply context builder.

---

### 2) Trigger + Ordering Contract

Lifecycle ordering:

1. On `item/fileChange/requestApproval`, enqueue `file_change_supervisor_insight` immediately.
2. On eligible `item/completed` for file-change, enqueue `file_change_supervisor_insight` (dedupe prevents duplicate for same item).
3. User approval/deny remains independent and non-blocking.
4. On `turn/completed`, gather applied diff insights where `risk != none`, enqueue one `risk_recheck_batch`.
5. After `risk_recheck_batch` reaches terminal (or immediately if zero checks), enqueue one `turn_supervisor_review`.
6. Suggest-reply context builder consumes latest `turn_supervisor_review` and unresolved risk outcomes.

Non-blocking invariant:

- User turn completion and approval UX must never wait on batch/review jobs.

---

### 3) Persistence Contract (Supervisor Ledger)

New persisted store:

- `.data/supervisor-ledger.json`

Store shape:

```json
{
  "version": 1,
  "byProjectId": {
    "<projectId>": {
      "byTurnId": {
        "<turnId>": {
          "insights": {
            "<itemId>": {
              "threadId": "string",
              "approvalId": "string (optional)",
              "applied": "boolean",
              "change": "string",
              "impact": "string",
              "riskLevel": "none | low | med | high",
              "riskReason": "string",
              "checkInstruction": "string",
              "checkExpected": "string",
              "updatedAt": "string"
            }
          },
          "riskBatchJobId": "string (optional)",
          "reviewJobId": "string (optional)"
        }
      }
    }
  }
}
```

Ledger rules:

1. Upsert by `(projectId, turnId, itemId)`.
2. Mark `applied = true` only after confirmed file-change completion for that item.
3. Recheck candidates require `applied = true` and `riskLevel != none`.
4. Replay-safe: store writes are idempotent.

---

### 4) Transcript Entry Contract (New Types)

#### 4.1 `fileChange.supervisorInsight`

- `messageId`: `file-change-supervisor-insight-${threadId}-${turnId}-${itemId}`
- `role`: `system`
- `type`: `fileChange.supervisorInsight`
- `status`: `streaming | complete | error | canceled`
- `details` includes structured insight JSON + `anchorItemId` + optional `approvalId`.
- Render anchor: same bubble container as diff preview when available.

#### 4.2 `riskRecheck.batch`

- `messageId`: `risk-recheck-batch-${threadId}-${turnId}`
- `role`: `system`
- `type`: `riskRecheck.batch`
- `status`: `streaming | complete | error | canceled`
- `details` includes batch summary + per-check rows.
- Render anchor: end of thought rows for that turn.

#### 4.3 `turn.supervisorReview`

- `messageId`: `turn-supervisor-review-${threadId}-${turnId}`
- `role`: `system`
- `type`: `turn.supervisorReview`
- `status`: `streaming | complete | error | canceled`
- `details` includes review payload.
- Render anchor: after `riskRecheck.batch` row for that turn.

---

### 5) UI Components Contract (Exact)

#### 5.1 `fileChange.supervisorInsight`

Display:

1. Inside the same diff bubble as file-change preview.
2. Four labeled rows:
- `Change`
- `Impact`
- `Risk` (badge `none|low|med|high`)
- `Check` (verbatim instruction + expected signal)
3. While running: show `Supervisor insight queued...` / `Supervisor analyzing...`.
4. On error: show compact failure state, do not block approval actions.

#### 5.2 `riskRecheck.batch`

Display:

1. One end-of-turn bubble:
- `Risk Recheck Results`
- summary line (`total/passed/failed/error/timeout/skipped`)
2. Default collapsed body:
- summary + non-passing checks only
3. Optional expand:
- show all checks with status badge, item reference, instruction, evidence snippet.

#### 5.3 `turn.supervisorReview`

Display:

1. One end-of-turn bubble after batch results.
2. Sections:
- `Overall Change`
- `Top Risks`
- `Next Best Action`
3. If no non-none risks, show explicit no-risk statement and still produce `Next Best Action`.

---

### 6) Suggest Reply Integration Contract

Context input order for suggest-reply prompt builder:

1. Latest `turn.supervisorReview.review`
2. Latest `riskRecheck.batch` unresolved/non-passing checks
3. Recent user intent from thread transcript

Output behavior:

1. One concise forward-progress reply, not iterative refinement chatter.
2. Must incorporate unresolved risks when present.
3. If risks are resolved, propose next concrete project step.

---

### 7) Prompt Contracts (Exact)

`file_change_supervisor_insight` generation prompt output format:

```json
{
  "change": "string",
  "impact": "string",
  "risk": { "level": "none|low|med|high", "reason": "string" },
  "check": { "instruction": "string", "expected": "string" },
  "confidence": "low|med|high"
}
```

Required rules:

1. JSON only, no markdown, no prose wrapper.
2. Concrete statements only; unknowns must be explicit.
3. Keep each top-level string concise.

`turn_supervisor_review` generation prompt output format:

```json
{
  "overallChange": "string",
  "topRisks": [{ "itemId": "string", "level": "low|med|high", "why": "string", "state": "open|validated|mitigated" }],
  "nextBestAction": "string",
  "suggestReplyGuidance": "string"
}
```

---

### 8) Acceptance Criteria (Build Gate)

1. For any file-change approval/completion event, a linked `fileChange.supervisorInsight` row appears or a terminal error row exists.
2. Approval UX remains interactive even if supervisor jobs are queued/failed.
3. On turn completion, exactly one `riskRecheck.batch` job runs per turn when candidates exist.
4. `riskRecheck.batch` shows explicit per-check terminal statuses.
5. Exactly one `turn.supervisorReview` row appears after batch terminal.
6. Suggest-reply uses review/risk context and emits forward-progress guidance.
7. No queued work is silently dropped on restart/recovery.
8. All new jobs obey explicit terminal-state contract (`completed|failed|canceled`).
