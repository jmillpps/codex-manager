# Python API Domain Reference

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
- lifecycle helpers (`get`, `rename`, `archive`, `resume`, `interrupt`, `delete`, suggest-request)
- wait helpers via `client.wait` (`until`, `turn_status`, `assistant_reply`, `send_message_and_wait_reply`)

Controls/settings error handling:

- controls/settings wrappers surface structured responses for `403` (system-owned), `404` (not found), `410` (deleted), and `423` (default scope locked on writes).
- `settings_set` enforces mutually exclusive payload styles (`settings` object vs `key/value`) before request dispatch.

Turn/suggestion status handling:

- `send_message`, `interrupt`, `approval_policy`, and suggest-request wrappers include non-2xx operational statuses in wrapper-level allow-status contracts.
- system-owned session access is surfaced as `403` for these routes, matching API behavior.

## Dynamic tools and remote skills

Supported via:

- `sessions.create/resume/send_message(..., dynamic_tools=[...])`
- `remote_skills.create_session(...)`
- `remote_skills.lifecycle(...)`
- `remote_skills.session(...)` for bound send/dispatch use on existing sessions

Catalog mutation note:

- remote-skill catalog mutation is create-time only; register/unregister/clear are defined in create-session register callbacks.

## Account/auth wrappers

Account domain wrappers include:

- `account.get()`
- `account.login_start(...)`
- `account.login_start_api_key(...)`
- `account.login_start_chatgpt()`
- `account.login_start_chatgpt_auth_tokens(...)`
- `account.login_cancel(login_id=...)`
- `account.logout()`
- `account.rate_limits()`

## Typed facade coverage

Typed wrappers currently include high-value session/settings/suggest/approval/tool-input operations.

Unwrapped operations are explicitly tracked as raw in typed contracts.

## Related docs

- API surface index: [`api-surface.md`](./api-surface.md)
- Practical workflow recipes: [`practical-recipes.md`](./practical-recipes.md)
- Remote skills: [`remote-skills.md`](./remote-skills.md)
