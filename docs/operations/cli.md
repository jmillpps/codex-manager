# Operations: CLI Runbook

## Purpose

This document is the operator runbook for the Codex Manager CLI in `apps/cli`.

Use this runbook when you need scriptable access to the same API surface that the web client uses:

- session/project lifecycle
- approvals/tool-input decisions
- orchestrator queue visibility and control
- extension lifecycle operations
- stream inspection and raw fallback requests

## Package and invocation

The CLI package is `@repo/cli` and ships two binaries:

- `codex-manager`
- `cmgr`

For local development from repository root:

```bash
pnpm --filter @repo/cli dev system health
pnpm --filter @repo/cli dev sessions list
```

Build the distributable binary:

```bash
pnpm --filter @repo/cli build
./apps/cli/dist/main.js system health
```

## Global runtime options

Global flags apply to all command groups:

- `--profile <name>`
- `--base-url <url>`
- `--api-prefix <path>`
- `--timeout-ms <n>`
- `--json`
- `--verbose`
- `--bearer <token>`
- `--rbac-token <token>`
- `--role <role>`
- `--actor <id>`
- `--headers <key:value>` (repeatable)

Runtime context resolution order:

1. command flags
2. environment variables
3. selected profile in CLI config

Environment overrides:

- `CODEX_MANAGER_API_BASE`
- `CODEX_MANAGER_API_PREFIX`
- `CODEX_MANAGER_TIMEOUT_MS`
- `CODEX_MANAGER_BEARER_TOKEN`
- `CODEX_MANAGER_RBAC_TOKEN`
- `CODEX_MANAGER_RBAC_ROLE`
- `CODEX_MANAGER_RBAC_ACTOR`

## Profile management

Profiles are stored at:

- `$XDG_CONFIG_HOME/codex-manager/cli/config.json`
- fallback: `~/.config/codex-manager/cli/config.json`

Profile commands:

```bash
pnpm --filter @repo/cli dev profile list
pnpm --filter @repo/cli dev profile set local --base-url http://127.0.0.1:3001 --api-prefix /api
pnpm --filter @repo/cli dev profile auth-set local --bearer "$TOKEN"
pnpm --filter @repo/cli dev profile use local
```

## Command groups

The CLI is organized by endpoint domains:

- `system` (`info`, `health`, `capabilities`, `features list`, `collaboration-modes list`)
- `models` (`list`)
- `apps` (`list`)
- `skills` (`list`, `config set`, `remote get|set`)
- `mcp` (`servers list`, `reload`, `oauth login`)
- `account` (`get`, `login start|cancel`, `logout`, `rate-limits`)
- `config` (`get`, `requirements`, `set`, `batch-set`)
- `runtime` (`exec`)
- `feedback` (`submit`)
- `agents extensions` (`list`, `reload`)
- `orchestrator jobs` (`get`, `list`, `wait`, `cancel`)
- `projects` (`list`, `create`, `rename`, `delete`, `chats move-all|delete-all`)
- `sessions` (`list`, `create`, `get`, `send`, lifecycle/thread-actions, approvals/tool-input/transcript/suggest-request`)
- `approvals` (`decide`)
- `tool-input` (`decide`)
- `stream events` (websocket event stream)
- `api request` (raw fallback HTTP request)

Supervisor-oriented helper flags:

- `sessions transcript upsert` supports `--content` or `--content-file`, and `--details` or `--details-file`.
- `sessions steer` supports `--input` or `--input-file`.
- `sessions suggest-request upsert` supports `--suggestion` or `--suggestion-file` (suggestion required when `--status complete`).

## High-value workflows

### Session + message lifecycle

```bash
pnpm --filter @repo/cli dev sessions create --title "CLI test"
pnpm --filter @repo/cli dev sessions send --session-id <sessionId> --text "Summarize this project."
pnpm --filter @repo/cli dev sessions get --session-id <sessionId> --include-transcript true
```

### Decide pending approvals

```bash
pnpm --filter @repo/cli dev sessions approvals list --session-id <sessionId>
pnpm --filter @repo/cli dev approvals decide --approval-id <approvalId> --decision approve
```

### Suggest request and queue visibility

```bash
pnpm --filter @repo/cli dev sessions suggest-request enqueue --session-id <sessionId>
pnpm --filter @repo/cli dev sessions suggest-request upsert --session-id <sessionId> --request-key <requestKey> --status streaming
pnpm --filter @repo/cli dev sessions suggest-request upsert --session-id <sessionId> --request-key <requestKey> --status complete --suggestion "Draft one next request"
pnpm --filter @repo/cli dev orchestrator jobs list --project-id <projectId> --state running --limit 25
pnpm --filter @repo/cli dev orchestrator jobs wait --job-id <jobId> --timeout-ms 20000 --poll-ms 250
```

### Supervisor/extension lifecycle

```bash
pnpm --filter @repo/cli dev agents extensions list
pnpm --filter @repo/cli dev agents extensions reload --rbac-token "$RBAC_TOKEN" --role admin --actor operator
```

### Live stream inspection

```bash
pnpm --filter @repo/cli dev stream events --session-id <sessionId>
pnpm --filter @repo/cli dev stream events --project-id <projectId>
```

## Raw fallback

When a route is new or not yet modeled by a dedicated command, use:

```bash
pnpm --filter @repo/cli dev api request \
  --method POST \
  --path /api/sessions/<sessionId>/interrupt \
  --allow-status 200,409
```

`api request` is a direct escape hatch and should still use normal auth/profile controls.

## Output contracts

- Default mode prints status plus pretty response body.
- `--json` prints a machine-oriented envelope:
  - success: `{ ok: true, command, request, response }`
  - failure: `{ ok: false, command, error }`

This mode is intended for shell pipelines and CI checks.

## Route coverage and parity

CLI command-route bindings are declared in:

- `apps/cli/src/lib/route-coverage.ts`

Parity test compares CLI bindings against API route registrations in:

- `apps/cli/src/route-parity.test.ts`

Run:

```bash
pnpm --filter @repo/cli test
```

A parity mismatch is a release blocker for CLI coverage.
