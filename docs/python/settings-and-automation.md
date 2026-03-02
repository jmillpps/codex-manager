# Session Settings and Automation

## Purpose

Session settings are codex-manager's shared per-session state store for automation and policy.
The same values are visible to Web UI, API, CLI, extensions, and Python workflows.

## Data model and scope behavior

Settings are persisted inside the session controls tuple (`controls.settings`) alongside:

- `model`
- `approvalPolicy`
- `networkAccess`
- `filesystemSandbox`

Two scopes are available:

- `session`: only this session
- `default`: baseline for future/new sessions

Default-scope writes can be locked by `SESSION_DEFAULTS_LOCKED=true`. In that case, write attempts return `423 locked`.

## Write semantics

Codex-manager supports two mutation styles for `POST /api/sessions/:sessionId/settings`:

- object update: `{settings, mode}` where `mode` is `merge` (default) or `replace`
- single-key update: `{key, value}`

Rules:

- use either `{settings}` or `{key,value}`; never both
- `{key,value}` requires both fields
- `mode=replace` replaces the entire settings map for the target scope
- `mode=merge` preserves existing keys and updates only provided keys

`DELETE /api/sessions/:sessionId/settings/:key` removes one top-level key and returns `removed: true|false`.

`POST /api/sessions/:sessionId/session-controls` can include `controls.settings`. If `controls.settings` is omitted, codex-manager preserves existing settings for the selected scope.

All write routes support optional `actor` and `source` fields for audit provenance.

## Status behavior to handle

For settings and controls operations, handle these statuses as first-class outcomes:

- `200`: success or unchanged payload
- `400`: invalid request payload
- `403`: system-owned session (orchestrator worker session)
- `404`: session not found
- `410`: session deleted/purged
- `423`: default scope locked by harness configuration

## Python wrappers

Session-scoped wrapper (`chat = cm.session(session_id)`) exposes:

- `chat.controls.get()`
- `chat.controls.apply(controls=..., scope="session" | "default", actor=..., source=...)`
- `chat.settings.get(scope=..., key=...)`
- `chat.settings.set(scope=..., settings=..., mode="merge"|"replace", key=..., value=..., actor=..., source=...)`
- `chat.settings.unset(key, scope=..., actor=..., source=...)`
- `chat.settings.namespace("dot.path").get()/set()/merge()/unset()`

Namespace helpers only shape payload ergonomics in Python. Storage remains a top-level settings object in codex-manager.

## Practical examples

```python
from codex_manager import CodexManager

with CodexManager.from_profile("local") as cm:
    session_id = cm.sessions.create(cwd=".")["session"]["sessionId"]
    chat = cm.session(session_id)

    # Merge one top-level key.
    chat.settings.set(
        key="team",
        value={"definitionOfDone": "tests green + docs updated"},
        source="python-script",
    )

    # Namespace ergonomics for nested data.
    policy = chat.settings.namespace("team.review")
    policy.merge({"autoApprove": {"enabled": True, "threshold": "low"}})

    # Replace the full settings map for this session scope.
    chat.settings.set(
        settings={
            "team": {
                "definitionOfDone": "tests green + docs updated",
                "review": {"autoApprove": {"enabled": False, "threshold": "low"}},
            }
        },
        mode="replace",
        source="python-script",
    )

    # Read one key and remove it.
    print(chat.settings.get(key="team"))
    chat.settings.unset("team")
```

Apply controls while preserving settings:

```python
chat.controls.apply(
    controls={
        "model": None,
        "approvalPolicy": "on-request",
        "networkAccess": "restricted",
        "filesystemSandbox": "workspace-write",
        # Omit "settings" to preserve existing settings map.
    },
    scope="session",
    source="policy-update",
)
```

## Related docs

- Python introduction: [`introduction.md`](./introduction.md)
- API domain map: [`api-surface.md`](./api-surface.md)
- Streaming handlers: [`streaming-and-handlers.md`](./streaming-and-handlers.md)
- Remote skills: [`remote-skills.md`](./remote-skills.md)
