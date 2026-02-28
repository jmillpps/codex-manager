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
- `apps/cli` — operator automation CLI that maps to API endpoints and websocket stream operations
- `packages/python-client` — Python SDK for codex-manager REST/websocket automation (`CodexManager`, `AsyncCodexManager`)
  - Includes protocol-based injection boundaries (`request_executor`, `header_provider`, `retry_policy`, `hook_registry`, `stream_router`, `plugins`) and middleware object registration (`use_middleware(...)`)
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
- Suggested-request is queue-backed: `POST /api/sessions/:sessionId/suggested-request/jobs` emits `suggest_request.requested`, and repository supervisor enqueues one `agent_instruction` job (`jobKind: suggest_request`) that returns `requestKey`; `POST /api/sessions/:sessionId/suggested-request` emits the same event then waits briefly for completion before returning either `200` suggested request text or `202 queued`.
- Suggested-request worker turns publish live state through `POST /api/sessions/:sessionId/suggested-request/upsert` (`streaming|complete|error|canceled`) and API emits websocket `suggested_request_updated`.
- Suggested-request queue execution is deadline-bounded (`ORCHESTRATOR_SUGGEST_REQUEST_WAIT_MS`): when no completion signal is observed in time, core writes a deterministic fallback suggestion, interrupts the worker turn best-effort, and completes the queue job.
- Suggest-request queueing is single-flight per source chat: duplicate clicks while one suggest job is queued/running do not enqueue a second job.
- Unassigned-chat suggest-request uses a session-scoped queue owner id (`session:<sessionId>`), so suggest-request jobs do not require explicit project assignment.
- File-change approval events emit agent runtime work; supervisor handlers enqueue one instruction job that writes diff explainability (`type: fileChange.explainability`) and supervisor insight (`type: fileChange.supervisorInsight`) to transcript without blocking foreground turn streaming.
- Queue terminal reconciliation for agent instruction jobs is payload-driven via `supplementalTargets`; extension handlers define message ids/types/placeholders/fallbacks and core reconciles explicit terminal states.
- System-owned supervisor worker turns settle from runtime notification streams first (`turn/*`, `item/*`, agent-message deltas); `thread/read(includeTurns)` is a bounded fallback only.
- Include-turns fallback materialization waits are capped by `ORCHESTRATOR_AGENT_INCLUDE_TURNS_GRACE_MS` and then retried via queue retry policy, avoiding routine full-turn timeout stalls on first-turn materialization gaps.
- Agent runtime event dispatch is fanout and deterministic (`priority`, then module name, then registration order) with per-handler timeout isolation.
- Extension inventory and reload lifecycle APIs are available at:
  - `GET /api/agents/extensions`
  - `POST /api/agents/extensions/reload`
- Extension loading supports repo-local, installed-package, and configured-root sources with deterministic precedence and compatibility validation.
- Runtime profile adapter boundaries are enforced in core execution paths for provider-specific turn/read/interrupt and approval/steer capability actions.
- System-owned agent sessions are worker infrastructure: hidden from default user session lists, discoverable through API (`GET /api/sessions?includeSystemOwned=true`, `GET /api/projects/:projectId/agent-sessions`), readable via `GET /api/sessions/:sessionId`, and still denied for normal mutating user-chat operations (`403 system_session`).
- Agent turn permissions are agent-owned via `agents/<agent>/agent.config.json`; when no config is present, the API falls back to global defaults.
- Project deletion enforces emptiness against live sessions only; stale assignment metadata is pruned during delete before emptiness is evaluated.
- In the web UI, the left sidebar and right chat pane scroll independently and the composer remains pinned in the right pane; transcript tail-follow uses hysteresis, `Jump to bottom` is an absolute overlay so approval/event bursts do not shift scroll geometry, and incoming approval requests for the active chat force-focus bottom with a short snap-back window (brief settle delay before the first snap, also re-armed on approve) to preserve anchoring through approval transition jitter.

Agent runtime policy file format:

```json
{
  "model": "gpt-5.3-codex",
  "turnPolicy": {
    "sandbox": "read-only|workspace-write|danger-full-access",
    "networkAccess": "restricted|enabled",
    "approvalPolicy": "untrusted|on-failure|on-request|never",
    "effort": "none|minimal|low|medium|high|xhigh"
  },
  "orientationTurnPolicy": {
    "sandbox": "...",
    "effort": "..."
  },
  "instructionTurnPolicy": {
    "sandbox": "...",
    "effort": "..."
  },
  "threadStartPolicy": {
    "sandbox": "...",
    "approvalPolicy": "..."
  }
}
```

Only `turnPolicy` is typically needed; the other policy blocks are optional overrides.

Agent extension layout contract:

- `agents/<agent>/events.js|events.mjs|events.ts` registers event subscriptions and enqueues queue jobs.
- `agents/<agent>/agent.config.json` is optional; when present, it controls model/thread/turn policy for that agent's worker turns.
- core runs one system queue-runner orientation turn per agent session during startup preflight before the first `agent_instruction` job turn executes.
- queue payloads can include optional `bootstrapInstruction` (key + text), executed once per agent session/bootstrap-key during startup preflight after system orientation.
- `agents/<agent>/AGENTS.md` and `agents/<agent>/playbooks/*` can be referenced by bootstrap/job instructions but are not required by core to start processing.
- `agents/runtime/*` contains shared helper types/utilities for extension modules and is not treated as an event module directory.

Supervisor extension behavior in this repository:

- `agents/supervisor/events.js` subscribes to:
  - `file_change.approval_requested`
  - `turn.completed`
  - `suggest_request.requested`
  - `app_server.item.started` (user-message turn start signal)
- Those handlers enqueue:
  - `agent_instruction` for file-change supervision, turn-end review, suggest-request generation (`jobKind: suggest_request`), and initial default-title rename checks (`jobKind: session_initial_rename`)
- All workflow instructions are human-readable markdown job text; API core only executes queued turns and runtime plumbing.

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

### Verify CLI wiring

Run a basic health call through the CLI package:

```bash
pnpm --filter @repo/cli dev system health
```

If this command fails, verify API availability and CLI profile/runtime options in `docs/operations/cli.md`.

### Verify Python client wiring

Install editable package and run a minimal health probe:

```bash
pip install -e packages/python-client
python3 - <<'PY'
from codex_manager import CodexManager
cm = CodexManager.from_profile("local")
print(cm.system.health()["status"])
cm.close()
PY
```

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
# Recommended default for guarded local development:
DEFAULT_APPROVAL_POLICY=untrusted

# Baseline sandbox mode for new/resumed threads.
# Recommended default to force explicit approval for writes:
DEFAULT_SANDBOX_MODE=read-only
DEFAULT_NETWORK_ACCESS=restricted
SESSION_DEFAULTS_LOCKED=false

# Orchestrator queue controls
ORCHESTRATOR_QUEUE_ENABLED=true
ORCHESTRATOR_QUEUE_GLOBAL_CONCURRENCY=2
ORCHESTRATOR_QUEUE_MAX_PER_PROJECT=100
ORCHESTRATOR_QUEUE_MAX_GLOBAL=500
ORCHESTRATOR_QUEUE_MAX_ATTEMPTS=2
ORCHESTRATOR_QUEUE_DEFAULT_TIMEOUT_MS=60000
ORCHESTRATOR_QUEUE_BACKGROUND_AGING_MS=15000
ORCHESTRATOR_QUEUE_MAX_INTERACTIVE_BURST=3
ORCHESTRATOR_SUGGEST_REQUEST_ENABLED=true
ORCHESTRATOR_SUGGEST_REQUEST_WAIT_MS=12000
ORCHESTRATOR_AGENT_TURN_TIMEOUT_MS=180000
ORCHESTRATOR_AGENT_POLL_INTERVAL_MS=350
ORCHESTRATOR_AGENT_INCLUDE_TURNS_GRACE_MS=3000
ORCHESTRATOR_AGENT_UNTRUSTED_TERMINAL_GRACE_MS=3000
ORCHESTRATOR_AGENT_EMPTY_TURN_GRACE_MS=8000

# Supervisor file-change behavior is configured per-session/default scope via
# session settings (sessionControls.settings.supervisor.fileChange), not env vars.

# Extension lifecycle, trust, and external roots
AGENT_EXTENSION_RBAC_MODE=disabled
AGENT_EXTENSION_ALLOW_INSECURE_HEADER_MODE=false
AGENT_EXTENSION_RBAC_HEADER_SECRET=
AGENT_EXTENSION_RBAC_JWT_SECRET=
AGENT_EXTENSION_RBAC_JWT_ISSUER=
AGENT_EXTENSION_RBAC_JWT_AUDIENCE=
AGENT_EXTENSION_RBAC_JWT_ROLE_CLAIM=role
AGENT_EXTENSION_RBAC_JWT_ACTOR_CLAIM=sub
AGENT_EXTENSION_TRUST_MODE=warn
AGENT_EXTENSION_CONFIGURED_ROOTS=
AGENT_EXTENSION_PACKAGE_ROOTS=
```

Operational rules:

- `DATA_DIR` is owned by this repo and may be deleted to reset local backend state.
- `CODEX_HOME` controls where Codex stores its own state; you may set it repo-local for reproducibility.
- If `CODEX_HOME` is set and `CODEX_HOME/auth.json` is missing, the API attempts a one-time bootstrap from `~/.codex/auth.json` on startup.
- `DEFAULT_APPROVAL_POLICY=untrusted` keeps non-read operations behind approval.
- `DEFAULT_SANDBOX_MODE=read-only` ensures file writes require explicit approval before execution.
- Queue-degraded mode is opt-in: set `ORCHESTRATOR_QUEUE_ENABLED=false` only for diagnostics; suggest-request queue APIs and orchestrator job APIs return `503 job_conflict` while disabled.
- Agent turn timeout and queue timeout are independent controls:
  - `ORCHESTRATOR_AGENT_TURN_TIMEOUT_MS` bounds worker turn observation loops.
  - `ORCHESTRATOR_AGENT_UNTRUSTED_TERMINAL_GRACE_MS` controls how long fallback polling must observe stable completed state (with no new progress) before self-healing stale active-turn tracking.
  - `ORCHESTRATOR_AGENT_EMPTY_TURN_GRACE_MS` bounds how long a running worker turn is allowed to remain empty (no materialized turn items) before failing retryable.
  - queue job timeout is controlled by `ORCHESTRATOR_QUEUE_DEFAULT_TIMEOUT_MS` (with `agent_instruction` enforcing a minimum 180s job timeout in code).
  - suggest-request `agent_instruction` uses an additional completion-signal deadline (`ORCHESTRATOR_SUGGEST_REQUEST_WAIT_MS`); if the signal is not observed, core writes fallback suggestion state and completes the queue job.
- RBAC modes:
  - `disabled`: loopback-only local development bypass (`admin` role); non-loopback callers are rejected with `403 rbac_disabled_remote_forbidden`
  - `header`: role resolution from `x-codex-role` with shared header token `x-codex-rbac-token`
  - `jwt`: bearer-token verification for lifecycle endpoints
- Header mode safety guard: unless `AGENT_EXTENSION_ALLOW_INSECURE_HEADER_MODE=true`, header mode requires loopback host binding and `AGENT_EXTENSION_RBAC_HEADER_SECRET`.
- JWT mode requires `AGENT_EXTENSION_RBAC_JWT_SECRET`; optional issuer/audience and claim-mapping envs constrain accepted tokens.
- `AGENT_EXTENSION_TRUST_MODE=enforced` blocks undeclared extension capabilities at load/action time.
- `AGENT_EXTENSION_CONFIGURED_ROOTS` and `AGENT_EXTENSION_PACKAGE_ROOTS` accept path-delimited extension roots (`:` on Linux/macOS, `;` on Windows).

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

### Keep API always running (recommended for daily local use)

For persistent host-level supervision (auto-restart on crash, restart after reboot/resume), use the dedicated runbook:

- `docs/operations/api-service-supervision.md`

Fast path:

```bash
./scripts/install-api-user-service.sh
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

### Verify extension lifecycle surfaces

With API running, validate extension runtime inventory/reload surfaces:

```bash
curl -sS http://127.0.0.1:3001/api/agents/extensions
curl -sS -X POST http://127.0.0.1:3001/api/agents/extensions/reload
```

In `AGENT_EXTENSION_RBAC_MODE=disabled`, these lifecycle endpoints are loopback-only.

If `AGENT_EXTENSION_RBAC_MODE=header`, include:

- `x-codex-rbac-token: <AGENT_EXTENSION_RBAC_HEADER_SECRET>`
- `x-codex-role: admin` (or another allowed role)
- optional `x-codex-actor: <actor-id>`

If `AGENT_EXTENSION_RBAC_MODE=jwt`, include `Authorization: Bearer <token>` with role claim configured by `AGENT_EXTENSION_RBAC_JWT_ROLE_CLAIM`.

### Run portability conformance gate

Run from repo root:

```bash
node scripts/run-agent-conformance.mjs
```

Expected artifact:

- `.data/agent-conformance-report.json`

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
