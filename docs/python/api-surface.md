# Python Client API Surface

## Domain layout

Both `CodexManager` and `AsyncCodexManager` expose the same domains:

- `system`
- `models`
- `apps`
- `skills`
- `mcp`
- `account`
- `config`
- `runtime`
- `feedback`
- `extensions`
- `orchestrator`
- `projects`
- `sessions`
- `approvals`
- `tool_input`
- `tool_calls`
- `remote_skills`
- `raw`

## Typed facade

Both clients expose additive typed facades:

- `CodexManager.typed`
- `AsyncCodexManager.typed`

Typed wrappers currently cover:

- `sessions.create`
- `sessions.get`
- `sessions.send_message`
- `sessions.settings_get`
- `sessions.settings_set`
- `sessions.settings_unset`
- `sessions.suggest_request`
- `sessions.suggest_request_enqueue`
- `sessions.suggest_request_upsert`
- `approvals.decide`
- `tool_input.decide`

Validation behavior for typed wrappers is configurable by client `validation_mode`:

- `typed-only` (default)
- `off`
- `strict`

Strict mode also validates selected dict-domain responses while preserving dict return shapes.

Models are generated from OpenAPI components into `codex_manager.generated.openapi_models`.

Example:

```python
from codex_manager import CodexManager
from codex_manager.typed import CreateSessionRequest

with CodexManager.from_profile("local") as cm:
    created = cm.typed.sessions.create(CreateSessionRequest(cwd="/workspace"))
    detail = cm.typed.sessions.get(session_id=created.session.session_id)
    print(detail.session.title)
```

## Protocol extension points

Both clients accept optional constructor injection for advanced runtime behavior:

- `request_executor`
- `header_provider`
- `retry_policy`
- `retryable_operations`
- `hook_registry`
- `stream_router`
- `plugins`

These hooks are additive and do not change default behavior when omitted.

## Session-scoped wrapper

`client.session(session_id)` returns convenience helpers:

- `messages.send(...)`
- `controls.get()` / `controls.apply(...)`
- `settings.get()` / `settings.set()` / `settings.unset()` / `settings.namespace(...)`
- `approvals.list()`
- `tool_input.list()`
- `tool_calls.list()`
- `get()`, `rename()`, `archive()`, `unarchive()`, `resume()`, `interrupt()`, `suggest_request(...)`

## Route coverage

The client includes:

- OpenAPI-backed routes under `/api/*` (including queue/orchestrator, extension lifecycle, settings, and websocket stream path metadata).
- API-level route parity tests enforce method/path alignment between `apps/api/src/index.ts` and `apps/api/openapi/openapi.json`.
- Typed operation coverage is explicit in `codex_manager.typed.contracts`:
  - `TYPED_OPERATION_IDS`: operations with typed wrappers
  - `RAW_OPERATION_IDS`: operations intentionally not wrapped yet
  - `ALL_OPENAPI_OPERATION_IDS`: authoritative OpenAPI operation-id set tracked by tests

## Raw escape hatch

Use `raw.request(...)` when API adds a route before SDK adds a dedicated wrapper:

```python
payload = cm.raw.request("POST", "/api/sessions/<id>/interrupt")
```

If path starts with `/api`, client normalizes it automatically.

## Middleware helper

In addition to decorator hooks (`before`, `after`, `on_error`), both clients expose:

- `use_middleware(middleware, operation="*")`

Middleware objects must provide `before(call)`, `after(call, response)`, and `on_error(call, error)`.

## Practical workflow snippets

### Resolve pending approvals for one session

```python
pending = cm.session(session_id).approvals.list()
for approval in pending.get("data", []):
    cm.approvals.decide(
        approval_id=approval["approvalId"],
        decision="accept",
        scope="turn",
    )
```

### Inspect and decide tool-input requests

```python
requests = cm.session(session_id).tool_input.list()
for req in requests.get("data", []):
    cm.tool_input.decide(
        request_id=req["requestId"],
        decision="decline",
        response={"note": "automation policy: manual review required"},
    )
```

### Inspect and respond to dynamic tool calls

```python
pending = cm.session(session_id).tool_calls.list()
for req in pending.get("data", []):
    cm.tool_calls.respond(
        request_id=req["requestId"],
        text=f"Handled tool {req['tool']}",
        success=True,
    )
```

### Session-scoped remote-skill bridge

Use the built-in wrapper for registration, instruction injection, and signal response:

- `cm.remote_skills.session(session_id)`
- `acm.remote_skills.session(session_id)`

See `docs/python/remote-skills.md` for end-to-end examples with `app_server.request.item.tool.call`.
