# Operations: Agent Queue Runtime Semantics

## Purpose

This is the runtime-behavior deep dive for queue execution.

Use it with `agent-queue-framework.md` when you need exact semantics for worker provisioning, retries, timeouts, completion settlement, and websocket coupling.

## Runtime Model

Queue execution is generic and extension-driven.

- Core queue runtime: `apps/api/src/orchestrator-queue.ts`
- Typed job contracts/processors: `apps/api/src/orchestrator-types.ts`, `apps/api/src/orchestrator-processors.ts`
- API integration and endpoints: `apps/api/src/index.ts`

Key property: extension handlers define workflow meaning; queue runtime defines execution guarantees.

## Queue Guarantees

- foreground user turns do not block on background queue work.
- every job reaches terminal state (`completed|failed|canceled`).
- retries are classification-based (`retryable` vs `fatal`).
- persisted recovery failures are explicit (not silently dropped).
- dedupe semantics are deterministic per job contract.

## Worker Session Provisioning

Worker sessions are owner+agent scoped.

- mapping key: `${ownerId}::${agent}`
- `ownerId` is project id or `session:<sessionId>` for unassigned-chat ownership.
- worker sessions are hidden from default user listing.

Lifecycle:

1. resolve/create worker session lazily on first job.
2. run one-time startup preflight.
3. execute one instruction turn per queued job.

Startup preflight includes:

- one mandatory core queue-runner orientation turn.
- optional one-time extension bootstrap turn keyed by `bootstrapInstruction.key`.

## Execution and Settlement Semantics

Queue worker completion prefers runtime notification streams first, with read-path fallback when needed.

Primary signals:

- runtime turn/item notifications for system-owned worker chats.
- supplemental read fallback (`thread/read(includeTurns)`) in bounded windows.

Important behavior:

- include-turns materialization waits are grace-bounded.
- untrusted terminal snapshots require stable no-progress window before self-heal.
- empty running turns over grace threshold fail retryable to avoid phantom stalls.

## Retry and Delay Model

Queue runtime supports:

- bounded attempts (`ORCHESTRATOR_QUEUE_MAX_ATTEMPTS`)
- per-job timeout (`ORCHESTRATOR_QUEUE_DEFAULT_TIMEOUT_MS` or job override)
- retry delay strategies, including immediate-first linear backoff for agent jobs.

Repository-default pattern for agent instruction jobs:

- attempt 1 retry delay: `0ms`
- later attempts: `+60ms` linear increments

## Suggest-Request Deadline Behavior

Suggest-request queue execution is completion-signal based and deadline bounded.

If no completion signal arrives within `ORCHESTRATOR_SUGGEST_REQUEST_WAIT_MS`:

- core writes deterministic fallback suggestion state
- interrupts worker turn best-effort
- terminalizes queue job without waiting indefinitely

This prevents hanging request UX when worker output cannot be observed in time.

## Cleanup and Recovery Paths

Recovery behavior includes:

- stale mapped worker session reprovision (single reset+retry path)
- invalid/unknown persisted job payload terminalization with explicit failure reason
- in-flight request map cleanup on turn/session cleanup and runtime exit

Goal: no silent state drift and no unbounded queue growth due to malformed recovery input.

## Websocket Coupling

Queue lifecycle emits websocket events:

- `orchestrator_job_queued`
- `orchestrator_job_started`
- `orchestrator_job_progress`
- `orchestrator_job_completed`
- `orchestrator_job_failed`
- `orchestrator_job_canceled`

Transcript side effects emit:

- `transcript_updated`

UX design assumption:

- websocket drives live UI updates
- REST/read-path reconciliation handles missed-event recovery windows

## Operational Tuning

Primary knobs:

- concurrency/capacity: `ORCHESTRATOR_QUEUE_GLOBAL_CONCURRENCY`, `ORCHESTRATOR_QUEUE_MAX_PER_PROJECT`, `ORCHESTRATOR_QUEUE_MAX_GLOBAL`
- retries/timeouts: `ORCHESTRATOR_QUEUE_MAX_ATTEMPTS`, `ORCHESTRATOR_QUEUE_DEFAULT_TIMEOUT_MS`
- worker settlement grace: `ORCHESTRATOR_AGENT_*`

Tuning sequence:

1. baseline with defaults.
2. measure queue depth + job latency + memory.
3. adjust one variable group at a time.
4. validate with runtime smoke + queue-specific scenarios.

## Failure Diagnosis Checklist

1. confirm queue enabled in health state.
2. inspect job state transitions (`queued/running/terminal`).
3. inspect worker session transcript for instruction progress.
4. verify extension handler emitted actionable output (enqueue/action result).
5. verify settings/trust/RBAC policy did not block expected action path.

Use `agent-queue-troubleshooting.md` for concrete symptom-led playbooks.

## Related docs

- Queue framework foundation: [`agent-queue-framework.md`](./agent-queue-framework.md)
- Event/job payload contracts: [`agent-queue-event-and-job-contracts.md`](./agent-queue-event-and-job-contracts.md)
- Queue troubleshooting playbook: [`agent-queue-troubleshooting.md`](./agent-queue-troubleshooting.md)
- Extension lifecycle controls: [`agent-extension-lifecycle-and-conformance.md`](./agent-extension-lifecycle-and-conformance.md)
