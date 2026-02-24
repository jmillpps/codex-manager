# Queue Runner CLI Guide

This document defines how queue-runner agents use Codex Manager through CLI only.
Treat it as the canonical operational guide for live job execution.

Most job requests already provide the core context needed to act immediately.
When context is partial, use focused CLI reads to complete that context, then continue execution without stalling status signaling.

Use one interface only: the Codex Manager CLI.

## Strict behavior requirements

- Use CLI commands only.
- Use only `pnpm --filter @repo/cli dev ...` from repository root.
- Do not rely on globally installed binaries.
- Do not use browser UI actions.
- Do not use `curl`, direct SDK calls, inline Node scripts, or manual HTTP clients.
- Use `api request` only when no first-class CLI command exists for the required route.
- Do not delay initial live status signaling to perform reads.
- Verify state after each mutation phase and always on terminal completion.
- Do not run queue-operator workflows from this runtime path.
- Keep commands explicit and reproducible with concrete IDs.

## System primitives

The runtime is organized around a stable set of IDs. A `project` (`projectId`) is the routing and ownership boundary for grouped chats and queue work. A `session` (`sessionId`) is a thread, including system-owned threads. A `turn` (`turnId`) is one execution cycle inside a session, and all mutable events are tied to a specific turn. Treat `projectId + sessionId + turnId` as the core mutation boundary and do not cross it unless the job explicitly instructs you to do so.

Transcript state is recorded as normalized `transcript entry` rows (`messageId`, `turnId`, `role`, `type`, `status`, `content`) and should be treated as the canonical progress surface for live work. `type` names the semantic stream, and `status` controls lifecycle (`streaming`, `complete`, `error`, `canceled`).

Control gates and background execution are explicit records. An `approval request` (`approvalId`, sometimes `itemId`) is a pending gate decision. A `tool-input request` (`requestId`) is a pending structured input decision. An `orchestrator job` (`jobId`) tracks queue state (`queued`, `running`, `completed`, `failed`, `canceled`) and should be treated as auditable execution state, not an implicit side effect.

A system-owned session can process queued instructions while still being fully visible through CLI/API reads. Suggested-request signaling is tracked separately via `requestKey` and lifecycle state (`streaming`, `complete`, `error`, `canceled`) so suggestion delivery can reconcile independently of queue status.

## Mutation model and operating loop

Status signaling and mutation are one continuous path. Start with an immediate live signal, perform the requested work, keep status current as the job advances, then close with explicit terminal states. If the job request already includes all required context, execute immediately. If context is missing, do narrow reads to obtain only what is required for the next safe mutation, then proceed without delaying liveness updates. Queue ordering, dispatch, and cancellation are handled outside this runtime path, so execute the supplied job instruction directly instead of running queue-operator workflows.

In practice, this means: signal start, perform the first required mutation, continue incremental status updates, resolve required gates when instructed, apply steering only when the job explicitly allows it and the assessed risk is at or above the configured auto-steer threshold, then write terminal transcript/suggest-request state and verify the final system state with targeted reads.

## Execution priorities

1. Keep live progress visible from job start through completion.
2. Protect scope boundaries (`projectId + sessionId + turnId`) for every mutation.
3. Complete requested outcomes, not partial intermediate steps.
4. Make every state transition explicit with transcript/suggestion status updates.
5. Reconcile using current read state when conflicts occur.
6. Prefer first-class CLI commands over fallback routes.
7. Keep command sequences deterministic and reproducible with explicit IDs and structured inputs.

## Capability surface

Use these commands directly and replace placeholders with real values.

### Live transcript signaling

Transcript signaling is the primary user-visible heartbeat. Start with `streaming` as soon as work begins, update the same `messageId` while progress changes, and always end with `complete`, `error`, or `canceled`. For long or formatted output, prefer `--content-file`.

```bash
# streaming
pnpm --filter @repo/cli dev --json sessions transcript upsert \
  --session-id <sessionId> \
  --message-id <messageId> \
  --turn-id <turnId> \
  --entry-role system \
  --type <entryType> \
  --status streaming \
  --content "Working..."

# complete
pnpm --filter @repo/cli dev --json sessions transcript upsert \
  --session-id <sessionId> \
  --message-id <messageId> \
  --turn-id <turnId> \
  --entry-role system \
  --type <entryType> \
  --status complete \
  --content-file <absolutePathToContentFile>

# error
pnpm --filter @repo/cli dev --json sessions transcript upsert \
  --session-id <sessionId> \
  --message-id <messageId> \
  --turn-id <turnId> \
  --entry-role system \
  --type <entryType> \
  --status error \
  --content "Failed to complete work."

# canceled
pnpm --filter @repo/cli dev --json sessions transcript upsert \
  --session-id <sessionId> \
  --message-id <messageId> \
  --turn-id <turnId> \
  --entry-role system \
  --type <entryType> \
  --status canceled \
  --content "Work canceled."
```

### Suggested-request signaling

Queue trigger operations are caller responsibilities. Queue-runner agents only update suggestion lifecycle state. Prefer `--suggestion-file` when writing final suggestion text so multi-line output remains stable and shell-escaping risk stays low.

```bash
# streaming
pnpm --filter @repo/cli dev --json sessions suggest-request upsert \
  --session-id <sessionId> \
  --request-key <requestKey> \
  --status streaming

# complete
pnpm --filter @repo/cli dev --json sessions suggest-request upsert \
  --session-id <sessionId> \
  --request-key <requestKey> \
  --status complete \
  --suggestion-file <absolutePathToSuggestionFile>

# error
pnpm --filter @repo/cli dev --json sessions suggest-request upsert \
  --session-id <sessionId> \
  --request-key <requestKey> \
  --status error \
  --error "suggest request generation failed"
```

### Approval and tool-input resolution

Use gate-decision commands only when the active job explicitly requires a gate mutation, includes one or more concrete gate IDs, and all prerequisites in the job request are satisfied. Resolve each gate once, in job-defined order, with the required decision and scope. If a result indicates already-resolved/not-found/conflict, treat that gate as reconciled and continue without retry loops. User actions remain authoritative.

```bash
# resolve approval
pnpm --filter @repo/cli dev --json approvals decide \
  --approval-id <approvalId> \
  --decision <accept|decline|cancel> \
  --scope <turn|session>

# resolve tool-input
pnpm --filter @repo/cli dev --json tool-input decide \
  --request-id <requestId> \
  --decision <accept|decline|cancel>

# resolve tool-input with answers
pnpm --filter @repo/cli dev --json tool-input decide \
  --request-id <requestId> \
  --decision accept \
  --answers @<answersJsonFile>
```

### Turn steering

Use steering when the job explicitly requires redirecting an in-flight turn. Steering should be scoped to the active `sessionId + turnId`, concise, and action-oriented. You must not run `sessions steer` unless the current job indicates steering is enabled and the assessed risk is at or above the configured auto-steer threshold. When steering introduces a context shift, carry forward unfinished instructions so in-flight work does not get dropped during the pivot.

```bash
# inline steering
pnpm --filter @repo/cli dev --json sessions steer \
  --session-id <sessionId> \
  --turn-id <turnId> \
  --input "Adjust approach based on current risk findings."

# file-based steering
pnpm --filter @repo/cli dev --json sessions steer \
  --session-id <sessionId> \
  --turn-id <turnId> \
  --input-file <absolutePathToSteerFile>
```

### Session and worker context research

Job requests supply the target `projectId + sessionId + turnId` context. In most cases that context is sufficient, so execute without extra reads by default. Gather additional context only when a specific next mutation requires it, and only at the moment it is required.

When an action needs confirmation, gather the smallest possible context packet for that action: current turn status, only the transcript surface you are about to mutate, and whether a prior row already exists for that same semantic stream (`fileChange.explainability`, `fileChange.supervisorInsight`, `turn.supervisorReview`, `agent.jobOutput`, or suggestion state).

If the queue request includes a worker-session reference, inspect that worker session only when needed to recover immediate execution context for the active instruction chain (for example, most recent in-flight status or prior error for the same chain). Do not widen into historical forensics unless the job explicitly asks for investigation.

Treat reads as an escalation ladder, not a mandatory sequence: start with no read, then use only the first read that unblocks the next mutation. Use event streaming only when ordering or timing is still ambiguous for a pending action.

```bash
# optional canonical session snapshot
pnpm --filter @repo/cli dev --json sessions get --session-id <sessionId>

# optional focused transcript read for one active surface
pnpm --filter @repo/cli dev --json sessions inspect \
  --session-id <sessionId> \
  --transcript-tail 40 \
  --types fileChange.explainability,fileChange.supervisorInsight,turn.supervisorReview,agent.jobOutput \
  --statuses streaming,complete,error,canceled

# optional worker-session context when supplied by job
pnpm --filter @repo/cli dev --json sessions inspect \
  --session-id <workerSessionId> \
  --transcript-tail 30 \
  --roles assistant,system \
  --statuses streaming,complete,error,canceled

# live event stream when ordering context is needed
pnpm --filter @repo/cli dev --json stream events \
  --thread-id <sessionId> \
  --jsonl \
  --duration-ms 60000
```

## Reliability and parsing rules

- Boolean options must be explicit strings: `true` or `false`.
- JSON file inputs use `@file` where supported (`--answers`, `--response`).
- Text file inputs use dedicated `--*-file` flags (`--input-file`, `--content-file`, `--details-file`, `--suggestion-file`).
- `sessions transcript upsert` requires content text or content file.
- `sessions suggest-request upsert --status complete` requires suggestion text or suggestion file.

## Decision outcomes and conflict handling

- Gate mutation `404` generally means already resolved or no longer available; treat as reconciled and continue remaining required actions.
- `409` conflict means state changed before your write; read current state, then continue from authoritative values.
- `410` indicates the target session/turn no longer exists; stop mutation attempts for that target and reconcile to current scope.
