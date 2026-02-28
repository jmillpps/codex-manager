# Python Deep Dive: API Domain Reference

## Purpose

Detailed map of Python client domains and key wrappers.

Use with [`api-surface.md`](./api-surface.md) when locating exact wrapper families.

## Core domains

Both sync/async clients expose domains including:

- `system`, `models`, `apps`, `skills`, `mcp`, `account`, `config`, `runtime`, `feedback`
- `extensions`, `orchestrator`, `projects`, `sessions`
- `approvals`, `tool_input`, `tool_calls`
- `remote_skills`, `wait`, `raw`

## Session wrapper surface

`client.session(session_id)` supports:

- message send
- controls get/apply
- settings get/set/unset/namespace
- approvals/tool-input/tool-call list helpers
- lifecycle helpers (`get`, `rename`, `archive`, `resume`, `interrupt`, suggest-request)

## Dynamic tools and remote skills

Supported via:

- `sessions.create/resume/send_message(..., dynamic_tools=[...])`
- `remote_skills.session(...)`
- `remote_skills.create_session(...)`

## Typed facade coverage

Typed wrappers currently include high-value session/settings/suggest/approval/tool-input operations.

Unwrapped operations are explicitly tracked as raw in typed contracts.

## Related docs

- API surface index: [`api-surface.md`](./api-surface.md)
- Practical workflow recipes: [`practical-recipes.md`](./practical-recipes.md)
- Remote skills deep dive: [`remote-skills.md`](./remote-skills.md)
