# Python Practical Recipes

## Purpose

Provide short, production-oriented patterns you can copy into real automation scripts without needing full framework setup.

## Recipe 1: Create a chat, send a request, print IDs

```python
from codex_manager import CodexManager

with CodexManager.from_profile("local") as cm:
    session = cm.sessions.create(cwd="/path/to/workspace")
    session_id = session["session"]["sessionId"]

    accepted = cm.sessions.send_message(
        session_id=session_id,
        text="Summarize risky changes in this repository.",
    )

    print("session:", session_id)
    print("turn:", accepted["turnId"])
```

Use this as a baseline smoke test in CI jobs or local scripts.

## Recipe 2: Auto-accept pending approvals for one session

```python
from codex_manager import CodexManager

SESSION_ID = "<session-id>"

with CodexManager.from_profile("local") as cm:
    pending = cm.session(SESSION_ID).approvals.list()
    for approval in pending.get("data", []):
        cm.approvals.decide(
            approval_id=approval["approvalId"],
            decision="accept",
            scope="turn",
        )
```

Use this for controlled environments where approval policy is automated.

## Recipe 3: Persist per-session supervisor settings

```python
from codex_manager import CodexManager

SESSION_ID = "<session-id>"

with CodexManager.from_profile("local") as cm:
    cm.session(SESSION_ID).settings.namespace("supervisor.fileChange").merge({
        "diffExplainability": True,
        "autoActions": {
            "approve": {"enabled": False, "threshold": "low"},
            "reject": {"enabled": False, "threshold": "high"},
            "steer": {"enabled": False, "threshold": "high"},
        },
    })
```

Use this when UI, CLI, and extensions should share the same policy state.

## Recipe 4: Typed mode for safer request/response handling

```python
from codex_manager import CodexManager
from codex_manager.typed import CreateSessionRequest

with CodexManager(validation_mode="typed-only") as cm:
    created = cm.typed.sessions.create(
        CreateSessionRequest(cwd="/path/to/workspace", model="gpt-5")
    )
    print(created.session.session_id)
```

Use `validation_mode="strict"` when you also want selected dict-domain responses validated.

## Recipe 5: Event listener for turn starts

```python
import asyncio
from codex_manager import AsyncCodexManager

SESSION_ID = "<session-id>"

async def main() -> None:
    async with AsyncCodexManager.from_profile("local") as cm:
        @cm.on_turn_started()
        async def _on_turn_started(event, _ctx):
            print("turn started:", event.context.get("turnId"))

        await cm.stream.run_forever(thread_id=SESSION_ID)

asyncio.run(main())
```

Use this as the minimal event-driven automation loop.

## Recipe 6: Dynamic tool-call bridge with auto cleanup

```python
import asyncio
from codex_manager import AsyncCodexManager

SESSION_ID = "<session-id>"

async def main() -> None:
    async with AsyncCodexManager.from_profile("local") as cm:
        skills = cm.remote_skills.session(SESSION_ID)

        async def lookup_ticket(ticket_id: str) -> dict[str, str]:
            return {"ticketId": ticket_id, "status": "open"}

        async with skills.using(
            "lookup_ticket",
            lookup_ticket,
            description="Lookup ticket state by id",
            input_schema={"type": "object", "properties": {"ticket_id": {"type": "string"}}},
        ):
            @cm.on_app_server_request("item.tool.call")
            async def _on_tool_call(signal, _ctx):
                await skills.respond_to_signal(signal)

            await cm.stream.run_forever(thread_id=SESSION_ID)

asyncio.run(main())
```

Use this when you want a temporary Python handler lifecycle (`async with`) for one orchestration run.
