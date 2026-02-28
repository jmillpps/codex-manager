# Streaming and Handlers

## Stream entrypoint

- Sync client: `client.stream.run_forever(...)`
- Async client: `await client.stream.run_forever(...)`

Stream endpoint is codex-manager websocket route `/api/stream`.

The default stream router preserves registration-order dispatch with handler isolation.
Advanced integrations can inject a custom router via client constructor `stream_router=...`.

## Handler decorators

Register handlers with decorators:

```python
import asyncio
from codex_manager import AsyncCodexManager

async def main() -> None:
    async with AsyncCodexManager.from_profile("local") as cm:

        @cm.on_event("transcript_updated")
        async def on_transcript(event, ctx):
            print("transcript update", event.thread_id)

        @cm.on_event_prefix("app_server.item.")
        async def on_item_family(event, ctx):
            print("item event", event.type)

        @cm.on_app_server("item.started")
        async def on_turn_started(signal, ctx):
            print("new turn", signal.context.get("turnId"))

        @cm.on_app_server_request("tool.input.requested")
        async def on_server_request(signal, ctx):
            print("server request signal", signal.request_id)

        await cm.stream.run_forever(thread_id="<session-id>")

asyncio.run(main())
```

Supported shorthand:

- `on_event(event_type)`
- `on_event_prefix(prefix)`
- `on_app_server(normalized_method)`
- `on_app_server_request(normalized_method)`
- `on_turn_started()` (maps to `app_server.item.started`)

## Hook decorators for REST operations

Use request hooks for global/pattern behavior:

```python
from codex_manager import CodexManager

cm = CodexManager.from_profile("local")

@cm.before("sessions.send_message")
def add_actor(call):
    if isinstance(call.json_body, dict):
        call.json_body.setdefault("metadata", {})

@cm.after("*")
def log_status(call, response):
    print("done", call.operation)
```

Hook points:

- `before(operation)`
- `after(operation)`
- `on_error(operation)`

`operation="*"` applies globally.

Async clients also support async hook functions; sync clients require sync hook functions.

## Middleware objects

Instead of registering three separate hook decorators, you can register one middleware object:

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

## Practical stream pattern

Run a lightweight listener that reacts only to turn starts for one session:

```python
import asyncio
from codex_manager import AsyncCodexManager

async def main() -> None:
    stop = asyncio.Event()

    async with AsyncCodexManager.from_profile("local") as cm:
        @cm.on_turn_started()
        async def on_turn(_event, _ctx):
            print("new turn started")

        async def stop_later() -> None:
            await asyncio.sleep(30)
            stop.set()

        asyncio.create_task(stop_later())
        await cm.stream.run_forever(thread_id="<session-id>", stop_event=stop)

asyncio.run(main())
```
