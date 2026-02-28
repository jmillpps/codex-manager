# Python Remote Skills

## Purpose

Run Python callables as dynamic tool handlers for Codex sessions through codex-manager, with session-scoped lifecycle and API-managed response delivery.

This is not a Python-only local loop: codex-manager now exposes dynamic tool-call request/response routes so handlers can respond through the service boundary.

## Server routes used

- `GET /api/sessions/:sessionId/tool-calls`
  - list pending dynamic tool-call requests for one session.
- `POST /api/tool-calls/:requestId/response`
  - submit tool-call output back to codex-manager, which replies to `codex app-server`.

Python wrappers:

- `cm.session(session_id).tool_calls.list()`
- `cm.tool_calls.respond(request_id=..., ...)`

## Remote skill lifecycle API

`client.remote_skills.session(session_id)` returns a session-scoped registry.

Core methods:

- `register(name, handler, description=..., input_schema=...)`
- `unregister(name)`
- `clear()`
- `instruction_text()` and `inject_request(text)`
- `send(text, inject_skills=True, ...)`
- `dispatch_app_server_signal(signal)` (local dispatch only)
- `respond_to_signal(signal)` (dispatch + API response submit)
- `using(...)` / `async using(...)` for auto cleanup

`respond_to_signal(...)` is the drop-in bridge for `app_server.request.item.tool.call`.

## Sync example

```python
from codex_manager import CodexManager

SESSION_ID = "<session-id>"

with CodexManager.from_profile("local") as cm:
    skills = cm.remote_skills.session(SESSION_ID)

    @skills.skill(
        description="Lookup ticket status by id",
        input_schema={"type": "object", "properties": {"ticket_id": {"type": "string"}}},
    )
    def lookup_ticket(ticket_id: str) -> dict[str, str]:
        return {"ticketId": ticket_id, "status": "open"}

    @cm.on_app_server_request("item.tool.call")
    def on_tool_call(signal, _ctx):
        # Executes registered Python handler and posts result to:
        # POST /api/tool-calls/{requestId}/response
        skills.respond_to_signal(signal)

    cm.stream.run_forever(thread_id=SESSION_ID)
```

## Async example with auto cleanup

```python
import asyncio
from codex_manager import AsyncCodexManager

SESSION_ID = "<session-id>"

async def main() -> None:
    async with AsyncCodexManager.from_profile("local") as cm:
        skills = cm.remote_skills.session(SESSION_ID)

        async def summarize_diff(diff_text: str) -> str:
            return f"Summary: {diff_text[:200]}"

        async with skills.using(
            "summarize_diff",
            summarize_diff,
            description="Summarize a unified diff",
            input_schema={"type": "object", "properties": {"diff_text": {"type": "string"}}},
        ):
            @cm.on_app_server_request("item.tool.call")
            async def on_tool_call(signal, _ctx):
                await skills.respond_to_signal(signal)

            await cm.stream.run_forever(thread_id=SESSION_ID)

asyncio.run(main())
```

## Notes

- `POST /api/tool-calls/:requestId/response` status outcomes:
  - `200` accepted
  - `404` request unknown/already resolved
  - `409` response already in flight (`code: "in_flight"`)
- `respond_to_signal(...)` ignores non-tool-call signals and returns `None`.
- `respond_to_signal(...)` marks dispatch failed (`handled=False`) when codex-manager rejects the response (for example conflict/not-found).
- `send(..., inject_skills=True)` can prepend the active skill catalog to your request for instruction-grounding.
