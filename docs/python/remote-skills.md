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

`client.remote_skills.create_session(register=..., **session_create_kwargs)` creates a new session and injects the registered skill catalog as `dynamic_tools` at create time.
- Sync client expects `register` to be a synchronous callback.
- Async client accepts either a synchronous or `async` register callback.

Core methods:

- `register(name, handler, description=..., input_schema=...)`
- `unregister(name)`
- `clear()`
- `dynamic_tools()` (current dynamic tool catalog payload)
- `sync_runtime()` (push current dynamic tools via `sessions.resume`)
- `prepare_catalog()` (best-effort runtime catalog sync; includes bootstrap fallback for unmaterialized sessions)
- `instruction_text()` and `inject_request(text)`
- `send(text, inject_skills=True, ...)`
- `send_prepared(text, inject_skills=True, ...)` (`prepare_catalog()` + `send(...)`)
- `dispatch_app_server_signal(signal)` (local dispatch only)
- `matches_signal(signal)` (session-aware signal guard)
- `respond_to_signal(signal)` (dispatch + API response submit)
- `respond_to_pending_call(call)` (dispatch + API response from a pending REST record)
- `drain_pending_calls()` (list + resolve all pending calls for the session)
- `using(...)` / `async using(...)` for auto cleanup

`respond_to_signal(...)` is the drop-in bridge for `app_server.request.item.tool.call`.

`send(...)` automatically includes `dynamic_tools=[...]` built from currently registered skills unless you override `dynamic_tools` explicitly.

For first-turn reliability, prefer `remote_skills.create_session(...)` so tools are present during session creation. App-server accepts `dynamicTools` on additional lifecycle calls, but first-turn tool-call behavior is most reliable when catalog is set at create.

## Sync example

```python
from codex_manager import CodexManager

SESSION_ID = "<session-id>"

with CodexManager.from_env() as cm:
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
        # Executes registered Python handler and posts result to:
        # POST /api/tool-calls/{requestId}/response
        skills.respond_to_signal(signal)

    cm.stream.run_forever(thread_id=session_id)
```

## Async example with auto cleanup

```python
import asyncio
from codex_manager import AsyncCodexManager

SESSION_ID = "<session-id>"

async def main() -> None:
    async with AsyncCodexManager.from_env() as cm:
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

## Notes

- `POST /api/tool-calls/:requestId/response` status outcomes:
  - `200` accepted
  - `404` request unknown/already resolved
  - `409` response already in flight (`code: "in_flight"`)
  - `500` upstream/runtime submission failed (`status: "error"`)
- `respond_to_signal(...)` ignores non-tool-call signals and returns `None`.
- `respond_to_signal(...)` / `respond_to_pending_call(...)` are session-aware and return `None` for mismatched session payloads.
- `respond_to_pending_call(...)` accepts one pending `sessions.tool_calls.list()` row and submits a response.
- `drain_pending_calls()` is a websocket-independent reliability fallback for handling queued tool calls.
- `drain_pending_calls()` treats deleted/system-owned session payloads as empty and raises `ValueError` for malformed `sessions.tool_calls.list()` payloads missing `data`.
- response submission is retried by default (`max_submit_attempts=3`, `retry_delay_seconds=0.05`) for transient failures.
  - set `retry_delay_seconds=0` for immediate retry attempts without backoff sleep.
- duplicate/late response states (`404 not_found`, `409 in_flight`) are treated as idempotent success and surfaced in dispatch metadata (`submission_status`, `submission_idempotent`).
- `send(..., inject_skills=True)` can prepend the active skill catalog to your request for instruction-grounding.
- dynamic tools always include an `inputSchema`; if you omit `input_schema` at registration, a permissive object schema is generated.
- `sync_runtime()` is useful after register/unregister/clear when you want to update runtime tool availability before the next send.
- For a full multi-session team coordination pattern, see `docs/python/team-mesh.md`.
