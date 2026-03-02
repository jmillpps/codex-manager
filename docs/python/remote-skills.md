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

`client.remote_skills.session(session_id)` returns a bound session registry for:

- dynamic tool payload generation
- helper send methods with optional catalog injection
- signal/pending-call dispatch and response submission

Catalog mutation (`register`, `unregister`, `clear`) is create-time only.

Define skill catalogs during session creation:

- `client.remote_skills.create_session(register=..., **session_create_kwargs)`
- `client.remote_skills.lifecycle(register=..., **session_create_kwargs)`

Use this for first-turn tool availability reliability.

## Core methods

Catalog and lifecycle:

- `create_session(register=..., **session_create_kwargs)` / `async create_session(...)`
- `lifecycle(register=..., keep_session=False, **session_create_kwargs)` / `async lifecycle(...)`
- `close_session(session_id, delete_session=False, ...)` / `async close_session(...)`
- `dynamic_tools()`
- `instruction_text()`
- `inject_request(text)`

Send helpers:

- `send(text, inject_skills=True, ...)`
- `send_and_handle(text, inject_skills=True, ...)`

Dispatch and response helpers:

- `matches_signal(signal)`
- `respond_to_signal(signal)`
- `respond_to_pending_call(call)`
- `drain_pending_calls()`
- `reset_dispatch_mode()`

Draft-only registration helpers (inside `create_session(register=...)` or `lifecycle(register=...)`):

- `register(name, handler, description=None, input_schema=None, output_schema=None)`
- `skill(...)` decorator
- `unregister(name)`
- `clear()`

Unsupported runtime-catalog mutation/sync paths intentionally raise runtime errors:

- `sync_runtime()`
- `prepare_catalog()`
- `send_prepared(...)`
- facade `using(...)` / `async using(...)`

Result handles:

- `lifecycle(...)` yields `RemoteSkillLifecycle` / `AsyncRemoteSkillLifecycle`
- `send_and_handle(...)` returns `RemoteSkillSendResult`
- per-dispatch records use `RemoteSkillDispatch`
- `close_session(..., delete_session=True)` returns `deleted=True` only when delete response status indicates a deleted end state (`ok` or `deleted`)

## Schema inference

When `input_schema` is omitted, the SDK builds a JSON schema from the handler signature:

- parameter names become `properties`
- required parameters (no default) become `required`
- type hints map to JSON-schema types (`str`, `int`, `bool`, `list[...]`, unions/optionals, `Literal[...]`)
- custom object hints are expanded when they expose structure (`TypedDict`, dataclass, Pydantic models, constructor signatures, or class annotations)
- forward-reference string annotations are resolved from class/module namespaces when available
- nested class aliases used in forward refs (for example `owner: "Owner"` with `Owner = ...` on the class) are resolved
- `TypedDict` keys annotated with `Required[...]` / `NotRequired[...]` are reflected in both property type mapping and required-key calculation
- Google-style docstrings (`Args:`) populate missing property descriptions and schema description

When `description` is omitted, the SDK uses the docstring summary as the tool description.
If no summary is available, it falls back to `Remote skill <name>`.

Return contracts are inferred from the function return annotation and docstring `Returns:` block, then surfaced in injected instruction catalog text as `output_schema` and `output_description`. This improves tool-call reliability for agents even though app-server dynamic tool payloads only include `name`, `description`, and `inputSchema`.
`Returns:` metadata is never merged into `inputSchema`; input and output contracts stay separate.

You can still provide `description`, `input_schema`, and `output_schema` explicitly when you need strict/manual schema control.
When `input_schema` is provided explicitly, undeclared properties are not injected from docstrings.

## Sync example

```python
from codex_manager import CodexManager

with CodexManager.from_profile("local") as cm:
    def register(skills):
        @skills.skill(
            name="lookup_ticket",
        )
        def lookup_ticket(ticket_id: str) -> dict[str, str]:
            """Lookup ticket status by id.

            Args:
                ticket_id: Stable ticket identifier.
            """
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
            )
            async def summarize_diff(diff_text: str) -> str:
                """Summarize a unified diff.

                Args:
                    diff_text: Unified diff text.
                """
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
- ignored non-tool-call signals do not lock dispatch mode.
- `drain_pending_calls()` remains mode-neutral when no actionable pending calls are returned.
- response submit retries default to `max_submit_attempts=3`, `retry_delay_seconds=0.05`.
- `404 not_found` and `409 in_flight` are treated as idempotent completion outcomes in dispatch metadata.
- `drain_pending_calls()` is a websocket-independent fallback for delayed stream windows.
- dispatch mode is exclusive per session object (`signal` vs `polling`) until `reset_dispatch_mode()` is called.
- `send_and_handle(...)` uses polling dispatch mode and waits for terminal turn status via `wait.turn_status(...)`.
- `terminal_statuses` in `send_and_handle(...)` accepts a single string or an iterable of status strings.
- handled request-id dedupe cache is bounded and trimmed while preserving immediate duplicate protection for the latest handled request id.

## Status outcomes from response route

Typical outcomes:

- `200` accepted
- `404` unknown/already resolved request
- `409` response already in flight (`code: "in_flight"`)
- `500` upstream/runtime response submit failure

## Next References

- Lifecycle and catalog strategy: [`remote-skills-lifecycle-and-catalog.md`](./remote-skills-lifecycle-and-catalog.md)
- Dispatch/retry/idempotency details: [`remote-skills-dispatch-and-reliability.md`](./remote-skills-dispatch-and-reliability.md)

## Related docs

- Streaming decorators and listener reliability: [`streaming-and-handlers.md`](./streaming-and-handlers.md)
- Multi-session collaboration pattern: [`team-mesh.md`](./team-mesh.md)
- Python API surface map: [`api-surface.md`](./api-surface.md)
