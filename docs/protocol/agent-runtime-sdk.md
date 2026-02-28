# Protocol: Agent Runtime SDK Contract

## Purpose

This document defines the canonical extension-facing SDK contract implemented by `@codex-manager/agent-runtime-sdk`.

Primary question:

- What stable types and helper semantics do runtime and extension code share?

## Package

- package: `@codex-manager/agent-runtime-sdk`
- core API constant: `AGENT_RUNTIME_CORE_API_VERSION = 1`

This SDK is provider-neutral. Provider-specific behavior is implemented by runtime profile adapters in API core.

## Runtime profile types

- `AgentRuntimeProfile`
  - `runtimeProfileId`
  - `runtimeProfileVersion`
  - `coreApiVersion`
- `AgentRuntimeCompatibility`
  - `coreApiVersion` or `coreApiVersionRange`
  - `profiles[]` (`name`, `version`, `versionRange`)

## Event and tool types

- `AgentRuntimeEvent`
  - `type`, `payload`, optional `emittedAt`, `correlationId`
- `AgentRuntimeTools`
  - `enqueueJob(input)`
  - `logger`
  - optional `getSessionSettings(sessionId)` for extension-side per-session settings lookup
  - optional `getSessionSetting(sessionId, key)` for extension-side top-level key lookup
- `AgentEventRegistry`
  - `on(eventType, handler, { priority, timeoutMs })`

## Handler output envelopes

`emit()` output is normalized to `AgentEventEmitResult[]` with discriminants:

- `enqueue_result`
- `action_result`
- `handler_result`
- `handler_error`

### `enqueue_result`

Represents queue enqueue outcomes:

- `status: enqueued | already_queued`
- includes normalized job identity and state

### `action_result`

Represents state-changing action attempts:

- `actionType` (for example `approval.decide`, `turn.steer.create`, `transcript.upsert`, `queue.enqueue`)
- `status: performed | already_resolved | not_eligible | conflict | forbidden | invalid | failed`

Handlers do not execute actions directly. Handlers return `kind: "action_request"` and runtime executes intents through the internal API-core action executor.

### `handler_result`

Represents non-side-effect or diagnostic outputs.

### `handler_error`

Represents normalized execution failures (thrown handler errors and timeout errors).

## Normalization helpers

SDK helper functions:

- `toAgentEventEmitResult(moduleName, eventType, raw)`
- `toAgentEventHandlerError(moduleName, eventType, error)`

These ensure active runtime paths avoid unknown-shape scanning.

## Reconciliation helpers

- `selectEnqueueWinner(results, strategy)`
- `selectFirstSuccessfulAction(results)`
- `classifyReconciledActionStatus(status)`
- `selectActionExecutionPlan(results)`

Semantics:

- first successful state-changing action (`performed`) is winner
- `already_resolved`, `not_eligible`, `conflict` classify as reconciled
- `failed`, `forbidden`, and `invalid` classify as failed

## Dispatch ordering contract

The runtime order key is:

1. `priority` ascending
2. module name ascending
3. registration index ascending

Default priority is `100`.

## Active core event names

Current runtime-emitted event names:

- `file_change.approval_requested`
- `turn.completed`
- `suggest_request.requested`
- `app_server.<normalized_method>` for app-server notifications
- `app_server.request.<normalized_method>` for app-server server-initiated requests

Normalization:

- split app-server method on `/`
- camelCase/PascalCase segments convert to `snake_case`
- segments join with `.`

Shared app-server signal payload envelope fields:

- `source: "app_server"`
- `signalType: "notification" | "request"`
- `eventType`
- `method`
- `receivedAt`
- `context.threadId` / `context.turnId`
- `params`
- `session` (`{ id, title, projectId } | null`)
- `requestId` (request signals only)

## Related references

- `docs/protocol/agent-dispatch-and-reconciliation.md`
- `docs/protocol/agent-extension-packaging.md`
- `docs/protocol/harness-runtime-events.md`
