# Operations Manual Index

## Purpose

This is the entrypoint for local development and operational runbooks.

The operations manual was split into focused documents to keep setup, validation, troubleshooting, and maintenance concerns separate.

## Operations knowledge tree

- `docs/operations/setup-and-run.md`
  - Prerequisites, environment setup, running API/web, Codex supervision behavior, and MCP runtime operations.
- `docs/operations/cli.md`
  - CLI installation/usage, profile/auth runtime options, command groups, stream usage, and route parity expectations.
- `docs/operations/api-service-supervision.md`
  - Always-on API supervision with user-level systemd (`Restart=always`), install/enable commands, and recovery steps.
- `docs/operations/generation-and-validation.md`
  - OpenAPI/client generation, protocol schema generation, typecheck/build/test commands, and pre-PR gates.
- `docs/operations/release-gate-checklist.md`
  - Required release command gate, contract/doc parity checks, and lock-in closure evidence checklist.
- `docs/operations/agent-platform-verification-matrix.md`
  - Requirement-to-test evidence matrix for dispatch, lifecycle, trust, portability, and release conformance gates.
- `docs/operations/troubleshooting.md`
  - Logs, failure modes, and concrete recovery playbooks.
- `docs/operations/agent-queue-troubleshooting.md`
  - Queue-worker troubleshooting for system-owned agents (job states, retries, stuck/timeout recovery, tuning).
- `docs/operations/agent-extension-authoring.md`
  - Implementation runbook for extension packages/manifests, runtime SDK event handlers, and queue enqueue patterns.
- `docs/operations/agent-extension-lifecycle-and-conformance.md`
  - Runtime lifecycle endpoints (`list`/`reload`), RBAC/trust modes, extension source roots, audit records, and conformance release gate usage.
- `docs/operations/agent-queue-framework.md`
  - End-to-end queue framework contract (invariants, runtime model, event payloads, job schemas, transcript contracts, retry/recovery).
- `docs/operations/maintenance.md`
  - Safe reset flows, git workflow rules, CI expectations, and operational invariants.
- `docs/implementation-status.md`
  - Current code-level feature coverage and user-visible API/workflow semantics.
- `docs/python/introduction.md`
  - Python SDK entrypoint and links to focused Python client docs (`quickstart`, `practical-recipes`, `api-surface`, `streaming-and-handlers`, `settings-and-automation`, `protocol-interfaces`, `typed-models`, `development-and-packaging`).

## Fast-path commands

- Install deps: `pnpm install`
- Start dev stack (API + web): `pnpm dev`
- Run CLI health check: `pnpm --filter @repo/cli dev system health`
- Install always-on API service: `./scripts/install-api-user-service.sh`
- Regenerate API contracts: `pnpm gen`
- Run workspace tests: `pnpm test`
- Typecheck all workspaces: `pnpm typecheck`
- Build all workspaces: `pnpm build`
- Runtime smoke (API + WebSocket lifecycle): `pnpm smoke:runtime`
- Runtime profile portability conformance: `node scripts/run-agent-conformance.mjs`
- Browser smoke/e2e: `pnpm test:e2e`
- Python client compile check: `python3 -m compileall packages/python-client/src/codex_manager`
- Python client unit tests: `python3 -m pytest packages/python-client/tests/unit`

## Current validation posture

- Compile/build validation is active (`typecheck`, `build`).
- Runtime smoke validation is active (`smoke:runtime`) and exercises core session/project/message/thread-control flows.
- Runtime profile portability conformance validation is active (`node scripts/run-agent-conformance.mjs`) and emits `.data/agent-conformance-report.json`.
- Workspace tests are active (`pnpm test`) with API contract/runtime harness, web integration tests, and API-client compile checks.
- Python client validation is active through compile checks and dedicated unit suites (route parity + protocol boundary tests).
- Browser-level Playwright smoke is active (`pnpm test:e2e`) via a wrapper that bootstraps missing Linux shared libraries into `.data/playwright-libs` when possible; see `docs/operations/troubleshooting.md` for edge cases.
- Lint commands are still placeholders in workspace packages and should be replaced with enforceable lint rules.

## Updating operations docs

When operational behavior changes:

1. Update the focused operations document containing that behavior.
2. Keep command examples synchronized with `package.json` scripts.
3. Keep this index updated if document boundaries or file names change.
