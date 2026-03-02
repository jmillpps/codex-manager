# Operations Deep Dive: CLI Command Reference

## Purpose

Reference map for CLI command groups and their primary use.

Use with [`cli.md`](./cli.md) for explicit command-surface lookup.

## Global flags

Common flags:

- `--profile`
- `--base-url`
- `--api-prefix`
- `--timeout-ms`
- `--json`
- `--verbose`
- auth headers (`--bearer`, `--rbac-token`, `--role`, `--actor`, `--headers`)

## Command groups

System and discovery:

- `system`, `models`, `apps`, `skills`, `mcp`, `account`, `config`, `runtime`, `feedback`

Agent/queue operations:

- `agents extensions`
- `orchestrator jobs`

Project/session operations:

- `projects`
- `sessions`
- `approvals`
- `tool-input`
- `tool-calls`

Streaming/raw fallback:

- `stream events`
- `api request`

## Session-focused command highlights

- `sessions create|get|list|send`
- `sessions interrupt`
- `sessions approval-policy set`
- `sessions approvals list`
- `sessions tool-input list`
- `sessions tool-calls list`
- `sessions controls get|apply`
- `sessions settings get|set|unset`
- `sessions suggest-request run|enqueue|upsert`

Controls/settings payload notes:

- `sessions controls apply` updates `model`, `approvalPolicy`, `networkAccess`, `filesystemSandbox` on `session` or `default` scope.
- Settings updates support either single-key mode (`--key/--value`) or object mode (`--settings [--mode merge|replace]`).
- Default-scope writes can return `423` when defaults are lock-managed by environment policy.

Controls/settings status contracts:

- controls get: `200|403|404|410`
- controls apply: `200|400|403|404|410|423`
- settings get: `200|403|404|410`
- settings set: `200|400|403|404|410|423`
- settings unset: `200|403|404|410|423`

Turn/suggestion status contracts:

- sessions send: `202|400|403|404|410`
- sessions interrupt: `200|403|409|410`
- sessions approval-policy set: `200|403|404|410`
- sessions suggest-request run: `200|202|400|403|404|409|410|429`
- sessions suggest-request enqueue: `202|400|403|404|409|410|429`
- sessions suggest-request upsert: `200|400|403|404|410`

## Account/auth command highlights

- `account get`
- `account login start --type apiKey|chatgpt|chatgptAuthTokens`
- `account login cancel --login-id <id>`
- `account logout`
- `account rate-limits`

## Queue and extension highlights

- `orchestrator jobs list|get|wait|cancel`
- `agents extensions list|reload`
- `projects agent-sessions list`

## Related docs

- CLI runbook: [`cli.md`](./cli.md)
- CLI workflow playbooks: [`cli-workflow-playbooks.md`](./cli-workflow-playbooks.md)
- Setup and runtime baseline: [`setup-and-run.md`](./setup-and-run.md)
