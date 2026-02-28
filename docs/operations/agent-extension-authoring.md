# Operations: Agent Extension Authoring

## Purpose

This runbook explains how to build extension modules that integrate with the runtime event fanout contract and queue execution model.

Primary question:

- How do I add or modify event-driven workflows without hard-coding workflow logic into API core?

## Authoring surfaces

Use the runtime SDK package for extension contracts:

- `@codex-manager/agent-runtime-sdk`

Repository-local extensions can still import through:

- `agents/runtime/events.ts` (thin SDK re-export)

Core contract highlights:

- typed runtime events (`AgentRuntimeEvent`)
- typed tools (`enqueueJob`, `logger`, optional `getSessionSettings`, optional `getSessionSetting`)
- typed emit result envelopes (`enqueue_result`, `action_result`, `handler_result`, `handler_error`)
- deterministic registration options (`priority`, `timeoutMs`)

## Extension source layouts

### Repo-local development extension

```txt
agents/
  <agent>/
    extension.manifest.json
    events.js|events.mjs|events.ts
    AGENTS.md
    agent.config.json
    playbooks/
      ...
```

### External/package-style extension

```txt
<extension-root>/
  extension.manifest.json
  events.js|events.mjs|events.ts
  AGENTS.md
  agent.config.json
```

External roots are loaded through:

- `AGENT_EXTENSION_PACKAGE_ROOTS`
- `AGENT_EXTENSION_CONFIGURED_ROOTS`

See `docs/operations/agent-extension-lifecycle-and-conformance.md` for operational root wiring.

## Required manifest fields

`extension.manifest.json` should include:

- `name`
- `version`
- `agentId`
- `displayName`
- `runtime` compatibility:
  - `coreApiVersion` and/or `coreApiVersionRange`
  - `profiles[]` (`name`, `version` or `versionRange`)
- `entrypoints.events`
- `capabilities.events[]`
- `capabilities.actions[]`

Example:

```json
{
  "name": "@acme/supervisor-agent",
  "version": "1.0.0",
  "agentId": "supervisor",
  "displayName": "Supervisor",
  "runtime": {
    "coreApiVersion": 1,
    "coreApiVersionRange": ">=1 <2",
    "profiles": [
      { "name": "codex-manager", "versionRange": ">=1 <2" }
    ]
  },
  "entrypoints": {
    "events": "./events.mjs"
  },
  "capabilities": {
    "events": ["suggest_request.requested"],
    "actions": ["queue.enqueue"]
  }
}
```

## Event registration contract

Export `registerAgentEvents(registry)` and subscribe with:

- `registry.on(eventType, handler, { priority, timeoutMs })`

Runtime dispatch semantics:

- fanout to all handlers for the event
- deterministic order:
  - `priority` ascending
  - module name ascending
  - registration index ascending
- per-handler timeout isolation
- one failing/timed-out handler does not block others

Current API core event families:

- synthesized workflow events:
  - `file_change.approval_requested`
  - `turn.completed`
  - `suggest_request.requested`
- app-server notification pass-through:
  - `app_server.<normalized_method>`
- app-server server-request pass-through:
  - `app_server.request.<normalized_method>`

`<normalized_method>` uses protocol method normalization:

- split app-server method on `/`
- camelCase/PascalCase segments convert to `snake_case`
- segments join with `.`

Examples:

- `app_server.turn.started`
- `app_server.item.reasoning.summary_text_delta`
- `app_server.request.item.file_change.request_approval`

See `docs/protocol/harness-runtime-events.md` for the full method-to-event map and shared app-server signal envelope fields.

## Handler output contract

Handlers can return:

- `AgentJobEnqueueResult` (`enqueued` or `already_queued`)
- `AgentRuntimeActionRequest` (`kind: "action_request"`) for side effects
- explicit `AgentEventEmitResult`
- `void` / `null` / `undefined` for diagnostics-only handling

Runtime executes action requests in API core; handlers cannot directly execute actions.
Returning `action_result` directly is treated as invalid by runtime.

Use stable capability/action names for `action_request.actionType`:

- `queue.enqueue`
- `transcript.upsert`
- `approval.decide`
- `turn.steer.create`

## Trust and capability rules

Runtime policy is configured with `AGENT_EXTENSION_TRUST_MODE`:

- `disabled`: allow undeclared capabilities
- `warn`: allow but log undeclared capability warnings
- `enforced`: reject undeclared event/action capabilities

In enforced mode:

- undeclared event subscriptions can deny module activation
- undeclared action attempts are denied with `status: "forbidden"` and `code: "undeclared_capability"`

Declare capabilities accurately in the manifest to avoid activation/action failures.

## Queue enqueue guidance

Use `enqueueJob` with:

- `type`
- `projectId`
- optional `sourceSessionId`
- `payload`

Core queue job types:

- `agent_instruction`
- `suggest_request`

Dedupe and idempotency guidance:

- define deterministic queue keys to prevent duplicate inflation
- reuse stable transcript `messageId` values
- include `supplementalTargets` on `agent_instruction` payload when queue-terminal reconciliation is required

## Worker execution model

Worker sessions are system-owned and owner-scoped:

- mapping key: `${ownerId}::${agentId}`
- hidden from default user session lists (`GET /api/sessions`), with operator visibility via `GET /api/sessions?includeSystemOwned=true` and `GET /api/projects/:projectId/agent-sessions`
- worker sessions are readable (`GET /api/sessions/:sessionId`), while mutating user-chat operations still return `403 system_session`

Execution flow:

1. resolve/create worker session
2. run startup preflight once for the worker session before executing instruction turns
3. startup preflight runs core queue-runner orientation once
4. startup preflight runs optional extension bootstrap once per session/bootstrap-key when provided by queue payload (`bootstrapInstruction`)
5. run exactly one instruction turn per queued job

Worker turn policy can be controlled by `agent.config.json`:

- `model`
- `turnPolicy`
- `orientationTurnPolicy`
- `instructionTurnPolicy`
- `threadStartPolicy`

## Validation checklist

Before merging extension changes:

1. manifest compatibility and capability declarations are valid
2. handler payload parsing is defensive for sparse/invalid inputs
3. queue dedupe behavior matches workflow requirements
4. transcript message ids are stable/idempotent
5. terminal states are explicit (`completed`/`failed`/`canceled`)
6. behavior is verified under trust mode expected for deployment

## Related references

- `docs/operations/agent-extension-lifecycle-and-conformance.md`
- `docs/operations/agent-queue-framework.md`
- `docs/protocol/harness-runtime-events.md`
- `docs/implementation-status.md`
