# Implementation Status

## Purpose

This is the one-level implementation snapshot.

It starts where architecture/product docs stop and answers one question: what is currently implemented in the codebase and validated today.

## Last Verified

- Date: February 28, 2026
- Baseline gates:
  - `pnpm --filter @repo/api typecheck`
  - `pnpm --filter @repo/api test`
  - `pnpm --filter @repo/web typecheck`
  - `pnpm --filter @repo/web test`
  - `pnpm smoke:runtime`
  - `node scripts/run-agent-conformance.mjs`
  - `python3 -m compileall packages/python-client/src/codex_manager`

## Current Scope Summary

## API status

Implemented and actively used:

- app-server supervision and protocol bridging
- session/project lifecycle routes
- approvals/tool-input/tool-call routes
- session controls + generic session settings
- extension lifecycle list/reload with RBAC/trust
- queue-backed orchestrator workflows and worker sessions
- websocket fan-out for runtime and queue lifecycle deltas

## Web status

Implemented and actively used:

- production-style chat workspace and transcript rendering
- streaming lifecycle UX with reconnect handling
- inline approval/tool-input/tool activity surfaces
- pinned session controls with per-scope settings behavior
- queue-backed suggest-request and explainability rendering

## CLI status

Implemented and actively used:

- endpoint-complete command groups for operational surfaces
- profile/auth runtime defaults and JSON output mode
- websocket stream inspection and raw-request fallback
- route parity guardrail tests

## Python and contract status

Implemented and actively used:

- sync/async Python client domains and stream handlers
- typed OpenAPI facade with generated Pydantic models
- remote-skill and dynamic tool-call bridge helpers
- OpenAPI and route parity/quality validation gates

## Validation Posture

- Typecheck/test/build gates are active.
- Runtime smoke and conformance gates are active.
- Python compile gate is active.
- Python unit tests may be environment-limited where `pytest` dependencies are unavailable.

## Known Follow-up Areas

- Continue reducing documentation drift risk by keeping per-surface deep docs synchronized with implementation updates.
- Keep queue/runtime tuning defaults aligned with observed workload behavior.

## Read Next (Level 2)

- API details: [`implementation-status-api.md`](./implementation-status-api.md)
- Web and CLI details: [`implementation-status-web-cli.md`](./implementation-status-web-cli.md)
- Python and contract details: [`implementation-status-python-contracts.md`](./implementation-status-python-contracts.md)

## Related docs

- Product scope: [`prd.md`](./prd.md)
- Architecture invariants: [`architecture.md`](./architecture.md)
- Protocol index: [`codex-app-server.md`](./codex-app-server.md)
- Operations index: [`ops.md`](./ops.md)
