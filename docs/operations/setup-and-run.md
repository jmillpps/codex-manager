# Operations: Setup and Runbook

## Purpose

This is the one-level setup/run foundation.

It starts where README quickstart ends and provides the canonical operator path to install, configure, run, and validate Codex Manager locally.

## Prerequisites

- Node.js `>=24`
- pnpm `10.29.3`
- Codex CLI on PATH

Optional but recommended:

- Python 3.11+ for Python SDK workflows

## First-time setup

```bash
corepack enable
corepack prepare pnpm@10.29.3 --activate
pnpm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

## Minimal environment baseline

Web env:

- `VITE_API_BASE=/api`

API env baseline:

- host/port/log level
- runtime dirs (`DATA_DIR`, optional `CODEX_HOME`)
- session default tuple (`approval`, `sandbox`, `network`)

For complete env catalog, use [`environment-reference.md`](./environment-reference.md).

## Start modes

Full stack:

```bash
pnpm dev
```

API only:

```bash
pnpm --filter @repo/api dev
```

Web only:

```bash
pnpm --filter @repo/web dev
```

Always-on API (`systemd --user`):

```bash
./scripts/install-api-user-service.sh
```

## Health and auth check

```bash
curl -s http://127.0.0.1:3001/api/health
```

Auth-ready quick check:

```bash
curl -s http://127.0.0.1:3001/api/health | grep -Eq '"likelyUnauthenticated"[[:space:]]*:[[:space:]]*false'
```

If `likelyUnauthenticated` is `true`, complete one login flow:

```bash
pnpm --filter @repo/cli dev account login start --type chatgpt
# or:
pnpm --filter @repo/cli dev account login start --type apiKey --api-key "$OPENAI_API_KEY"
```

## Baseline validation flow

```bash
pnpm gen
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:runtime
node scripts/run-agent-conformance.mjs
```

Python SDK baseline:

```bash
python3 -m compileall packages/python-client/src/codex_manager
python3 -m pytest packages/python-client/tests/unit
```

## Operational behavior highlights

- session list merges persisted + loaded non-materialized threads
- queue-backed workflows are best-effort eventual and terminal-state enforced
- worker sessions are system-owned and hidden by default user session listing
- websocket drives live UX; read-path reconciliation handles missed-event windows

## Read Next

- Environment variable catalog: [`environment-reference.md`](./environment-reference.md)
- CLI operations: [`cli.md`](./cli.md)
- Troubleshooting: [`troubleshooting.md`](./troubleshooting.md)
- Queue framework and deep contracts: [`agent-queue-framework.md`](./agent-queue-framework.md)
- Validation/release gates: [`generation-and-validation.md`](./generation-and-validation.md)

## Related runbooks

- API always-on supervision: [`api-service-supervision.md`](./api-service-supervision.md)
- Release checklist: [`release-gate-checklist.md`](./release-gate-checklist.md)
