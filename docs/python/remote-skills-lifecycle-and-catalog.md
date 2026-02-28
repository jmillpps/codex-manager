# Python Deep Dive: Remote Skill Lifecycle and Catalog Management

## Purpose

Detailed reference for remote-skill registration lifecycle, catalog injection, and runtime synchronization.

Use with [`remote-skills.md`](./remote-skills.md) when building stable tool catalogs across session creation and turn execution.

## Session-Scoped Registry Model

`client.remote_skills.session(session_id)` returns a session-scoped registry object.

Registry responsibilities:

- hold Python tool handlers for one session
- build `dynamic_tools` payloads from registered skills
- generate instruction text that describes available skills
- submit responses for tool-call requests when invoked

## Registration APIs

Core operations:

- `register(name, handler, description=..., input_schema=...)`
- `skill(...)` decorator
- `unregister(name)`
- `clear()`
- `list()`

Name behavior:

- names are normalized for internal lookup consistency
- registration overwrites existing skill with same normalized name

## Catalog Payload Construction

`dynamic_tools()` produces app-server compatible tool definitions:

- `name`
- `description`
- `inputSchema`

If `input_schema` is omitted, a permissive object schema is generated.

## Instruction Catalog Text

`instruction_text()` renders a deterministic text block describing registered skills and schemas.

`inject_request(text)` prepends catalog instructions to user text.

Use this only when you explicitly want prompt-grounding in addition to tool registration.

## First-Turn Reliability Pattern

Preferred path:

- use `remote_skills.create_session(register=..., **kwargs)`

This creates a new session and includes `dynamic_tools` at session creation, which avoids first-turn gaps where catalog sync has not happened yet.

## Runtime Sync Paths

- `sync_runtime()` pushes current catalog through session resume route
- `prepare_catalog()` ensures catalog is present before next send
- `send_prepared(...)` runs `prepare_catalog()` then sends message

`prepare_catalog()` includes fallback behavior for unmaterialized sessions:

- sends a lightweight bootstrap message when needed
- waits for reply
- best-effort rollback to remove bootstrap turn
- retries resume with dynamic tools

## Context-Managed Skill Windows

For temporary capability windows:

```python
with skills.using(
    "lookup_ticket",
    handler=lookup_ticket,
    description="Lookup ticket status",
    input_schema={"type": "object", "properties": {"ticket_id": {"type": "string"}}},
):
    skills.send_prepared("Check ticket ABC-123")
# lookup_ticket automatically unregistered here
```

Async equivalent:

```python
async with skills.using(...):
    await skills.send_prepared("...")
```

## Lifecycle Guidance

- register skills before starting stream listener or before first `send_prepared`
- call `sync_runtime()` after significant register/unregister changes if next turn timing is critical
- keep skill schemas stable and minimal to improve model/tool selection consistency

## Related docs

- Remote skills overview: [`remote-skills.md`](./remote-skills.md)
- Dispatch and response reliability: [`remote-skills-dispatch-and-reliability.md`](./remote-skills-dispatch-and-reliability.md)
- Streaming integration: [`streaming-and-handlers.md`](./streaming-and-handlers.md)
