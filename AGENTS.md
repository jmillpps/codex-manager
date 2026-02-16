# AGENTS.md

## System instructions

You must always keep this agents file up to date. As the project changes, you must ensure these agents instructions are kept up to date.

Record all new information and documentation under docs/ and treat this directory like your personal curated knowledge base, not a dumping ground. The moment a document starts serving more than one clear purpose, it’s time to split it. A good rule of thumb: if a file exceeds 500 lines or contains multiple top‑level concerns (e.g., “architecture + protocol details + operational runbooks”), extract each concern into its own document and replace the removed sections with short summaries and links. Prefer a shallow, predictable structure (e.g., architecture/, protocol/, operations/, adr/) over giant monolithic files. Each document should answer one primary question (“How does the App Server protocol work?” vs “How do I run this locally?”), and its filename should reflect that question. Avoid appending to the end of existing docs out of convenience—if new content introduces a new conceptual boundary, create a new file and cross-reference it instead. Periodically refactor documentation just like code: remove duplication, consolidate overlapping sections, reorganize scattered related information, and delete obsolete content rather than marking it “deprecated.” Clean documentation scales when structure is intentional, scope is narrow, and ownership of each document is explicit.

At the end of every turn, you must perform a Documentation Impact Assessment by determining whether anything in that turn changed the system’s external behavior, public surface, lifecycle semantics, configuration requirements, operational steps, or user workflow. Report the result as your own assessment (not as a question to the user). If the answer is yes, documentation must be updated in the same commit; if the answer is no, no documentation changes are required. If a competent developer reading the existing docs would form a different mental model than the system now implements, the docs are wrong and must be corrected immediately. Documentation hygiene is as important as development.

## Brief

This project is a local-first Codex chat application in active implementation, with a runnable React/Vite frontend and Fastify backend that supervise and bridge `codex app-server` over STDIO for session lifecycle, streaming responses, and approval decisions while keeping Codex as the authoritative runtime.

## Repository context

This repository contains both planning documents and initial implementation code:

- `apps/web`: React + Vite chat UI with compact session list, archived-session filtering, collapsible `Projects` and `Your chats` groups, hover ellipsis context menu for rename/archive/restore/delete (with confirmation before permanent delete) plus nested hover `Move` submenu with nested `Projects` flyout (`New Project` at the top, then scrollable project list capped to 5 visible rows; project-assigned chats also expose `Your Chats` and `Archive` destinations there), archived-view section gating (hide empty project groups; hide `Projects` when no project has archived chats; hide `Your chats` when no unassigned archived chats), Projects header row ellipsis actions (`New Project`) anchored in-row with shared row highlight, per-project row ellipsis context menu with `New Chat` plus confirmed bulk project actions (`Move chats` to `Your Chats`/`Archive` and `Delete chats`, shown only when the project currently has chats, plus guarded `Delete Project`), ellipsis triggers with stronger local hover/focus chip while parent row hover stays visible, top-level context menus that open to the right of their trigger with same-row vertical alignment and viewport-aware fallback, pagination load-more, materialization-aware archive guard, transcript filtering/grouped activity cards, ChatGPT-like split-pane shell (independent chat/sidebar scrolling plus fixed-bottom centered composer), model selection, MCP status panel, streaming updates, approval controls, send-retry, reconnect backoff, and right-pane blocking modal flow when an active session is deleted
- `apps/api`: Fastify backend with Codex app-server JSON-RPC bridge, session/message/approval endpoints (including rename/archive/unarchive plus harness-level hard-delete since app-server has no native `thread/delete`), project endpoints (`/api/projects*`) including empty-project delete enforcement (`409 project_not_empty`) and bulk chat operations (`POST /api/projects/:projectId/chats/move-all`, `POST /api/projects/:projectId/chats/delete-all`), session-project assignment endpoint (`POST /api/sessions/:sessionId/project`) that also supports loaded non-materialized sessions, paginated/loaded-thread session listing (non-materialized visibility is loaded-memory based until first rollout), hard-delete disk purge with `410` guards, model+MCP capability endpoints, WebSocket event streaming (including `session_deleted` and project-assignment sync events), health/auth-readiness status reporting, session/project metadata persistence, and startup auth bootstrap into repo-local CODEX_HOME
- `packages/api-client`: generated API client for health, session/project lifecycle (including project bulk move/delete-all helpers), messaging, approvals, model listing, and MCP server status operations
- root dev tooling includes Playwright test runner dependency for browser automation checks (environment still needs required system libraries to launch browsers)
- `docs/*`: product, architecture, protocol, operations, and implementation status documentation

## Document guide

- `docs/prd.md`: Product requirements and scope. Defines goals, non-goals, functional and UX requirements, milestones, risks, and success metrics.
- `docs/architecture.md`: System architecture and invariants. Describes component responsibilities, lifecycle flows, transport model, persistence boundaries, and security posture.
- `docs/ops.md`: Day-to-day operational runbook. Covers setup, environment variables, local development commands, testing/build gates, troubleshooting, and reset procedures.
- `docs/codex-app-server.md`: Protocol reference for `codex app-server`. Documents handshake rules, methods, notifications, item/turn/thread semantics, approvals, and capability flags.
- `docs/implementation-status.md`: Current code-level implementation status and known gaps versus planned behavior.

## How to use these docs

1. Start with `docs/prd.md` for product intent and acceptance criteria.
2. Use `docs/architecture.md` to align implementation boundaries and invariants.
3. Use `docs/codex-app-server.md` when implementing protocol-level behavior.
4. Use `docs/ops.md` for local setup, verification, and release-quality checks.
5. Use `docs/implementation-status.md` to understand what is currently implemented versus planned.
