# Python Practical Recipes

## Purpose

Provide short, production-oriented patterns you can copy into real automation scripts without needing full framework setup.

## Recipe 1: Minimal ask-and-print flow

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

Use this as a baseline smoke test in CI jobs or local scripts.

## Recipe 2: Wait for a custom condition with generic polling

```python
from codex_manager import CodexManager

SESSION_ID = "<session-id>"
EXPECTED_TITLE = "Repository Risk Review"

with CodexManager.from_profile("local") as cm:
    # Set the target value we plan to observe.
    cm.sessions.rename(session_id=SESSION_ID, title=EXPECTED_TITLE)

    detail = cm.wait.until(
        lambda: cm.sessions.get(session_id=SESSION_ID),
        predicate=lambda payload: payload["session"]["title"] == EXPECTED_TITLE,
        timeout_seconds=30,
        interval_seconds=0.5,
        description=f"session title == {EXPECTED_TITLE!r}",
    )
    print("observed title:", detail["session"]["title"])
```

Use this when you need one reusable wait primitive for any API condition.

## Recipe 3: Auto-accept pending approvals for one session

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

## Recipe 4: Persist per-session supervisor settings

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

## Recipe 5: Typed mode for safer request/response handling

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

## Recipe 6: Event listener for turn starts

```python
import asyncio
from codex_manager import AsyncCodexManager

SESSION_ID = "<session-id>"

async def main() -> None:
    async with AsyncCodexManager.from_profile("local") as cm:
        @cm.on_app_server("item.started")
        async def _on_turn_started(signal, _ctx):
            print("turn started:", signal.context.get("turnId"))

        await cm.stream.run_forever(thread_id=SESSION_ID)

asyncio.run(main())
```

Use this as the minimal event-driven automation loop.

## Recipe 7: Dynamic tool-call bridge with auto cleanup

```python
import asyncio
from codex_manager import AsyncCodexManager

async def main() -> None:
    async with AsyncCodexManager.from_profile("local") as cm:
        def register(skills):
            @skills.skill(
                name="lookup_ticket",
                description="Lookup ticket state by id",
                input_schema={"type": "object", "properties": {"ticket_id": {"type": "string"}}},
            )
            async def lookup_ticket(ticket_id: str) -> dict[str, str]:
                return {"ticketId": ticket_id, "status": "open"}

        created, skills = await cm.remote_skills.create_session(register=register, cwd=".")
        session_id = created["session"]["sessionId"]

        @cm.on_app_server_request("item.tool.call")
        async def _on_tool_call(signal, _ctx):
            await skills.respond_to_signal(signal)

        await cm.stream.run_forever(thread_id=session_id)

asyncio.run(main())
```

Use this when you want a temporary Python handler lifecycle (`async with`) for one orchestration run.

## Recipe 8: Multi-agent team mesh without orchestrator jobs

Use the full runnable example:

```bash
PYTHONPATH=packages/python-client/src python packages/python-client/examples/team_mesh.py
```

This spins up `developer`/`docs`/`reviewer` sessions that coordinate through remote skills and shared Python team state.

## Related docs

- Quickstart: [`quickstart.md`](./quickstart.md)
- Team mesh walkthrough: [`team-mesh.md`](./team-mesh.md)
- Remote skill lifecycle/details: [`remote-skills.md`](./remote-skills.md)
- Event stream handler patterns: [`streaming-and-handlers.md`](./streaming-and-handlers.md)
