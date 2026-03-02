# Python Client Quickstart

## Prerequisites

- Python 3.11+
- Local codex-manager API running (`http://127.0.0.1:3001` by default)
- CLI profile configured (optional but recommended)

## Install package (editable)

```bash
pip install -e packages/python-client
```

## Python auth (optional)

Use this only when credentials are not already available from `CODEX_HOME/auth.json` or `OPENAI_API_KEY`.

Constructor selection for auth/header sourcing:

- `CodexManager.from_profile("local")` uses CLI profile config (`~/.config/codex-manager/cli/config.json`).
- `CodexManager.from_env()` uses `CODEX_MANAGER_*` environment overrides.

```python
from codex_manager import CodexManager

with CodexManager.from_profile("local") as cm:
    auth = cm.system.health()["auth"]
    if auth["likelyUnauthenticated"]:
        started = cm.account.login_start_chatgpt()
        print("Open this URL to complete login:", started["result"]["authUrl"])
        # Alternatives:
        # cm.account.login_start_api_key("sk-...")
        # cm.account.login_start_chatgpt_auth_tokens(
        #     access_token="<token>",
        #     chatgpt_account_id="<id>",
        #     chatgpt_plan_type="plus",
        # )
    else:
        print("Auth already available; no login call needed.")
```

## Minimal session request example (sync)

```python
from codex_manager import CodexManager

with CodexManager.from_profile("local") as cm:
    session = cm.sessions.create(cwd=".")
    reply = cm.wait.send_message_and_wait_reply(
        session_id=session["session"]["sessionId"],
        text="Give me a practical onboarding summary of this repository: its purpose, core components, and first commands to run.",
    )
    print(reply.assistant_reply)
```

## Minimal remote skill example (sync)

```python
from codex_manager import CodexManager

def register(skills):
    @skills.skill()
    def echo(text: str) -> str:
        """Echo text back verbatim.

        Args:
            text: Text to echo.
        """
        return text

with CodexManager.from_profile("local") as cm:
    with cm.remote_skills.lifecycle(register=register, cwd=".", approval_policy="never") as run:
        result = run.skills.send_and_handle(
            "Call echo with text='hello from remote skill', then reply with exactly that echoed text.",
            require_assistant_reply=True,
        )
        print(result.dispatches[0].result if result.dispatches else "tool not called")
        print(result.assistant_reply)
```

The SDK infers tool description and input schema from the function signature and docstring when explicit schema fields are omitted.

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
- Check turn status directly: `cm.wait.turn_status(...)`, `await acm.wait.turn_status(...)`
- Manage controls: `chat.controls.get()`, `chat.controls.apply(...)`
- Manage settings: `chat.settings.get()`, `chat.settings.set(...)`, `chat.settings.namespace("supervisor.fileChange")`
- Clean up sessions: `chat.delete()` or `cm.sessions.delete(session_id=...)`
- Register middleware objects: `cm.use_middleware(...)`
- Inject protocol components: `request_executor`, `header_provider`, `retry_policy`, `hook_registry`, `stream_router`, `plugins`

## Next

- For copy-paste recipes, open [`practical-recipes.md`](./practical-recipes.md)
- For a multi-agent team workflow without orchestrator jobs, open [`team-mesh.md`](./team-mesh.md)
- For endpoint/domain coverage, open [`api-surface.md`](./api-surface.md)
- For event handlers and decorators, open [`streaming-and-handlers.md`](./streaming-and-handlers.md)
- For dynamic tool-call bridging with Python handlers, open [`remote-skills.md`](./remote-skills.md)
- For protocol injection architecture and contracts, open [`protocol-interfaces.md`](./protocol-interfaces.md)
- For generated typed model architecture, operation coverage, and boundary validation behavior, open [`typed-models.md`](./typed-models.md)
