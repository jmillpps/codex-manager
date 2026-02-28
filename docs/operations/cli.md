# Operations: CLI Runbook

## Purpose

This is the one-level CLI operations guide.

It covers how to invoke CLI surfaces, where command groups map, and where to find deeper command/workflow references.

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

## Quality and parity

- route bindings are explicitly declared
- CLI route parity tests guard drift from API registrations

## Read Next (Level 3)

- Command reference map: [`cli-command-reference.md`](./cli-command-reference.md)
- Workflow playbooks: [`cli-workflow-playbooks.md`](./cli-workflow-playbooks.md)

## Related runbooks

- Setup and run baseline: [`setup-and-run.md`](./setup-and-run.md)
- Troubleshooting: [`troubleshooting.md`](./troubleshooting.md)
- Queue framework: [`agent-queue-framework.md`](./agent-queue-framework.md)
