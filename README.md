<p align="center"><code>pnpm install && pnpm dev</code></p>
<p align="center"><strong>Codex Manager</strong> is a local-first Codex chat application with a React/Vite UI and a Fastify API that supervises <code>codex app-server</code> over STDIO.</p>
<p align="center">It provides session and project organization, streaming responses, approval workflows, and protocol-aware runtime controls while keeping Codex as the source of truth for execution.</p>

---

## Quickstart

### Prerequisites

Install and verify these tools first:

```bash
node --version
pnpm --version
codex --version
codex app-server --help
```

Project requirements:

- Node.js `>=24`
- pnpm `10.29.3` (recommended via Corepack)
- Codex CLI on `PATH`

If pnpm is not already managed by Corepack:

```bash
corepack enable
corepack prepare pnpm@10.29.3 --activate
```

### Install dependencies

From repo root:

```bash
pnpm install
```

### Configure local environment

Create local env files:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

The defaults are suitable for local development. The API env supports both API-key auth and Codex home auth bootstrap.

<details>
<summary>Advanced auth notes (API key vs Codex home state)</summary>

You can run this project with either:

- `OPENAI_API_KEY` set in `apps/api/.env`, or
- existing Codex auth state in `CODEX_HOME/auth.json` (with startup bootstrap support from `~/.codex/auth.json` when available).

If auth is missing, health checks may pass but turns can fail with `401` once model calls begin.

</details>

### Start the full stack

```bash
pnpm dev
```

Expected local URLs:

- Web UI: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:3001`

### Verify runtime health

```bash
curl -s http://127.0.0.1:3001/api/health | jq
```

If `jq` is not installed, run the same command without piping.

---

## What This Project Includes

### Web application (`apps/web`)

- ChatGPT-style split-pane layout with independent sidebar and transcript scrolling.
- Persistent composer anchored at the bottom of the right pane.
- Session organization with `Projects` and `Your chats` groups.
- Sidebar context menus for rename, archive, move, and permanent delete.
- Project workflows: create, rename, delete, bulk move chats, bulk delete chats, and create chat directly under project.
- Archived view filtering that only renders sections with archived content.
- Live streaming transcript with filter tabs (`All`, `Chat`, `Tools`, `Approvals`).
- Approval and tool-input interaction cards with actionable decisions.
- Thread actions (`fork`, `compact`, `rollback`, `review`, `background terminals clean`, `steer`, `interrupt`).
- Settings/integrations panel for account, config, MCP, skills, apps, collaboration modes, and experimental features.
- Blocking modal behavior if the currently selected chat is deleted.

### API service (`apps/api`)

- Supervises `codex app-server` and performs protocol lifecycle initialization.
- Exposes REST APIs for sessions, projects, messages, approvals, tool input, config, account, MCP, and runtime capabilities.
- Streams protocol notifications to browser clients over WebSocket (`/api/stream`).
- Persists local metadata in `.data` and merges loaded non-materialized sessions into list results.
- Implements harness-level permanent delete behavior for sessions (disk purge + tombstone), since upstream app-server does not expose a native delete method.
- Maps protocol/runtime validation failures into stable HTTP semantics.

### Generated API client (`packages/api-client`)

- OpenAPI-driven TypeScript client generated from API contracts.
- Includes helpers across session/project lifecycle, approvals/tool-input, thread controls, and integrations.

---

## Daily Development Commands

```bash
# Start API + web
pnpm dev

# Start only API
pnpm dev:api

# Start only web
pnpm dev:web

# Regenerate OpenAPI + API client
pnpm gen

# Compile checks
pnpm typecheck
pnpm build

# Runtime smoke (API + websocket lifecycle)
pnpm smoke:runtime

# Workspace tests
pnpm test

# Browser e2e suite
pnpm test:e2e:list
pnpm test:e2e
```

---

## Environment Configuration

### API (`apps/api/.env`)

Common local values:

```env
HOST=127.0.0.1
PORT=3001
LOG_LEVEL=info
CODEX_BIN=codex
CODEX_HOME=.data/codex-home
DATA_DIR=.data
OPENAI_API_KEY=
DEFAULT_APPROVAL_POLICY=untrusted
DEFAULT_SANDBOX_MODE=read-only
```

Behavior notes:

- If `CODEX_HOME/auth.json` is missing, startup attempts a bootstrap from `~/.codex/auth.json`.
- `DEFAULT_APPROVAL_POLICY=untrusted` and `DEFAULT_SANDBOX_MODE=read-only` keep mutations behind explicit approvals.

### Web (`apps/web/.env`)

```env
VITE_API_BASE=/api
VITE_API_PROXY_TARGET=http://127.0.0.1:3001
```

---

## Data, State, and Artifacts

This project keeps runtime state and generated test artifacts out of source directories by default.

- Runtime/state root: `.data/`
- Codex home (recommended local): `.data/codex-home`
- Playwright test output: `.data/playwright-test-results`
- Playwright Linux dependency bootstrap cache: `.data/playwright-libs`

Ignored ephemeral/report directories include:

- `test-results/`
- `playwright-report/`
- `blob-report/`
- `coverage/`

---

## Protocol and Surface Notes

- Transport to Codex is newline-delimited JSON over STDIO.
- API-to-browser live updates are sent through `/api/stream` WebSocket.
- Non-materialized chats are visible while loaded, and become durable after rollout materialization.
- Archiving non-materialized chats is intentionally blocked (`409 not_materialized`) until first materialization.
- Deleting a non-empty project is blocked (`409 project_not_empty`) until chats are moved or deleted.

---

## Testing and Validation Coverage

Current validation stack:

- API contract/runtime suite: `scripts/test-api-contracts.mjs`
- Runtime smoke suite: `scripts/smoke-runtime.mjs`
- Web integration tests: `apps/web/tests/settings-actions.test.tsx`
- Playwright e2e core flows: `tests/e2e/*`

Current known quality gap:

- Lint scripts are placeholders in workspace packages and should be replaced with enforceable lint rules.

---

## Documentation Map

Start here by intent:

- Product scope: `docs/prd.md`
- Architecture and boundaries: `docs/architecture.md`
- Protocol reference index: `docs/codex-app-server.md`
- Protocol deep dives: `docs/protocol/*`
- Operations index: `docs/ops.md`
- Setup/validation/troubleshooting/maintenance runbooks: `docs/operations/*`
- Current implementation and verification status: `docs/implementation-status.md`

---

## Repository Layout

```text
apps/
  api/        Fastify API + Codex app-server supervisor
  web/        React/Vite frontend
packages/
  api-client/ Generated TypeScript API client
  codex-protocol/ Generated protocol schema/types
scripts/      Generation, runtime smoke, and test harness utilities
tests/e2e/    Playwright browser flows
docs/         Product, architecture, protocol, and operations knowledge tree
```

---

## Troubleshooting Shortlist

### WebSocket stuck in connecting

- Confirm `pnpm dev` is running both API and web services.
- Confirm web is using `VITE_API_BASE=/api` and proxy target points to the API host/port.
- Confirm API health endpoint responds.

### Turn failures with 401 auth errors

- Set `OPENAI_API_KEY` in `apps/api/.env` or ensure Codex auth exists in `CODEX_HOME/auth.json`.
- Restart API after auth changes.

### Playwright fails with missing Linux libraries

- Use `pnpm test:e2e` rather than direct Playwright commands.
- The wrapper (`scripts/run-playwright.mjs`) attempts local dependency bootstrap into `.data/playwright-libs`.
- If host blocks package downloads, run e2e in an environment with Playwright dependencies preinstalled.

For detailed procedures, see `docs/operations/troubleshooting.md`.

---

## Scope and Status

Codex Manager is in active implementation with a working local stack and end-to-end core workflow coverage.

If you plan to extend behavior, update protocol/ops/docs in the same change so code and mental model stay aligned.
