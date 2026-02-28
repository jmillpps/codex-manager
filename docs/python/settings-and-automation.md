# Session Settings and Automation

## Why settings matter

Codex-manager session settings are generic key/value storage per session or default scope.

They are shared across:

- web UI controls
- API/CLI scripts
- extension runtime logic

Python client exposes these settings directly.

## Basic settings operations

```python
from codex_manager import CodexManager

cm = CodexManager.from_profile("local")
chat = cm.session("<session-id>")

# Read all session-scoped settings
all_settings = chat.settings.get(scope="session")

# Set one top-level key
chat.settings.set(key="supervisor", value={"fileChange": {"diffExplainability": True}})

# Remove one top-level key
chat.settings.unset("supervisor")

cm.close()
```

## Namespace helper

Use nested namespace shorthand for targeted reads/writes:

```python
policy = chat.settings.namespace("supervisor.fileChange")
current = policy.get()
policy.merge({
    "autoActions": {
        "approve": {"enabled": False, "threshold": "low"},
        "reject": {"enabled": False, "threshold": "high"},
        "steer": {"enabled": False, "threshold": "high"}
    }
})
```

## Approval and turn automation

```python
pending = chat.approvals.list()
for row in pending.get("data", []):
    cm.approvals.decide(
        approval_id=row["approvalId"],
        decision="accept",
        scope="turn",
    )
```

Pair this with stream handlers to create policy-driven workflows.

## Practical settings patterns

Assume an active client such as `cm = CodexManager.from_profile("local")`.

### Set global defaults once, then override per session

```python
chat = cm.session("<session-id>")

# default scope baseline for future sessions
chat.settings.set(
    scope="default",
    key="supervisor",
    value={"fileChange": {"diffExplainability": True}},
)

# one-session override
chat.settings.namespace("supervisor.fileChange").merge({
    "autoActions": {"approve": {"enabled": True, "threshold": "low"}}
})
```

### Read one flag safely inside automation

```python
chat = cm.session("<session-id>")

file_change = chat.settings.namespace("supervisor.fileChange").get() or {}
auto = (file_change.get("autoActions") or {}).get("approve") or {}
enabled = bool(auto.get("enabled"))
threshold = auto.get("threshold", "low")
```

### End-to-end approval worker loop (practical baseline)

```python
import asyncio
from codex_manager import AsyncCodexManager

async def run_worker(session_id: str) -> None:
    async with AsyncCodexManager.from_profile("local") as cm:
        chat = cm.session(session_id)
        policy = chat.settings.namespace("supervisor.fileChange").get() or {}
        auto = (policy.get("autoActions") or {}).get("approve") or {}

        if not auto.get("enabled"):
            return

        pending = await chat.approvals.list()
        for item in pending.get("data", []):
            await cm.approvals.decide(
                approval_id=item["approvalId"],
                decision="accept",
                scope="turn",
            )

asyncio.run(run_worker("<session-id>"))
```
