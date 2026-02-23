# Protocol: Agent Dispatch and Reconciliation

## Purpose

This document defines the runtime dispatch contract for extension events and the reconciliation rules for competing handler outcomes.

Primary question:

- How does fanout dispatch execute and how are races resolved deterministically?

## Dispatch policy

All runtime events use fanout dispatch:

- every subscribed handler executes
- one failing handler does not terminate dispatch
- per-handler timeout isolation is enforced
- handler tool access is invocation-scoped; late tool calls after timeout/completion are rejected so timed-out handlers cannot enqueue delayed side effects

Handler invocation itself is never short-circuited.  
Action execution is first-wins reconciled:

- once one action request executes with `status: performed`, that action becomes the winner
- later action requests in the same emit pass are not executed and are normalized to `action_result` with `status: not_eligible`

Action execution is scope-locked when event context is present:

- runtime derives execution scope from event payload context (`projectId`, `sourceSessionId`, `turnId`) when available
- action routes enforce scope constraints (`transcript.upsert`, `approval.decide`, `turn.steer.create`)
- `queue.enqueue` cannot target a different project than scoped `projectId` and inherits scoped `sourceSessionId` when omitted

## Deterministic ordering

Handler execution order is stable:

1. `priority` ascending
2. module name ascending
3. registration index ascending

Default priority: `100`.

## Emit algorithm

For each event:

1. resolve handlers for `event.type`
2. sort by deterministic key
3. invoke each handler with `(event, tools)`
4. normalize output to typed envelope
5. after first `action_result(performed)`, reconcile later action requests as `not_eligible` without execution
6. normalize thrown error/timeout to `handler_error`
7. return ordered `AgentEventEmitResult[]`

## Result envelope semantics

- `enqueue_result`: queue enqueue attempt (`enqueued` or `already_queued`)
- `action_result`: state-changing attempt (`performed`, `already_resolved`, `not_eligible`, `conflict`, `forbidden`, `invalid`, `failed`)
- `handler_result`: non-side-effect/diagnostic output
- `handler_error`: handler execution failure

## Reconciliation semantics

### Winner rule

- first `action_result` with `status: performed` is authoritative

### User-authoritative race

If user resolves state first, late agent actions should reconcile as:

- `already_resolved` (or other reconciled status)

These are expected non-fatal outcomes.

### Reconciled statuses

- `already_resolved`
- `not_eligible`
- `conflict`

### Failed statuses

- `failed`
- `forbidden`
- `invalid`

## Queue winner selection

For routes that require one queue job identity (for example suggest-request enqueue):

1. first `enqueue_result` with `status: enqueued`
2. else first `enqueue_result` with `status: already_queued`
3. else no winner -> explicit queue conflict behavior

## Consumer rules

- active runtime consumers must use typed helper selection paths
- unknown-shape scanning in active event-consumer paths is disallowed

## Observability contract

Per-event dispatch summary should include:

- event type
- handler count
- enqueue count
- action count
- handler error count
- winner action (if any)
- reconciled loser statuses

## Related references

- `docs/protocol/agent-runtime-sdk.md`
- `docs/protocol/harness-runtime-events.md`
- `docs/architecture/agent-extension-runtime.md`
