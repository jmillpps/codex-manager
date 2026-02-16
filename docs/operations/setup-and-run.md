# Operations: Setup and Runbook

## Purpose

This document defines the **concrete, no-guesswork operating procedures** for working in this repository.

It covers:

- required tooling
- installation and first run
- environment configuration
- development workflows (web + api + Codex App Server)
- runtime behavior and MCP runtime operations

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
- Deleting a project (`DELETE /api/projects/:projectId`) returns HTTP `409` with `status: "project_not_empty"` when live assigned chats remain; stale assignment metadata that points to missing threads is pruned automatically during delete.
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
