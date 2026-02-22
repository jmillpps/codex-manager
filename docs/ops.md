# Operations Manual Index

## Purpose

This is the entrypoint for local development and operational runbooks.

The operations manual was split into focused documents to keep setup, validation, troubleshooting, and maintenance concerns separate.

## Operations knowledge tree

- `docs/operations/setup-and-run.md`
  - Prerequisites, environment setup, running API/web, Codex supervision behavior, and MCP runtime operations.
- `docs/operations/api-service-supervision.md`
  - Always-on API supervision with user-level systemd (`Restart=always`), install/enable commands, and recovery steps.
- `docs/operations/generation-and-validation.md`
  - OpenAPI/client generation, protocol schema generation, typecheck/build/test commands, and pre-PR gates.
- `docs/operations/troubleshooting.md`
  - Logs, failure modes, and concrete recovery playbooks.
- `docs/operations/agent-queue-troubleshooting.md`
  - Queue-worker troubleshooting for system-owned agents (job states, retries, stuck/timeout recovery, tuning).
- `docs/operations/agent-extension-authoring.md`
  - Implementation runbook for `agents/*/events.(ts|js|mjs)` subscriptions, queue enqueue patterns, and instruction contracts.
- `docs/operations/agent-queue-framework.md`
  - End-to-end queue framework contract (invariants, runtime model, event payloads, job schemas, transcript contracts, retry/recovery).
- `docs/operations/maintenance.md`
  - Safe reset flows, git workflow rules, CI expectations, and operational invariants.
- `docs/implementation-status.md`
  - Current code-level feature coverage and user-visible API/workflow semantics.

## Fast-path commands

- Install deps: `pnpm install`
- Start dev stack (API + web): `pnpm dev`
- Install always-on API service: `./scripts/install-api-user-service.sh`
- Regenerate API contracts: `pnpm gen`
- Run workspace tests: `pnpm test`
- Typecheck all workspaces: `pnpm typecheck`
- Build all workspaces: `pnpm build`
- Runtime smoke (API + WebSocket lifecycle): `pnpm smoke:runtime`
- Browser smoke/e2e: `pnpm test:e2e`

## Current validation posture

- Compile/build validation is active (`typecheck`, `build`).
- Runtime smoke validation is active (`smoke:runtime`) and exercises core session/project/message/thread-control flows.
- Workspace tests are active (`pnpm test`) with API contract/runtime harness, web integration tests, and API-client compile checks.
- Browser-level Playwright smoke is active (`pnpm test:e2e`) via a wrapper that bootstraps missing Linux shared libraries into `.data/playwright-libs` when possible; see `docs/operations/troubleshooting.md` for edge cases.
- Lint commands are still placeholders in workspace packages and should be replaced with enforceable lint rules.

## Updating operations docs

When operational behavior changes:

1. Update the focused operations document containing that behavior.
2. Keep command examples synchronized with `package.json` scripts.
3. Keep this index updated if document boundaries or file names change.
