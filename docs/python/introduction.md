# Python Client Introduction

## Purpose

The codex-manager Python client is a control-plane SDK for codex-manager APIs and websocket events.

Use it when you need Python workflows to:

- create/read/update chats and projects
- control turns, approvals, and tool-input decisions
- read/write per-session settings used by UI and extensions
- subscribe to realtime events and app-server signal pass-through
- orchestrate queue/supervisor automation
- handle dynamic `item/tool/call` requests with Python remote-skill handlers through codex-manager routes

## Practical workflow categories

- script repeatable session tasks (create, message, inspect transcript)
- run approval/tool-input queues from service workers
- apply and read session settings used by UI and extensions
- host long-running stream listeners for automation triggers

## Install

From repository root:

```bash
pip install -e packages/python-client
```

## First use

```python
from codex_manager import CodexManager

cm = CodexManager.from_profile("local")
health = cm.system.health()
print(health["status"])
cm.close()
```

## Client types

- `CodexManager`: sync workflows
- `AsyncCodexManager`: async workflows, high-throughput event handling, long-running services

Both clients expose the same domain structure.

## Typed OpenAPI facade

Both clients also expose a typed facade:

- `cm.typed` for sync
- `acm.typed` for async

Typed methods use generated Pydantic models from OpenAPI and return typed responses for supported operations while keeping all existing dict-based domains unchanged.

## Advanced extension points

Both clients now support protocol-based dependency injection for advanced integrations:

- custom request executors (`request_executor`)
- dynamic header providers (`header_provider`)
- explicit retry policies (`retry_policy`, `retryable_operations`)
- custom hook registries (`hook_registry`)
- injectable stream routers (`stream_router`)
- deterministic client plugins (`plugins`)

Hook middleware objects can be registered directly with `use_middleware(...)` in addition to decorator hooks.

## Documentation map

- Quickstart: `docs/python/quickstart.md`
- Practical recipes: `docs/python/practical-recipes.md`
- API domain map: `docs/python/api-surface.md`
- Streaming + decorators + handlers: `docs/python/streaming-and-handlers.md`
- Remote-skill bridge: `docs/python/remote-skills.md`
- Session settings + automation patterns: `docs/python/settings-and-automation.md`
- Protocol-oriented implementation contract: `docs/python/protocol-interfaces.md`
- Typed model/facade + boundary validation implementation: `docs/python/typed-models.md`
- Development and packaging details: `docs/python/development-and-packaging.md`

## Recommended paths by use case

- "I want to automate chats quickly":
  - `docs/python/quickstart.md`
- "I want copy-paste production recipes":
  - `docs/python/practical-recipes.md`
- "I need event-driven workflows":
  - `docs/python/streaming-and-handlers.md`
- "I need dynamic tool calls backed by Python handlers":
  - `docs/python/remote-skills.md`
- "I need settings-driven supervisor automation":
  - `docs/python/settings-and-automation.md`
- "I want stronger typed request/response handling":
  - `docs/python/typed-models.md`
- "I want to tune typed/dict boundary validation behavior":
  - `docs/python/typed-models.md`
