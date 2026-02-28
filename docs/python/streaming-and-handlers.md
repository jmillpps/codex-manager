# Streaming and Handlers

## Purpose

This is the one-level stream and handler guide for the Python client.

It explains how to consume codex-manager websocket events, register handler decorators, and connect stream events to automation workflows.

## Stream entrypoints

- Sync client: `client.stream.run_forever(...)`
- Async client: `await client.stream.run_forever(...)`

Websocket endpoint:

- `/api/stream`

By default, the SDK uses a deterministic registration-order event router with handler isolation.

## Core decorator APIs

Generic event routing:

- `on_event(event_type)`
- `on_event_prefix(prefix)`

App-server specific routing:

- `on_app_server(normalized_method)`
- `on_app_server_request(normalized_method)`
- `on_turn_started()` (alias for `app_server.item.started`)

## Minimal async listener

```python
import asyncio
from codex_manager import AsyncCodexManager

async def main() -> None:
    async with AsyncCodexManager.from_profile("local") as cm:

        @cm.on_event("transcript_updated")
        async def on_transcript(event, _ctx):
            print("transcript update", event.thread_id)

        @cm.on_app_server("item.started")
        async def on_item_started(signal, _ctx):
            print("turn", signal.context.get("turnId"))

        @cm.on_app_server_request("item.tool.call")
        async def on_tool_request(signal, _ctx):
            print("tool call request", signal.request_id)

        await cm.stream.run_forever(thread_id="<session-id>")

asyncio.run(main())
```

## Sync listener

```python
from codex_manager import CodexManager

with CodexManager.from_profile("local") as cm:
    @cm.on_turn_started()
    def on_turn_started(event, _ctx):
        print("turn started", event.turn_id)

    cm.stream.run_forever(thread_id="<session-id>")
```

## Dynamic tool-call bridge pattern

Tool-call requests are emitted as `app_server.request.item.tool.call`.

Use remote-skill session helpers to dispatch and respond:

```python
import asyncio
from codex_manager import AsyncCodexManager

async def main() -> None:
    session_id = "<session-id>"
    async with AsyncCodexManager.from_profile("local") as cm:
        skills = cm.remote_skills.session(session_id)

        @skills.skill(description="Uppercase text")
        async def uppercase(text: str) -> str:
            return text.upper()

        @cm.on_app_server_request("item.tool.call")
        async def on_dynamic_tool_call(signal, _ctx):
            await skills.respond_to_signal(signal)

        await cm.stream.run_forever(thread_id=session_id)

asyncio.run(main())
```

## Hook decorators for REST operations

Hooks allow cross-cutting behavior around SDK request execution:

- `before(operation)`
- `after(operation)`
- `on_error(operation)`

`operation="*"` applies globally.

```python
from codex_manager import CodexManager

cm = CodexManager.from_profile("local")

@cm.before("sessions.send_message")
def add_metadata(call):
    if isinstance(call.json_body, dict):
        call.json_body.setdefault("metadata", {})

@cm.after("*")
def log_status(call, _response):
    print("completed", call.operation)
```

## Middleware object registration

For bundled hook behavior, register a middleware object:

```python
from codex_manager import CodexManager

class AuditMiddleware:
    def before(self, call):
        print("before", call.operation)

    def after(self, call, response):
        print("after", call.operation)

    def on_error(self, call, error):
        print("error", call.operation, error)

cm = CodexManager.from_profile("local")
cm.use_middleware(AuditMiddleware())
```

## Operational guidance

- keep handler side effects idempotent by stable ids (`threadId`, `turnId`, `requestId`)
- avoid heavy blocking work inside handlers; queue or offload expensive work
- for long-running async listeners, use `stop_event` for controlled shutdown
- combine realtime handlers with polling fallback when workflow reliability requires it

## Read Next (Level 3)

- Event routing and matcher semantics: [`streaming-event-routing-reference.md`](./streaming-event-routing-reference.md)
- Reconnect/backpressure reliability patterns: [`streaming-reliability-patterns.md`](./streaming-reliability-patterns.md)

## Related docs

- Remote-skill bridge and response routes: [`remote-skills.md`](./remote-skills.md)
- API domain map: [`api-surface.md`](./api-surface.md)
- Practical automation recipes: [`practical-recipes.md`](./practical-recipes.md)
