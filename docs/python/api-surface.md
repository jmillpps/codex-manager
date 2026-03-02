# Python Client API Surface

## Purpose

This guide summarizes client domain layout, typed facade posture, and high-value workflow entrypoints.

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
- `session.delete()` / `sessions.delete(session_id=...)` for explicit session cleanup
- `wait.until(...)` for generic poll+predicate synchronization
- `wait.turn_status(...)` for turn-status reads or expected-status waits
- `wait.assistant_reply(...)`
- `wait.send_message_and_wait_reply(...)`
- turn/suggestion wrappers expose structured non-2xx outcomes for operational handling (`400`, `403`, `404`, `409`, `410`, `429`, `503` where applicable)

## Remote skill and dynamic tool integration

- dynamic tools can be forwarded on session lifecycle/message calls
- `remote_skills.create_session(...)` and `remote_skills.lifecycle(...)` provide create-time catalog registration with bound dispatch helpers
- `remote_skills.session(session_id)` provides bound send/dispatch access for existing sessions

## Next References

- Domain reference details: [`api-surface-domain-reference.md`](./api-surface-domain-reference.md)
- Workflow snippets: [`api-surface-workflows.md`](./api-surface-workflows.md)
- Remote skills: [`remote-skills.md`](./remote-skills.md)

## Related docs

- Quickstart: [`quickstart.md`](./quickstart.md)
- Practical recipes: [`practical-recipes.md`](./practical-recipes.md)
- Typed model details: [`typed-models.md`](./typed-models.md)
