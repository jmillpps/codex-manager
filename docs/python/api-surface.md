# Python Client API Surface

## Purpose

This is the one-level API surface guide for the Python SDK.

It summarizes client domain layout, typed facade posture, and high-value workflow entrypoints.

## Client layout summary

Both `CodexManager` and `AsyncCodexManager` expose consistent domain wrappers for system, sessions/projects, decisions, queue/extension lifecycle, runtime stream operations, and raw fallback access.

## Typed facade summary

Additive typed facade is available on both clients:

- `cm.typed`
- `acm.typed`

Validation mode controls:

- `typed-only`
- `off`
- `strict`

## Protocol extension points

Optional constructor injection supports advanced integrations:

- request executor
- header provider
- retry policy
- hook registry
- stream router
- plugins

## Session and wait ergonomics

- `client.session(session_id)` for scoped operations
- `wait.until(...)` for generic poll+predicate synchronization
- `wait.assistant_reply(...)`
- `wait.send_message_and_wait_reply(...)`

## Remote skill and dynamic tool integration

- dynamic tools can be forwarded on session lifecycle/message calls
- `remote_skills` helpers provide session-scoped tool registry and response routing

## Read Next (Level 3)

- Domain reference details: [`api-surface-domain-reference.md`](./api-surface-domain-reference.md)
- Workflow snippets: [`api-surface-workflows.md`](./api-surface-workflows.md)
- Remote skills: [`remote-skills.md`](./remote-skills.md)

## Related docs

- Quickstart: [`quickstart.md`](./quickstart.md)
- Practical recipes: [`practical-recipes.md`](./practical-recipes.md)
- Typed model details: [`typed-models.md`](./typed-models.md)
