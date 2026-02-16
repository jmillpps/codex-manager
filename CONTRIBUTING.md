# Contributing to Codex Manager

Thank you for contributing.

This project is local-first and protocol-sensitive. Changes are easiest to review when they are small, reproducible, and documented with clear behavioral intent.

## Before You Start

1. Read `README.md` for setup and command surface.
2. Read `docs/architecture.md` for invariants and boundaries.
3. Read protocol references in `docs/protocol/*` for app-server semantics.
4. Read `docs/ops.md` + `docs/operations/*` for validation and troubleshooting flows.

## Development Setup

From repository root:

```bash
pnpm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
pnpm dev
```

## Workflow

1. Create a focused branch.
2. Make minimal, coherent changes.
3. Run relevant validation locally.
4. Update docs in the same change when behavior/workflow/config changes.

Recommended validation before opening a PR:

```bash
pnpm gen
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:runtime
pnpm test:e2e
```

## Commit Hygiene

Use explicit staging. Do not use blanket staging commands.

Good:

```bash
git add README.md docs/ops.md apps/api/src/index.ts
```

Avoid:

```bash
git add .
```

Use clear commit messages. Conventional commit style is preferred (for example: `feat: ...`, `fix: ...`, `docs: ...`, `test: ...`).

## Pull Request Expectations

Each PR should include:

- What changed.
- Why the change was needed.
- Any behavior/config/workflow impacts.
- Validation commands run and their results.

If the change affects API surface, protocol handling, approvals, session lifecycle, or operational setup, update docs under `docs/` in the same PR.

## Documentation Impact Rule

At the end of each implementation turn, assess whether external behavior or workflows changed.

If yes:

- update documentation in the same commit.

If no:

- no docs changes are required.

When docs and implementation diverge, implementation is considered incomplete until docs are corrected.

## Reporting Issues

Please include:

- environment (`node`, `pnpm`, `codex --version`)
- reproduction steps
- expected behavior
- actual behavior
- relevant logs (`.data/logs/codex.log` and API console output)
