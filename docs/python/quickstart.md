# Python Client Quickstart

## Prerequisites

- Python 3.11+
- Local codex-manager API running (`http://127.0.0.1:3001` by default)
- CLI profile configured (optional but recommended)

## Install package (editable)

```bash
pip install -e packages/python-client
```

## Basic sync example

```python
from codex_manager import CodexManager

with CodexManager.from_profile("local") as cm:
    session = cm.sessions.create(cwd=".")
    session_id = session["session"]["sessionId"]

    reply = cm.wait.send_message_and_wait_reply(
        session_id=session_id,
        text="Explain this repository.",
    )
    print(reply.assistant_reply)
```

## Basic async example

```python
import asyncio
from codex_manager import AsyncCodexManager

async def main() -> None:
    async with AsyncCodexManager.from_profile("local") as cm:
        session = await cm.sessions.create(cwd="/path/to/workspace")
        session_id = session["session"]["sessionId"]
        reply = await cm.wait.send_message_and_wait_reply(
            session_id=session_id,
            text="List the top 3 architecture components in this repository.",
            timeout_seconds=90,
            interval_seconds=1.0,
        )
        print("turn:", reply.turn_id)
        print("assistant:", reply.assistant_reply)

asyncio.run(main())
```

## Typed OpenAPI example

```python
from codex_manager import CodexManager
from codex_manager.typed import CreateSessionRequest, SendSessionMessageRequest

with CodexManager.from_profile("local") as cm:
    created = cm.typed.sessions.create(
        CreateSessionRequest(cwd="/path/to/workspace", model="gpt-5")
    )
    accepted = cm.typed.sessions.send_message(
        session_id=created.session.session_id,
        payload=SendSessionMessageRequest(text="Summarize recent API updates."),
    )

    print(created.session.title)
    print(accepted.turn_id)
```

## Validation mode example

```python
from codex_manager import CodexManager

with CodexManager(validation_mode="strict") as cm_strict:
    # strict adds dict-domain response validation for selected operations
    created = cm_strict.sessions.create(cwd="/path/to/workspace")
    print(created["session"]["sessionId"])

with CodexManager(validation_mode="off") as cm_off:
    # off mode returns raw payloads from typed facade
    raw_created = cm_off.typed.sessions.create(
        cwd="/path/to/workspace",
        validate=False,
    )
    print(raw_created["session"]["sessionId"])
```

## Fast path patterns

- Bind session scope once: `chat = cm.session(session_id)`
- Send messages: `chat.messages.send("...")`
- Wait for completion: `cm.wait.send_message_and_wait_reply(...)`, `await acm.wait.send_message_and_wait_reply(...)`
- Manage controls: `chat.controls.get()`, `chat.controls.apply(...)`
- Manage settings: `chat.settings.get()`, `chat.settings.set(...)`, `chat.settings.namespace("supervisor.fileChange")`
- Register middleware objects: `cm.use_middleware(...)`
- Inject protocol components: `request_executor`, `header_provider`, `retry_policy`, `hook_registry`, `stream_router`, `plugins`

## Next

- For copy-paste recipes, open `docs/python/practical-recipes.md`
- For a multi-agent team workflow without orchestrator jobs, open `docs/python/team-mesh.md`
- For endpoint/domain coverage, open `docs/python/api-surface.md`
- For event handlers and decorators, open `docs/python/streaming-and-handlers.md`
- For dynamic tool-call bridging with Python handlers, open `docs/python/remote-skills.md`
- For protocol injection architecture and contracts, open `docs/python/protocol-interfaces.md`
- For generated typed model architecture, operation coverage, and boundary validation behavior, open `docs/python/typed-models.md`
