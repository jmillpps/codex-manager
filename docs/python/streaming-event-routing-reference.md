# Python Deep Dive: Streaming Event Routing Reference

## Purpose

Detailed reference for websocket event routing and handler matching in the Python client.

Use with [`streaming-and-handlers.md`](./streaming-and-handlers.md) when you need deterministic routing behavior across mixed handler registrations.

## Runtime Event Shape

The websocket stream emits codex-manager event envelopes.

Relevant fields in handler logic:

- `event.type`
- `event.payload`
- `event.thread_id`
- `event.turn_id`
- `event.request_id`

App-server passthrough events follow normalized names:

- notifications: `app_server.<normalized_method>`
- server requests: `app_server.request.<normalized_method>`

## Handler Registration APIs

Base matchers:

- `on_event(event_type)`
- `on_event_prefix(prefix)`

App-server helpers:

- `on_app_server(normalized_method)`
- `on_app_server_request(normalized_method)`
- `on_turn_started()`

Registration order is preserved inside the default router.

## Matching Rules

Default router behavior:

1. evaluate routes in registration order
2. invoke handler when matcher returns `True`
3. continue to remaining handlers even when one handler fails

Implication:

- handlers are fanout, not first-match short-circuit.

## Normalized Method Mapping

Examples:

- `item/started` -> `app_server.item.started`
- `item/tool/call` -> `app_server.request.item.tool.call`
- `item/fileChange/requestApproval` -> `app_server.request.item.file_change.request_approval`

Use normalized names in decorators.

## Filtering by Session or Turn

When running multi-session listeners, filter early:

```python
@cm.on_app_server("item.started")
async def on_item_started(signal, _ctx):
    if signal.context.get("threadId") != target_session_id:
        return
    # handle session-local logic
```

For remote-skill handling, prefer `skills.matches_signal(signal)` to avoid mismatched session dispatch.

## Handler Error Isolation

Handler exceptions are isolated by default router behavior.

Implications:

- one failing callback does not stop stream consumption
- one failing callback does not prevent other handlers from running

You should still log/monitor errors to avoid silent business-logic gaps.

## Sync vs Async Semantics

- Async client handlers may be sync or async callables.
- Sync client handlers must remain sync from caller perspective.

If sync remote-skill handlers accidentally return awaitables, dispatch returns a handled failure payload and instructs using the async client path.

## Router Injection Contract

Advanced users can inject `stream_router=...` to replace matching and dispatch behavior.

Recommended invariants for custom routers:

- preserve handler isolation
- preserve deterministic ordering guarantees
- avoid blocking I/O inside dispatch loop
- ensure exceptions remain observable

## Related docs

- Streaming and handlers overview: [`streaming-and-handlers.md`](./streaming-and-handlers.md)
- Remote-skill routing and submission semantics: [`remote-skills-dispatch-and-reliability.md`](./remote-skills-dispatch-and-reliability.md)
- Protocol event families: [`../protocol/harness-runtime-events.md`](../protocol/harness-runtime-events.md)
