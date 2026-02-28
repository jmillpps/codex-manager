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
- `sessions approvals list`
- `sessions tool-input list`
- `sessions tool-calls list`
- `sessions settings get|set|unset`
- `sessions suggest-request enqueue|upsert`

## Queue and extension highlights

- `orchestrator jobs list|get|wait|cancel`
- `agents extensions list|reload`
- `projects agent-sessions list`

## Related docs

- CLI runbook: [`cli.md`](./cli.md)
- CLI workflow playbooks: [`cli-workflow-playbooks.md`](./cli-workflow-playbooks.md)
- Setup and runtime baseline: [`setup-and-run.md`](./setup-and-run.md)
