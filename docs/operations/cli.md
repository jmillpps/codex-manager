# Operations: CLI Runbook

## Purpose

This guide covers CLI invocation, runtime/auth resolution, and high-value command workflows used by operators.

## Package and invocation

CLI package: `@repo/cli`

Binaries:

- `codex-manager`
- `cmgr`

Local dev examples:

```bash
pnpm --filter @repo/cli dev system health
pnpm --filter @repo/cli dev sessions list
```

## Runtime option model

Global controls include profile/base URL/api prefix/timeouts and auth headers.

Resolution order:

1. explicit flags
2. env overrides
3. selected profile config

Auth-header mapping in requests:

- bearer token -> `Authorization: Bearer <token>`
- RBAC header token -> `x-codex-rbac-token`
- RBAC role -> `x-codex-role`
- RBAC actor -> `x-codex-actor`

Auth env overrides used by the CLI:

- `CODEX_MANAGER_BEARER_TOKEN`
- `CODEX_MANAGER_RBAC_TOKEN`
- `CODEX_MANAGER_RBAC_ROLE`
- `CODEX_MANAGER_RBAC_ACTOR`

## Profile management

Profiles live under user config path (`~/.config/codex-manager/cli/config.json` fallback behavior).

Common commands:

```bash
pnpm --filter @repo/cli dev profile list
pnpm --filter @repo/cli dev profile set local --base-url http://127.0.0.1:3001 --api-prefix /api
pnpm --filter @repo/cli dev profile use local
```

## Command-surface summary

CLI covers system/discovery, projects/sessions, approvals/tool-input/tool-calls, stream, extension lifecycle, and orchestrator jobs.

Use raw fallback only when a first-class command is not yet available.

Account/auth command family:

```bash
pnpm --filter @repo/cli dev account get
pnpm --filter @repo/cli dev account login start --type chatgpt
pnpm --filter @repo/cli dev account login start --type apiKey --api-key "$OPENAI_API_KEY"
pnpm --filter @repo/cli dev account login start --type chatgptAuthTokens --access-token "<token>" --chatgpt-account-id "<id>" --chatgpt-plan-type "<plan>"
pnpm --filter @repo/cli dev account login cancel --login-id "<id>"
pnpm --filter @repo/cli dev account logout
pnpm --filter @repo/cli dev account rate-limits
```

## Session controls and settings workflows

Session controls command family:

- `sessions controls get --session-id <id>`
- `sessions controls apply --session-id <id> --scope session|default --approval-policy ... --network-access ... --filesystem-sandbox ... [--model ...|--inherit-model] [--actor ...] [--source ...]`

Session settings command family:

- `sessions settings get --session-id <id> [--scope session|default] [--key <top-level-key>]`
- `sessions settings set --session-id <id> --scope session|default` with either:
  - `--key <key> --value <json-or-string>` (or `--value-file`)
  - `--settings <json-object>` (or `--settings-file`) plus optional `--mode merge|replace`
- `sessions settings unset --session-id <id> --scope session|default --key <top-level-key>`

Status behavior for controls/settings commands:

- `200`: successful or unchanged update/read
- `400`: invalid payload shape
- `403`: system-owned session
- `404`: session not found
- `410`: deleted session
- `423`: default scope locked (`SESSION_DEFAULTS_LOCKED=true`)

Write commands accept optional `--actor` and `--source` fields for audit provenance.

## Turn and suggestion status behavior

Session turn and suggestion commands return structured non-2xx statuses as normal outcomes:

- `sessions send`: `202|400|403|404|410`
- `sessions interrupt`: `200|403|409|410`
- `sessions approval-policy set`: `200|403|404|410`
- `sessions suggest-request run`: `200|202|400|403|404|409|410|429`
- `sessions suggest-request enqueue`: `202|400|403|404|409|410|429`
- `sessions suggest-request upsert`: `200|400|403|404|410`

`403` indicates system-owned orchestrator sessions; operators should run these commands only on user sessions.

## Quality and parity

- route bindings are explicitly declared
- CLI route parity tests guard drift from API registrations

## Read next

- Command reference map: [`cli-command-reference.md`](./cli-command-reference.md)
- Workflow playbooks: [`cli-workflow-playbooks.md`](./cli-workflow-playbooks.md)

## Related runbooks

- Setup and run baseline: [`setup-and-run.md`](./setup-and-run.md)
- Troubleshooting: [`troubleshooting.md`](./troubleshooting.md)
- Queue framework: [`agent-queue-framework.md`](./agent-queue-framework.md)
