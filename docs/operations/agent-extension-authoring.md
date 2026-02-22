# Operations: Agent Extension Authoring

## Purpose

This runbook explains how to implement agent extensions under `agents/*` that subscribe to runtime events and enqueue queue jobs.

Primary question:

- How do I add or modify event-driven agent workflows without hard-coding business logic in API core?

## Runtime model

The API loads extension modules from:

- `agents/<agent>/events.ts`
- `agents/<agent>/events.js`
- `agents/<agent>/events.mjs`

Repository baseline includes `agents/package.json` with `"type": "module"` so runtime-loaded extension modules are parsed as ESM in both `pnpm --filter @repo/api dev` and `pnpm --filter @repo/api start` paths.
When authoring TypeScript extension files, use explicit `.ts` extensions for relative imports (for example `../runtime/events.ts`) to avoid runtime module-resolution failures in production start mode.

Ignored directories:

- `agents/runtime`
- `agents/lib`
- dot-prefixed directories

Each module registers handlers by event name and receives tools:

- `enqueueJob(input)` to push orchestrator jobs
- `logger` for structured logs

## Recommended agent directory layout

Use this shape per agent:

```txt
agents/
  <agent>/
    AGENTS.md
    orientation.md
    agent.config.json
    events.ts
    playbooks/
      ...
```

File roles:

- `AGENTS.md`: persistent instruction profile for the worker.
- `orientation.md`: first-turn orientation message run once per worker session.
- `agent.config.json`: model and turn policy for worker turns.
- `events.ts`: subscriptions + job composition logic.
- `playbooks/*`: focused API usage runbooks referenced from `AGENTS.md`.

## Event module contract

Use `registerAgentEvents(registry)` and subscribe with `registry.on(eventType, handler)`.

Handler signature:

- input:
  - `event.type`
  - `event.payload`
- tools:
  - `enqueueJob`
  - `logger`

Current event names emitted by API core:

- `file_change.approval_requested`
- `turn.completed`
- `suggest_request.requested`

## Queue enqueue contract

`enqueueJob` accepts:

- `type`
- `projectId`
- optional `sourceSessionId`
- `payload` object

Current queue job types exposed by core:

- `agent_instruction`
- `suggest_request`

If no handler enqueues a job for an event, API endpoints depending on that event may return queue-conflict behavior (`409/503` depending on route).

## Worker session behavior

Worker sessions are system-owned and owner-scoped:

- mapping key: `${ownerId}::${agent}`
- `ownerId` is either:
  - project id (project-scoped worker)
  - `session:<sessionId>` for unassigned-chat workflows that still need queue-backed workers
- created lazily on first queued job
- hidden from user session lists
- blocked for user chat operations (`403 system_session`)

Worker execution flow:

1. resolve or create worker session
2. run orientation turn once when `orientation.md` exists
3. run instruction turn for each queued job

## Agent runtime policy (`agent.config.json`)

Supported fields:

- `model`
- `turnPolicy`
- `orientationTurnPolicy`
- `instructionTurnPolicy`
- `threadStartPolicy`

Turn policy supports:

- `sandbox`
- `networkAccess`
- `approvalPolicy`
- `effort`

If config is absent, API defaults are used.

## Instruction text guidance

Write instruction text as a deterministic contract for the worker:

- include routing identifiers (`projectId`, `sourceSessionId`, `threadId`, `turnId`, item/approval ids when applicable)
- include all context required to execute without lookups
- specify strict execution order when order matters
- specify exactly which API route to call and when
- specify what must not happen when optional actions are disabled

For transcript updates, use stable `messageId` conventions so retries and repeated writes remain idempotent.
When queue-terminal reconciliation is needed, include `supplementalTargets` in `agent_instruction` payload so core can reconcile those rows to explicit terminal states without workflow-specific hard-coding.

## Idempotency and dedupe guidance

For each workflow, define:

- queue dedupe key
- transcript message ids
- terminal reconciliation behavior

Targets:

- duplicate events should not create duplicate queued work
- retries should upsert/replace the same transcript rows
- terminal states should always be explicit for UI reconciliation

## Validation checklist for extension changes

Before merging extension updates:

1. verify event payload parsing handles sparse/invalid input safely
2. verify dedupe key shape prevents duplicate queue inflation
3. verify queued job reaches terminal state on success/failure/cancel paths
4. verify transcript rows are idempotent and anchor correctly
5. verify websocket-visible state transitions match UI expectations
6. verify stale worker session recovery path (thread not found) still converges

## Related references

- `docs/operations/agent-queue-framework.md`
- `docs/protocol/harness-runtime-events.md`
- `docs/operations/agent-queue-troubleshooting.md`
- `docs/implementation-status.md`
