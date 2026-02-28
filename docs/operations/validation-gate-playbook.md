# Operations Deep Dive: Validation Gate Playbook

## Purpose

Validation and pre-release command playbook for routine engineering and release checks.

Use with [`generation-and-validation.md`](./generation-and-validation.md) and [`release-gate-checklist.md`](./release-gate-checklist.md).

## Standard pre-PR gate

```bash
pnpm gen
pnpm python:openapi:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:runtime
node scripts/run-agent-conformance.mjs
pnpm test:e2e
python3 -m compileall packages/python-client/src/codex_manager
python3 -m pytest packages/python-client/tests/unit
```

## Core runtime-focused checks

- `pnpm smoke:runtime`
- `node scripts/run-agent-conformance.mjs`

These should be considered non-optional for extension/queue/runtime behavior changes.

## API/schema quality checks

- API route parity and schema quality tests under `apps/api/src/*openapi*`
- CLI parity tests under `apps/cli/src/route-parity.test.ts`
- Python route parity/type coverage tests under `packages/python-client/tests/unit`

## Failure triage order

1. fix generation drift first (`pnpm gen`, `python:openapi:check`)
2. fix type errors
3. fix unit/integration tests
4. fix runtime smoke/conformance failures
5. re-run full gate

## Related docs

- Generation command reference: [`generation-command-reference.md`](./generation-command-reference.md)
- Release gate checklist: [`release-gate-checklist.md`](./release-gate-checklist.md)
- Agent verification matrix: [`agent-platform-verification-matrix.md`](./agent-platform-verification-matrix.md)
