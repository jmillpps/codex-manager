# Python Remote Skill Lifecycle and Catalog Management

## Purpose

Detailed reference for how remote-skill catalogs are defined, bound to sessions, and cleaned up in the current Python SDK implementation.

Use with [`remote-skills.md`](./remote-skills.md) for end-to-end route flow and dispatch behavior.

## Lifecycle model

Remote-skill catalogs are create-time assets.

Primary entrypoints:

- `remote_skills.create_session(register=..., **session_create_kwargs)`
- `remote_skills.lifecycle(register=..., keep_session=False, **session_create_kwargs)`

Inside `register(...)`, you define the catalog on a draft session object. After the session is created, the returned session handle is bound and catalog mutation is locked.

Bound session behavior:

- `register(...)`, `unregister(...)`, and `clear(...)` on an existing session raise a create-time-only runtime error.
- `remote_skills.session(session_id)` returns a bound handle intended for dispatch/send operations, not catalog mutation.

## Register callback semantics

Sync facade:

- `RemoteSkillsFacade.create_session(...)` requires a sync register callback.
- If callback code returns an awaitable, the SDK raises `TypeError` and instructs using `AsyncCodexManager`.

Async facade:

- `AsyncRemoteSkillsFacade.create_session(...)` accepts sync or async register callbacks.

Registration surface inside callbacks:

- `register(name, handler, description=None, input_schema=None, output_schema=None)`
- `skill(...)` decorator with the same optional metadata fields
- when metadata is omitted, signature/docstring inference is applied before the catalog is bound

## Catalog payload contract

`dynamic_tools()` emits app-server-compatible tool definitions:

- `name`
- `description`
- `inputSchema`

`output_schema` and `output_description` are SDK-level instruction metadata. They are included in `instruction_text()` but not forwarded in dynamic-tool transport payloads.

## Instruction catalog behavior

- `instruction_text()` renders deterministic catalog text for prompt grounding.
- `inject_request(text)` prepends catalog instruction text.
- `send(..., inject_skills=True)` automatically injects both prompt instruction and `dynamic_tools` payload unless overridden.

## Cleanup and ownership

Use explicit lifecycle ownership when creating temporary sessions:

- `lifecycle(...)` returns `RemoteSkillLifecycle` / `AsyncRemoteSkillLifecycle` with:
  - `session_id`
  - `created`
  - `skills`

`close_session(session_id, ...)` clears in-memory registry state and optionally deletes the runtime session:

- `delete_session=False` keeps runtime session
- `delete_session=True` calls session delete route
- `deleted` in the returned cleanup payload is `True` only when delete response status indicates an actual deleted end state (`ok` or `deleted`)
- `sync_runtime_on_cleanup` is currently a compatibility parameter (no runtime-catalog sync is performed)

`lifecycle(...)` defaults to deleting the created session on exit unless `keep_session=True`.

## Unsupported runtime-catalog sync paths

The SDK intentionally disables runtime catalog mutation/sync paths for reliability:

- `sync_runtime()`
- `prepare_catalog()`
- `send_prepared(...)`
- facade-level `using(...)` / `async using(...)`

These methods raise runtime errors by design.

## Practical create-time pattern

```python
from codex_manager import CodexManager

with CodexManager.from_profile("local") as cm:
    def register(skills):
        @skills.skill(name="lookup_ticket")
        def lookup_ticket(ticket_id: str) -> dict[str, str]:
            """Lookup ticket status by id.

            Args:
                ticket_id: Stable ticket identifier.
            """
            return {"ticketId": ticket_id, "status": "open"}

    created, skills = cm.remote_skills.create_session(register=register, cwd=".")
    session_id = created["session"]["sessionId"]

    # catalog is now bound; use for sends/dispatch only
    result = skills.send_and_handle(
        "Use lookup_ticket for ABC-123 and summarize.",
        require_assistant_reply=True,
    )

    print(session_id)
    print(result.assistant_reply)
```

## Practical lifecycle pattern

```python
from codex_manager import CodexManager

with CodexManager.from_profile("local") as cm:
    def register(skills):
        @skills.skill(name="echo")
        def echo(text: str) -> str:
            return text

    with cm.remote_skills.lifecycle(register=register, cwd=".", keep_session=False) as run:
        reply = run.skills.send_and_handle(
            "Call echo with 'hello', then reply with the echoed value.",
            require_assistant_reply=True,
        )
        print(reply.assistant_reply)
```

## Operational guidance

- Treat remote-skill catalogs as immutable after session creation.
- Prefer `create_session(...)` or `lifecycle(...)` over `session(session_id)` for skill definition.
- Use `send_and_handle(...)` when you want one helper to send, dispatch pending tool calls, and wait for terminal status.
- Use stream-driven `respond_to_signal(...)` when operating long-lived listeners.

## Related docs

- Remote skills overview: [`remote-skills.md`](./remote-skills.md)
- Dispatch and reliability details: [`remote-skills-dispatch-and-reliability.md`](./remote-skills-dispatch-and-reliability.md)
- Streaming integration: [`streaming-and-handlers.md`](./streaming-and-handlers.md)
