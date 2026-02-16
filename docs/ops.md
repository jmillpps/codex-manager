# Operations Manual

## Purpose

This document defines the **concrete, no-guesswork operating procedures** for working in this repository.

It covers:

- required tooling
- installation and first run
- environment configuration
- development workflows (web + api + Codex App Server)
- code generation workflows
- testing and CI gates
- debugging and common failure modes
- safe cleanup/reset procedures

This is an operational document. If you follow it precisely, you will be able to run, develop, test, and troubleshoot the system consistently on any machine.

---

## Repository summary

This repository contains:

- `apps/web` — a React + Vite chat UI
- `apps/api` — a Fastify backend that supervises **Codex App Server** (`codex app-server`) and exposes session/message REST endpoints plus WebSocket streaming
- `packages/*` — shared configuration and generated clients/types

Codex is managed via:

- **STDIO** to `codex app-server` (newline-delimited JSON / JSON-RPC-like protocol)
- optional MCP servers configured via Codex config (`.codex/config.toml` or `~/.codex/config.toml`)

## Current implementation scope

The repository has a runnable baseline with session and streaming flows.

Implemented now:

- API process startup and Codex JSON-RPC handshake/supervision
- API session lifecycle endpoints (`/api/sessions*`) including list/create/read/resume/rename/archive/unarchive/delete, plus turn actions (`messages`, `interrupt`)
- API project endpoints (`/api/projects*`) including list/create/rename/delete (with empty-project enforcement), bulk project chat operations (`POST /api/projects/:projectId/chats/move-all`, `POST /api/projects/:projectId/chats/delete-all`), and session assignment (`POST /api/sessions/:sessionId/project`)
- API capability endpoints (`/api/models`, `/api/mcp/servers`) for model discovery and MCP status visibility
- API approval endpoints (`/api/sessions/:sessionId/approvals`, `/api/approvals/:approvalId/decision`)
- API WebSocket event stream endpoint (`/api/stream`), including `session_deleted`, `project_upserted`, `project_deleted`, and `session_project_updated` payloads for cross-client sidebar sync
- Web UI session list with compact rows, hover ellipsis context menu for rename/archive/restore/delete (with confirmation before permanent delete) and a nested hover `Move` submenu with a nested `Projects` flyout (`New Project` at the top, then project targets in a scrollable list capped to 5 visible rows; chats already inside a project also expose `Your Chats` and `Archive` destinations there), project-row ellipsis context menu with `New Chat` (directly in that project) plus confirmed bulk project operations (`Move chats` to `Your Chats`/`Archive` and `Delete chats`, shown only when chats exist in that project, plus guarded `Delete Project`), archived-session filter, collapsible `Projects` + `Your chats` groups, pagination load-more control, transcript load, message send/cancel/retry, live stream rendering, inline approval actions, model selection, and reconnect backoff behavior
- Archived sidebar filtering: in `Show archived` mode, only project groups containing archived chats are rendered; the `Projects` section is omitted when no project has archived chats, and `Your chats` is omitted when no unassigned archived chats exist.
- System/tool/approval events rendered with grouped cards, status chips, details expansion, and transcript filters
- Chat layout keeps left navigation and right chat surfaces independently scrollable, with the composer pinned at the bottom of the right pane.
- New sessions are exposed immediately in `/api/sessions` via loaded-thread merge, even before Codex rollout materialization.
- Session summaries include `materialized` to indicate whether the thread has a persisted rollout (first user turn completed/started).
- Non-materialized sessions come from `thread/loaded/list` (in-memory runtime state). They are not guaranteed to survive API/Codex process restart until a first message materializes a rollout.
- Session summaries include `projectId` (`string | null`) so assigned chats render only under their project group; unassigned chats render under `Your chats`.
- Archiving non-materialized sessions returns HTTP `409` with `status: "not_materialized"`; send the first message before archiving.
- Deleting a session (`DELETE /api/sessions/:sessionId`) returns `status: "ok"` on success, purges session artifacts from disk, and subsequent session operations for that id return HTTP `410 Gone` with `status: "deleted"`.
- Deleting a project (`DELETE /api/projects/:projectId`) returns HTTP `409` with `status: "project_not_empty"` when assigned chats remain; clear the project first via move-all/delete-all project chat endpoints.
- Bulk move-to-archive for project chats returns HTTP `409` with `status: "not_materialized_sessions"` when any assigned chat has no rollout yet (send a first message or move to `Your Chats` instead).
- Per-chat project reassignment (`POST /api/sessions/:sessionId/project`) supports loaded non-materialized chats, so chats can be moved between projects before first message.
- Session hard-delete is a backend harness extension (the upstream app-server surface provides archive/unarchive but no native `thread/delete` method in the verified CLI schema set).
- If the active chat is deleted, the right chat pane is blocked by a modal and remains non-interactive until another chat is selected or a new chat is created.
- Generation scripts for OpenAPI and API client stubs

Still pending relative to PRD:

- No outstanding scoped gaps currently tracked.

---

## Hard requirements

These requirements are mandatory. If you do not meet them, development is unsupported.

### Node and package manager

- Node.js must be installed (repo pins a specific version in `.nvmrc` or `package.json#engines` if present).
- pnpm is used via Corepack.

Required setup commands:

```bash
corepack enable
corepack prepare pnpm@latest --activate
```

Notes:

- If the repo specifies `packageManager` in root `package.json`, that exact pnpm version must be used.
- Always install dependencies from repo root.

### Codex CLI availability

Codex must be available as a command on your PATH.

You must be able to run:

```bash
codex --version
codex app-server --help
```

If those commands do not work, fix your Codex installation before continuing.

---

## First-time setup

Run all commands from repository root.

### Install dependencies

```bash
pnpm install
```

### Create local environment files

Copy examples and edit as needed:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

Do not commit `.env` files.

### Trust the project in Codex (required for `.codex/config.toml`)

If this repository includes `.codex/config.toml`, Codex may require you to mark the directory as “trusted” before it will load the project-scoped configuration.

If Codex prompts you to trust the project, approve it.

---

## Environment configuration

### Web app environment (`apps/web/.env`)

The web app must only use `VITE_`-prefixed variables.

Minimum required:

```env
VITE_API_BASE=/api
```

Rules:

- `VITE_API_BASE` is `/api` in all environments.
- The web app must not embed absolute backend URLs in code.

### API environment (`apps/api/.env`)

Minimum required:

```env
HOST=127.0.0.1
PORT=3001
LOG_LEVEL=info
```

Codex-related variables (required for stable operation):

```env
# Path to the Codex binary. If empty, the API will attempt to run `codex` from PATH.
CODEX_BIN=

# Codex home directory. If empty, Codex uses its default.
# Recommended to set a repo-local Codex home for deterministic local dev:
# CODEX_HOME=.data/codex-home
CODEX_HOME=

# OpenAI API key for API-key based authentication.
# Required when repo-local CODEX_HOME does not already contain Codex auth state.
OPENAI_API_KEY=

# Data directory used by the API for its own persistence/logs.
# Recommended default:
DATA_DIR=.data

# Approval policy passed to thread/start, thread/resume, and turn/start.
# Recommended default for guarded local development:
DEFAULT_APPROVAL_POLICY=untrusted

# Baseline sandbox mode for new/resumed threads.
# Recommended default to force explicit approval for writes:
DEFAULT_SANDBOX_MODE=read-only
```

Operational rules:

- `DATA_DIR` is owned by this repo and may be deleted to reset local backend state.
- `CODEX_HOME` controls where Codex stores its own state; you may set it repo-local for reproducibility.
- If `CODEX_HOME` is set and `CODEX_HOME/auth.json` is missing, the API attempts a one-time bootstrap from `~/.codex/auth.json` on startup.
- `DEFAULT_APPROVAL_POLICY=untrusted` keeps non-read operations behind approval.
- `DEFAULT_SANDBOX_MODE=read-only` ensures file writes require explicit approval before execution.

---

## Running the system (development)

### Start everything

From repo root:

```bash
pnpm dev
```

Expected results:

- Web dev server starts and listens on `http://localhost:5173`
- API server starts and listens on `http://localhost:3001`
- Web dev server proxies `/api/*` to the API
- Web dev proxy forwards WebSocket upgrades for `/api/stream` (required for live turn streaming without page refresh)
- API supervises `codex app-server` and connects to it over STDIO

### Start only the web app

```bash
pnpm --filter @repo/web dev
```

### Start only the API

```bash
pnpm --filter @repo/api dev
```

### Verify health

Open in browser:

- `http://localhost:5173`

API health endpoint (example):

- `GET http://localhost:3001/api/health`
- `auth.hasOpenAiApiKey` shows whether API-key auth is configured in process env.
- `auth.codexHomeAuthFile` shows whether `CODEX_HOME/auth.json` exists.
- `auth.likelyUnauthenticated=true` indicates likely auth misconfiguration and expected 401 turn failures.

If the health endpoint fails, inspect logs immediately (see Debugging).

---

## Running Codex App Server (operational behavior)

Codex App Server is treated as a supervised dependency.

### Supervision rules

The API process is responsible for:

- starting `codex app-server` when the API boots (or on first request, depending on implementation)
- performing the initialize/initialized handshake
- restarting the Codex process if it exits unexpectedly
- preserving session metadata so the UI can continue to function after restarts

### Manual verification command (optional)

If you need to verify Codex independently of the API, run:

```bash
codex app-server
```

You should see it waiting for JSON input on STDIN. Stop it with Ctrl+C.

Do not run a second instance if the API is already supervising one (unless you changed ports and isolated them).

---

## MCP configuration operations

Codex MCP servers are configured in Codex config files.

### Where Codex reads MCP configuration from

- Project-scoped: `.codex/config.toml` (only in trusted projects)
- User-scoped: `~/.codex/config.toml`

Repo policy:

- If `.codex/config.toml` exists, it should contain **only non-secret configuration**.
- Secrets are provided via environment variables referenced by config fields.

### Reload MCP config without restarting Codex

If the API exposes a reload operation (recommended), use it to reload MCP configuration after editing config files.

If not available, restart the API (which restarts Codex).

---

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

### Build

```bash
pnpm build
```

---

## Required pre-PR checklist

Before opening a PR, these must all pass locally:

```bash
pnpm gen
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

If any command changes generated artifacts, commit those changes in the same PR.

---

## Debugging and logs

### Where logs live

The canonical local data/log directory is `DATA_DIR` (default `.data`).

Expected structure:

```txt
.data/
  logs/
    codex.log
```

API logs are emitted to the terminal/stdout in the current scaffold.

### Tail logs

Codex log:

```bash
tail -n 200 -f .data/logs/codex.log
```

### Common failure modes and fixes

#### Web loads but chat actions fail immediately

Symptoms:

- UI renders, but creating a session or sending a message errors instantly.

Checklist:

- Confirm API is running on `http://localhost:3001`
- Confirm web proxy is configured to forward `/api`
- Confirm API health endpoint succeeds
- Check API logs for startup errors

#### API is up but Codex features fail

Symptoms:

- API health passes, but session creation fails (Codex unavailable).

Checklist:

- Confirm `codex` is on PATH or `CODEX_BIN` is set
- Confirm `codex app-server --help` works
- Check `.data/logs/codex.log` for immediate process exit
- Verify `CODEX_HOME` is writable (if set)

#### Streaming stalls mid-response

Symptoms:

- Assistant starts replying, then freezes.

Checklist:

- Inspect API logs for dropped STDIO pipe or JSON parse errors
- Confirm the Codex process is still running
- Restart the API if the Codex process crashed
- Ensure your terminal/OS isn’t buffering STDIO unexpectedly (rare, but possible with wrappers)

#### Approvals appear but cannot be accepted/denied

Symptoms:

- UI displays an approval prompt, but clicking buttons does nothing.

Checklist:

- Ensure WebSocket is connected
- Ensure API is mapping server-initiated requests correctly
- Ensure the backend responds exactly once per approval request `id`
- Inspect logs for “unknown approval id” or “already responded” errors

#### Turns fail with 401 Unauthorized

Symptoms:

- Session creation works, but turns fail quickly.
- UI shows an auth-related error.
- `.data/logs/codex.log` contains `401 Unauthorized` / `Missing bearer or basic authentication`.

Checklist:

- Configure valid OpenAI credentials for the API process environment.
- If using API key auth, set `OPENAI_API_KEY` before starting `pnpm dev`.
- Confirm credentials are visible to the API process (not only your shell profile).
- Restart the API after changing credentials.

#### MCP server not available inside Codex

Symptoms:

- Tools expected from MCP servers never appear.

Checklist:

- Verify `.codex/config.toml` or `~/.codex/config.toml` includes the server
- Confirm the project is trusted (for `.codex/config.toml`)
- If STDIO MCP server:
  - confirm command exists and runs standalone
  - confirm required env vars are forwarded
- If HTTP MCP server:
  - confirm URL reachable
  - confirm token environment variables are set
- Reload MCP configuration or restart the API

---

## Safe reset procedures

### Reset backend state (recommended for dev)

This clears local API persistence and logs but does not necessarily delete Codex’s own history unless Codex home is repo-local.

Steps:

1. Stop `pnpm dev`
2. Delete API data directory:

```bash
rm -rf .data
```

3. Restart:

```bash
pnpm dev
```

### Reset Codex state (only when you explicitly want to)

Codex stores threads/rollouts under `CODEX_HOME` (or default Codex home if not set).

If `CODEX_HOME` is repo-local (recommended), you can reset Codex state by deleting it:

```bash
rm -rf .data/codex-home
```

If you did not set `CODEX_HOME`, do **not** delete anything under your home directory unless you intentionally want to wipe global Codex state.

---

## Git workflow rules

### Branch naming

- `feat/<short-name>`
- `fix/<short-name>`
- `chore/<short-name>`

### Commit messages

Use Conventional Commits:

- `feat: ...`
- `fix: ...`
- `refactor: ...`
- `chore: ...`
- `test: ...`
- `docs: ...`

### Generated files policy

- Generated files are updated only via generation scripts.
- If repo policy requires committing generated output, commit it in the same PR that changes the source.

---

## CI expectations

CI enforces the same gates as local development:

- install
- `pnpm gen` (and fail if it produces diffs)
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

A PR is not mergeable unless CI passes.

---

## Operational invariants

These must always remain true:

- The API is the only process that talks to Codex App Server in normal operation.
- Codex App Server is accessed over STDIO using newline-delimited JSON messages.
- A connection to Codex is considered invalid until `initialize` → `initialized` handshake completes.
- Streaming is event-driven; `item/completed` is authoritative.
- Secrets are never committed to the repo.
- The web app only uses `/api` as its base and never hardcodes backend hosts.

---

## When to update this document

Update `ops.md` in the same PR whenever you change:

- any required environment variables
- default ports, URLs, or proxy behavior
- locations of logs and data directories
- generation commands or output paths
- test commands or gating expectations
- Codex runtime supervision behavior

If a contributor following `ops.md` would get stuck, then `ops.md` is wrong and must be fixed.
