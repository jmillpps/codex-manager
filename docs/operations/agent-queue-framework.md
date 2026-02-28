# Operations: Agent Queue Framework

## Purpose

This is the one-level-deeper queue framework guide.

It starts where `README.md` leaves off for orchestration: the README says queue/extension runtime exists; this document explains the queue mental model, guarantees, and how to safely build workflows on top of it.

## What You Should Understand After Reading

- Which responsibilities belong to queue core vs extension handlers.
- Why worker sessions are system-owned and owner-scoped.
- How dedupe, retries, and terminal reconciliation maintain operational reliability.
- Which level-2 docs to use for exact payload contracts and runtime timing behavior.

## Core Model

Codex Manager queue architecture is intentionally split:

- **Queue core** (API runtime)
  - executes typed jobs with retry/cancel/timeouts.
  - persists and recovers job state.
  - provisions worker sessions and streams lifecycle events.
- **Extension handlers** (`agents/*`)
  - subscribe to runtime events.
  - decide what work should be enqueued.
  - define instruction semantics and side-effect strategy.

This separation keeps queue runtime generic while allowing workflow-specific behavior to evolve independently.

## Invariants

1. Foreground user turn streaming must not block on background queue work.
2. Every queue job must reach explicit terminal state (`completed|failed|canceled`).
3. Dedupe keys must make repeated triggers idempotent for intended scope.
4. Worker sessions are infrastructure sessions, not user chat sessions.
5. Transcript side effects must be idempotent by stable message id.

## Event -> Job -> Side Effect Flow

Canonical pipeline:

1. Runtime/system event is emitted into extension runtime.
2. Extension handler emits enqueue output.
3. Queue runtime resolves dedupe and schedules execution.
4. Worker session executes one instruction turn.
5. Side effects update transcript/approvals/steer/suggest state.
6. Queue terminal reconciliation enforces explicit terminal output.

## Worker Session Model

Worker sessions are keyed by owner + agent:

- mapping key: `${ownerId}::${agent}`
- owner id: project id or `session:<sessionId>` fallback for unassigned-chat ownership.

Operational semantics:

- created lazily on first relevant job.
- hidden from default user session list surfaces.
- visible for operators through dedicated include-system-owned/session-mapping routes.
- subject to startup preflight (core orientation + optional bootstrap per key).

## Dedupe and Retry Philosophy

Dedupe avoids duplicate work inflation in bursty event windows.

Retries are bounded and classified:

- transient failures are retryable.
- invalid payload/schema failures are terminal and explicit.

Repository supervisor flows use deterministic dedupe keys by session/turn/item context and immediate-first retry behavior for stale-worker recovery.

## Queue Job Families in Practice

Repository workflows primarily use `agent_instruction` jobs with `jobKind` variants (for example `suggest_request`, `session_initial_rename`, file-change/turn reviews).

`expectResponse` controls completion contract shape:

- `none`
- `assistant_text`
- `action_intents`

Worker side effects can be live CLI-driven or parsed/executed intent-driven, depending on workflow design.

## UI and Stream Coupling

Queue lifecycle is observable by websocket events (`orchestrator_job_*`) and transcript deltas.

Client behavior should assume:

- websocket is live source for progress UX.
- REST/read-path fallback exists for reconciliation after missed events.

## Reliability Model

Queue reliability includes:

- bounded timeouts.
- bounded retries with explicit classification.
- worker reprovision on stale mapping.
- completion-signal and deadline-bounded handling for suggest-request jobs.
- terminal reconciliation for expected supplemental transcript outputs.

## Building New Workflows Safely

When adding new queue-backed behavior:

1. Define event subscription in extension.
2. Define deterministic dedupe key.
3. Define one job contract and expected terminal output.
4. Keep side effects idempotent by stable IDs.
5. Add validation coverage for retry/reconcile paths.

## Read Next (Level 3)

- Event and job payload contracts: [`agent-queue-event-and-job-contracts.md`](./agent-queue-event-and-job-contracts.md)
- Runtime settlement/retry/recovery semantics: [`agent-queue-runtime-semantics.md`](./agent-queue-runtime-semantics.md)
- Symptom-led queue troubleshooting: [`agent-queue-troubleshooting.md`](./agent-queue-troubleshooting.md)
- Queue-runner capability model: [`../queue-runner.md`](../queue-runner.md)
- Extension authoring patterns: [`agent-extension-authoring.md`](./agent-extension-authoring.md)
- Runtime event families: [`../protocol/harness-runtime-events.md`](../protocol/harness-runtime-events.md)
