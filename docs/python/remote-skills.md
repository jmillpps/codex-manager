# Python Remote Skills

## Purpose

Run Python callables as session-scoped dynamic tool handlers for Codex sessions through codex-manager.

This is service-bound integration, not a local-only loop: codex-manager exposes server routes for pending tool-call retrieval and response submission.

## Server routes used

- `GET /api/sessions/:sessionId/tool-calls`
  - list pending dynamic tool-call requests for one session.
- `POST /api/tool-calls/:requestId/response`
  - submit tool-call output; codex-manager forwards response to `codex app-server`.

Python wrappers:

- `cm.session(session_id).tool_calls.list()`
- `cm.tool_calls.respond(request_id=..., ...)`

## Session-scoped remote-skill facade

`client.remote_skills.session(session_id)` returns a session registry with:

- skill registration and catalog rendering
- dynamic tool payload generation
- helper send methods with optional catalog injection
- signal/pending-call dispatch and response submission

Create a new session with tools included on create:

- `client.remote_skills.create_session(register=..., **session_create_kwargs)`

Use this for first-turn tool availability reliability.

## Core methods

Catalog and lifecycle:

- `register(name, handler, description=..., input_schema=...)`
- `skill(...)` decorator
- `unregister(name)`
- `clear()`
- `dynamic_tools()`
- `instruction_text()`
- `inject_request(text)`

Runtime sync and send helpers:

- `sync_runtime()`
- `prepare_catalog()`
- `send(text, inject_skills=True, ...)`
- `send_prepared(text, inject_skills=True, ...)`

Dispatch and response helpers:

- `matches_signal(signal)`
- `respond_to_signal(signal)`
- `respond_to_pending_call(call)`
- `drain_pending_calls()`

Scoped registration helper:

- `using(...)` / `async using(...)` for auto cleanup

## Sync example

```python
from codex_manager import CodexManager

with CodexManager.from_profile("local") as cm:
    def register(skills):
        @skills.skill(
            name="lookup_ticket",
            description="Lookup ticket status by id",
            input_schema={"type": "object", "properties": {"ticket_id": {"type": "string"}}},
        )
        def lookup_ticket(ticket_id: str) -> dict[str, str]:
            return {"ticketId": ticket_id, "status": "open"}

    created, skills = cm.remote_skills.create_session(register=register, cwd=".")
    session_id = created["session"]["sessionId"]

    @cm.on_app_server_request("item.tool.call")
    def on_tool_call(signal, _ctx):
        skills.respond_to_signal(signal)

    cm.stream.run_forever(thread_id=session_id)
```

## Async example

```python
import asyncio
from codex_manager import AsyncCodexManager

async def main() -> None:
    async with AsyncCodexManager.from_profile("local") as cm:
        def register(skills):
            @skills.skill(
                name="summarize_diff",
                description="Summarize a unified diff",
                input_schema={"type": "object", "properties": {"diff_text": {"type": "string"}}},
            )
            async def summarize_diff(diff_text: str) -> str:
                return f"Summary: {diff_text[:200]}"

        created, skills = await cm.remote_skills.create_session(register=register, cwd=".")
        session_id = created["session"]["sessionId"]

        @cm.on_app_server_request("item.tool.call")
        async def on_tool_call(signal, _ctx):
            await skills.respond_to_signal(signal)

        await cm.stream.run_forever(thread_id=session_id)

asyncio.run(main())
```

## Reliability notes

- `respond_to_signal(...)` ignores non-tool-call signals and returns `None`.
- `respond_to_signal(...)` and `respond_to_pending_call(...)` are session-aware.
- response submit retries default to `max_submit_attempts=3`, `retry_delay_seconds=0.05`.
- `404 not_found` and `409 in_flight` are treated as idempotent completion outcomes in dispatch metadata.
- `drain_pending_calls()` is a websocket-independent fallback for delayed stream windows.

## Status outcomes from response route

Typical outcomes:

- `200` accepted
- `404` unknown/already resolved request
- `409` response already in flight (`code: "in_flight"`)
- `500` upstream/runtime response submit failure

## Read Next (Level 3)

- Lifecycle and catalog sync strategy: [`remote-skills-lifecycle-and-catalog.md`](./remote-skills-lifecycle-and-catalog.md)
- Dispatch/retry/idempotency details: [`remote-skills-dispatch-and-reliability.md`](./remote-skills-dispatch-and-reliability.md)

## Related docs

- Streaming decorators and listener reliability: [`streaming-and-handlers.md`](./streaming-and-handlers.md)
- Multi-session collaboration pattern: [`team-mesh.md`](./team-mesh.md)
- Python API surface map: [`api-surface.md`](./api-surface.md)
