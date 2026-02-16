# Implementation Status

## Purpose

This document records what is implemented in code now and the current verification posture.

Use this with:

- `docs/prd.md` for product intent and acceptance criteria.
- `docs/architecture.md` for system boundaries/invariants.
- `docs/codex-app-server.md` and `docs/protocol/*` for protocol semantics.
- `docs/ops.md` and `docs/operations/*` for operational procedures.

## Last verified

- Date: February 16, 2026
- Validation run:
  - `pnpm gen`
  - `pnpm test`
  - `pnpm typecheck`
  - `pnpm build`
  - `pnpm smoke:runtime`
  - `pnpm test:e2e`

## Current implemented scope

### API (`apps/api`)

- Codex supervision and bridge:
  - Starts/supervises `codex app-server`.
  - Handles initialize lifecycle and forwards notifications to WebSocket clients.
- Session lifecycle:
  - list/create/read/resume/rename/archive/unarchive/delete.
  - hard delete is harness-level (disk purge + session tombstone + websocket broadcast) because app-server has no native `thread/delete`.
- Messaging and turn control:
  - send message (`turn/start`) and interrupt.
  - thread actions: fork, compact, rollback, background terminals clean, review start.
  - turn steering endpoint for active turns.
- Approvals + tool user-input:
  - pending approvals listing and decisions.
  - server-initiated tool user-input request ingestion and decision submission.
  - pending tool-input listing per session.
- Projects and session organization:
  - project create/list/rename/delete.
  - assign/unassign session to project.
  - bulk project chat move (`unassigned`/`archive`) and bulk project chat delete.
- Discovery/settings/account/integrations:
  - capabilities probe endpoint.
  - models, experimental features, collaboration modes, app list, skills list/config/remote.
  - MCP server status, MCP reload, MCP OAuth login start.
  - account read/login start/login cancel/logout/rate limits.
  - config read/value write/batch write/requirements.
  - command exec and feedback upload.
- WebSocket envelopes published to the web client include:
  - protocol notifications + approvals.
  - session/project metadata updates.
  - tool user-input requested/resolved.
  - plan/diff/token-usage updates.
  - app/account/mcp update notifications.
- Error handling:
  - Codex RPC errors are mapped to structured HTTP responses (unsupported, invalid params, invalid state, auth required, timeout, fallback).
  - global Zod request-validation errors return HTTP 400 with validation issues.

### Web (`apps/web`)

- ChatGPT-like split-pane layout with independent sidebar/chat scrolling and fixed composer in right pane.
- Sidebar features:
  - collapsible `Projects` and `Your chats` sections.
  - archived view filtering with section visibility gating.
  - compact rows with hover ellipsis actions.
  - project-level and chat-level context menus with nested move menus.
- Session/project actions:
  - create, rename, archive/unarchive, hard delete with confirmation.
  - project creation/rename/delete, bulk move/delete chats, session assignment and move flows.
  - non-materialized session movement supported.
- Chat runtime features:
  - websocket reconnect/backoff.
  - streamed transcript rendering with filters (All/Chat/Tools/Approvals).
  - pending approval cards and approval decisions.
  - tool-input request cards with answer submission.
  - active-turn controls (interrupt + steer).
  - thread actions menu (fork/compact/rollback/review/background-terminals clean).
  - insight drawer (plan/diff/usage/tools).
  - settings modal for capability/account/mcp/config/skills/apps visibility and actions.
- Deleted active-session UX:
  - right pane blocks interaction and requires selecting/creating another chat.

### API client and contracts

- OpenAPI generation now includes the expanded API surface for session controls, settings/account/integration APIs, and tool-input endpoints.
- Generated API client includes helpers for:
  - project bulk operations,
  - thread-control endpoints,
  - capability/settings/account/integration endpoints,
  - tool-input decision endpoint,
  - existing session/message/approval operations.

## Validation status

### Passing checks

- `pnpm gen`
- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `pnpm smoke:runtime`
- `pnpm test:e2e:list`
- `pnpm test:e2e`

### Current validation limitations

- `pnpm lint` is still placeholder-only in workspace packages; enforceable lint rules are not configured yet.
- Browser-level Playwright requires Linux shared libraries. Root `pnpm test:e2e*` commands now run through `scripts/run-playwright.mjs`, which bootstraps missing libs into `.data/playwright-libs` when `apt-get download` is available.

## Known follow-up hardening work

- Expand API/web test coverage breadth beyond current contract/integration + smoke suites.
- Add CI-enforced lint rules instead of placeholder scripts.
- Add additional Playwright scenarios for deeper runtime behaviors (approvals lifecycle, tool-input decisions, insight drawer updates, and project bulk workflows).
