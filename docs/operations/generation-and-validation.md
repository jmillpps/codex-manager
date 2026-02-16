# Operations: Generation and Validation

## Code generation operations

This repo has two distinct generation categories:

- OpenAPI + API client generation (for browser↔API contract)
- Codex App Server schema/type generation (for backend↔Codex contract)

### Generate OpenAPI spec

Run from repo root:

```bash
pnpm openapi:gen
```

Required behavior:

- Produces/updates the OpenAPI artifact at the canonical path defined by the repo (example: `apps/api/openapi/openapi.json`)
- Output must be deterministic and committed if repo policy requires it

### Generate API client

Run:

```bash
pnpm client:gen
```

Required behavior:

- Generates/updates the TypeScript client in `packages/api-client/src/generated/`
- Generated code is never edited manually
- If policy requires generated output committed, commit it in the same PR

### Generate everything

Run:

```bash
pnpm gen
```

This must run `openapi:gen` and `client:gen` in the correct order.

### Generate Codex App Server protocol types (if present)

If this repo includes a package that pins the Codex App Server schema/types, the canonical update command must:

- generate stable types:
  - `codex app-server generate-ts --out <DIR>`
  - `codex app-server generate-json-schema --out <DIR>`
- optionally generate experimental types (only when repo explicitly opts in):
  - add `--experimental`

Canonical command (example):

```bash
pnpm codex:schema
```

Operational rule:

- Whenever the Codex version changes, you must regenerate these artifacts and commit them (if repo policy requires committed output).

---

## Testing operations

All commands are run from repo root unless stated otherwise.

### Run all tests

```bash
pnpm test
```

Current behavior:

- Runs active workspace test suites:
  - API contract/runtime validation (`scripts/test-api-contracts.mjs`)
  - web integration tests (Vitest)
  - API-client compile checks

### Run API tests only

```bash
pnpm --filter @repo/api test
```

### Run web tests only

```bash
pnpm --filter @repo/web test
```

### Typecheck

```bash
pnpm typecheck
```

### Lint

```bash
pnpm lint
```

Current note:

- Workspace lint scripts are placeholders today; `pnpm lint` is still required to confirm no package-level lint command regressions.

### Browser smoke/e2e

List registered suites:

```bash
pnpm test:e2e:list
```

Run browser smoke:

```bash
pnpm test:e2e
```

Behavior:

- Both commands execute through `scripts/run-playwright.mjs`.
- On Linux, if host browser libs are missing, the wrapper attempts a user-space bootstrap into `.data/playwright-libs` using `apt-get download` + `dpkg-deb -x`.
- If bootstrap is not possible in the environment, Playwright launch will fail with missing shared-library errors; see troubleshooting.

### Build

```bash
pnpm build
```

### Runtime smoke (API + WebSocket lifecycle)

Run:

```bash
pnpm smoke:runtime
```

This exercises a live API instance for:

- health/capability/settings/account integration reads
- session/project lifecycle operations
- websocket subscription and streamed event delivery
- thread action endpoints and cleanup behavior

---

## Required pre-PR checklist

Before opening a PR, these must all pass locally:

```bash
pnpm gen
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:runtime
pnpm test:e2e
```

If any command changes generated artifacts, commit those changes in the same PR.

---
