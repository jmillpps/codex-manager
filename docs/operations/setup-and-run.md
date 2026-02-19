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

## Operational behavior contracts

This runbook is for setup and day-to-day operation. Keep feature-by-feature implementation inventory in `docs/implementation-status.md`.

Key runtime semantics operators should know:

- Session listing merges persisted threads (`thread/list`) with currently loaded non-materialized threads (`thread/loaded/list`) so newly created chats are visible immediately.
- Non-materialized chats are in-memory runtime state and are not guaranteed to survive API/Codex restart until a first turn materializes rollout state.
- Session hard delete is a harness extension (`DELETE /api/sessions/:sessionId`) because app-server has no native `thread/delete`.
- Suggested-reply (`POST /api/sessions/:sessionId/suggested-reply`) routes through project orchestrator chat when available, falls back to helper-thread strategy, and cleans helper sessions so they do not appear in lists or stream traffic.
- Project deletion enforces emptiness against live sessions only; stale assignment metadata is pruned during delete before emptiness is evaluated.
- In the web UI, the left sidebar and right chat pane scroll independently and the composer remains pinned in the right pane; transcript tail-follow uses hysteresis, `Jump to bottom` is an absolute overlay so approval/event bursts do not shift scroll geometry, and incoming approval requests for the active chat force-focus bottom with a short snap-back window (brief settle delay before the first snap, also re-armed on approve) to preserve anchoring through approval transition jitter.

---

## Hard requirements

These requirements are mandatory. If you do not meet them, development is unsupported.

### Node and package manager

- Node.js `>=24.0.0` is required (`package.json#engines.node`).
- pnpm `10.29.3` is required (`package.json#packageManager`) and should be managed via Corepack.

Required setup commands:

```bash
corepack enable
corepack prepare pnpm@10.29.3 --activate
```

Notes:

- The root `packageManager` field is authoritative for pnpm version.
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
# Valid values: untrusted, on-failure, on-request, never.
# Note: "unless-trusted" is not a protocol literal; use "untrusted".
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
