# Codex App Server Event Stream Reference

## Purpose

This is the one-level event-stream reference.

It summarizes event families and lifecycle semantics and points to deeper catalog/type docs.

## Event Surface Model

App-server emits:

- notifications (no request id)
- server-initiated requests (with request id, expects one response)

When a thread is active, clients must continuously read stream signals.

## Lifecycle Semantics

- turn lifecycle: `turn/started` -> in-turn item activity -> `turn/completed`
- item lifecycle: `item/started` -> optional item deltas -> `item/completed`
- terminal item completion is authoritative for final item state

## High-Impact Event Families

- account/login/app/config warnings
- turn plan/diff/token updates
- item content deltas (agent/reasoning/command/file)
- approvals/tool-input/tool-call server requests

## Implementation Guidance

- route events by exact `method`
- apply deltas in order per `itemId`
- always reconcile to terminal completed item/turn state
- keep request-response matching exact for server-initiated request ids

## Read Next (Level 3)

- Complete event/request method catalog: [`events-catalog.md`](./events-catalog.md)
- Item types and delta semantics: [`events-item-types-and-deltas.md`](./events-item-types-and-deltas.md)
- Approval/tool-input request flows: [`approvals-and-tool-input.md`](./approvals-and-tool-input.md)

## Related docs

- Protocol overview: [`overview.md`](./overview.md)
- Core lifecycle methods: [`methods-core.md`](./methods-core.md)
- Harness runtime event mapping: [`harness-runtime-events.md`](./harness-runtime-events.md)
