# Implementation Status

## Purpose

This document records what is actually implemented in code today.

Use this alongside planning documents:

- `docs/prd.md` defines target behavior.
- `docs/architecture.md` defines target architecture and invariants.
- This file defines current implementation scope.

## Current status

The repository now includes runnable Milestone 1 and Milestone 2 baseline behavior:

- `apps/api`: Fastify API with Codex JSON-RPC lifecycle management (`initialize`/`initialized`), request/response handling, and notification forwarding.
- `apps/api`: REST endpoints for session list/create/read/resume/rename/archive/unarchive/delete, message send, turn interrupt, pending approvals list, and approval decisions.
- `apps/api`: session list supports cursor/limit pagination (`cursor`, `limit`) while preserving loaded-session visibility on the first page.
- `apps/api`: session list merges persisted `thread/list` with `thread/loaded/list` so newly started (not yet materialized) sessions appear immediately in the UI.
- `apps/api`: session summaries expose `materialized` and read endpoint falls back to `includeTurns=false` for newly started threads (empty transcript until first message).
- `apps/api`: non-materialized sessions are sourced from loaded-thread memory and therefore may disappear across API/Codex restarts until first-message rollout persistence exists.
- `apps/api`: WebSocket stream endpoint (`/api/stream`) for per-thread event delivery.
- `apps/api`: health endpoint includes auth readiness signals (`hasOpenAiApiKey`, `codexHomeAuthFile`, `likelyUnauthenticated`) and startup warning when auth appears missing.
- `apps/api`: startup auth bootstrap copies `~/.codex/auth.json` into repo-local `CODEX_HOME/auth.json` when `CODEX_HOME` is configured and local auth is missing.
- `apps/api`: session title metadata persistence in `.data/session-metadata.json` to keep user-assigned names stable across process restarts.
- `apps/api`: project metadata persistence in `.data/session-metadata.json`, including project definitions and session-to-project associations.
- `apps/api`: project endpoints are implemented: list/create/rename/delete (`/api/projects*`), guarded project delete (`409 project_not_empty` when chats remain assigned), bulk project chat operations (`POST /api/projects/:projectId/chats/move-all`, `POST /api/projects/:projectId/chats/delete-all`), and session assignment (`POST /api/sessions/:sessionId/project`).
- `apps/api`: configurable default approval+sandbox policy wiring (`DEFAULT_APPROVAL_POLICY`, `DEFAULT_SANDBOX_MODE`) applied to thread start/resume and turn start.
- `apps/api`: model discovery endpoint (`/api/models`) and MCP server status endpoint (`/api/mcp/servers`) expose Codex capability/config status to the UI.
- `apps/api`: turn start accepts optional `model` from `/api/sessions/:sessionId/messages`, enabling per-session model selection from the frontend.
- `apps/api`: hard delete endpoint (`DELETE /api/sessions/:sessionId`) purges matching session artifacts from `CODEX_HOME` (sessions, archived sessions, shell snapshots), blocks further session operations with HTTP `410`, and emits `session_deleted` websocket payloads to all connected clients.
- `apps/api`: hard delete behavior is implemented as a harness-level extension because verified app-server schemas (stable + experimental on `codex-cli 0.101.0`) do not expose a native `thread/delete` method.
- `apps/api`: session-project assignment accepts loaded non-materialized sessions (no rollout yet), so newly created chats can be moved between projects before first message.
- `apps/web`: React + Vite chat UI with compact session sidebar, archived-session filter, collapsible "Your chats" section, hover ellipsis context menu for rename/archive/restore/delete actions, transcript view, composer, send/cancel actions, live streamed updates, inline approval cards, reconnect with exponential backoff, and explicit turn/runtime error surfacing (including auth-related failures).
- `apps/web`: `Delete Permanently` now requires user confirmation before the hard-delete request is sent.
- `apps/web`: sidebar includes a collapsible `Projects` section above `Your chats`; chats can be assigned/unassigned via each chat's ellipsis menu using a hover-driven `Move` submenu with a nested `Projects` flyout (`New Project` at the top, then a scrollable project list capped to 5 visible rows, plus `Your Chats`/`Archive` destinations for chats already inside a project), and assigned chats are removed from `Your chats` and rendered only under their project group.
- `apps/web`: in archived view, sidebar sections are visibility-gated: projects without archived chats are hidden, the entire `Projects` section is hidden when no project has archived chats, and `Your chats` is hidden when there are no unassigned archived chats.
- `apps/web`: the `Projects` section header now uses a hover ellipsis context menu for section-level actions (including `New Project`) instead of an always-visible `New` button; the ellipsis is anchored inside the row hover highlight (chat-row style), ellipsis triggers use a stronger local hover/focus chip while parent row highlights remain visible, and top-level context menus open to the right side of their trigger (same-row vertical alignment) with viewport-aware fallback.
- `apps/web`: each project row now has its own hover ellipsis context menu with `New Chat` (creates directly in that project), plus confirmed bulk actions `Move chats` (`Your Chats` / `Archive`) and `Delete chats` (both shown only when the project currently has chats), and `Delete Project`; project deletion is blocked until the project is empty.
- `apps/web`: Vite `/api` proxy is configured for HTTP + WebSocket forwarding, so `/api/stream` updates arrive live in development without requiring a refresh.
- `apps/web`: archive action is guarded for non-materialized sessions and surfaces clear errors when Codex requires a first message before archiving.
- `apps/web`: transcript includes tool/approval activity filtering (`All/Chat/Tools/Approvals`), grouped event cards, approval lifecycle updates, and jump-to-bottom behavior.
- `apps/web`: retry-last-prompt control appears on send errors for fast recovery.
- `apps/web`: model selector and MCP status panel are available in the UI.
- `apps/web`: layout uses independent left/right pane scrolling with a fixed-bottom composer in the chat pane so users can scroll transcript history while continuing to type.
- `apps/web`: chat shell now uses a centered transcript/composer column with a ChatGPT-like split-pane visual treatment, while preserving filter controls and jump-to-bottom behavior.
- `apps/web`: when an active session is deleted, the right pane is blocked with a modal notice and interaction is disabled until the user selects another chat or creates a new chat.
- `packages/api-client`: generated API client with health, session lifecycle (including rename/archive/unarchive/delete and session-project assignment), project lifecycle helpers (list/create/rename/delete plus project bulk move/delete-all chat helpers), messaging, and approval helper functions.
- `packages/api-client`: generated API client also includes model list + MCP server status methods and paginated session-list options.
- root scripts: `pnpm dev`, `pnpm gen`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint`.

## Not implemented yet

No outstanding PRD implementation gaps are currently tracked in this repository’s scoped v1 surface.

## Operational notes

- API starts `codex app-server` and logs Codex output to `.data/logs/codex.log`.
- WebSocket clients can subscribe to a specific thread via `/api/stream?threadId=<id>`.
- API and web `.env.example` files exist and should be copied to `.env` for local overrides.
