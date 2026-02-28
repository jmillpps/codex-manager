# Operations: Generation and Validation

## Purpose

This is the one-level generation/validation runbook.

Use it to run the correct command families in the right order and to route into deeper command/gate references.

## Generation families

- OpenAPI generation
- API client generation
- Python typed model generation
- protocol schema generation (when applicable)

Canonical aggregate command:

```bash
pnpm gen
```

Python typed determinism check:

```bash
pnpm python:openapi:check
```

## Validation families

- lint/typecheck/test/build
- runtime smoke
- extension portability conformance
- browser e2e smoke
- Python compile/unit checks

## Baseline pre-PR gate

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

## Operational rules

- generated files are not hand-edited
- generation drift must be committed with corresponding source changes
- release requires parity across docs, tests, and runtime behavior

## Read Next (Level 3)

- Generation command reference: [`generation-command-reference.md`](./generation-command-reference.md)
- Validation gate playbook: [`validation-gate-playbook.md`](./validation-gate-playbook.md)

## Related docs

- Setup and run baseline: [`setup-and-run.md`](./setup-and-run.md)
- Release gate checklist: [`release-gate-checklist.md`](./release-gate-checklist.md)
- Verification matrix: [`agent-platform-verification-matrix.md`](./agent-platform-verification-matrix.md)
