# AGENTS.md

## System instructions

You must always keep this agents file up to date. As the project changes, you must ensure these agents instructions are kept up to date.

Record all new information and documentation under docs/ and treat this directory like your personal curated knowledge base, not a dumping ground. The moment a document starts serving more than one clear purpose, it’s time to split it. A good rule of thumb: if a file exceeds 500 lines or contains multiple top‑level concerns (e.g., “architecture + protocol details + operational runbooks”), extract each concern into its own document and replace the removed sections with short summaries and links. Prefer a shallow, predictable structure (e.g., architecture/, protocol/, operations/, adr/) over giant monolithic files. Each document should answer one primary question (“How does the App Server protocol work?” vs “How do I run this locally?”), and its filename should reflect that question. Avoid appending to the end of existing docs out of convenience—if new content introduces a new conceptual boundary, create a new file and cross-reference it instead. Periodically refactor documentation just like code: remove duplication, consolidate overlapping sections, reorganize scattered related information, and delete obsolete content rather than marking it “deprecated.” Clean documentation scales when structure is intentional, scope is narrow, and ownership of each document is explicit.

At the end of every turn, you must perform a Documentation Impact Assessment by determining whether anything in that turn changed the system’s external behavior, public surface, lifecycle semantics, configuration requirements, operational steps, or user workflow. Report the result as your own assessment (not as a question to the user). If the answer is yes, documentation must be updated in the same commit; if the answer is no, no documentation changes are required. If a competent developer reading the existing docs would form a different mental model than the system now implements, the docs are wrong and must be corrected immediately. Documentation hygiene is as important as development.

Keep default runs clean:

- Runtime and test artifacts must be written under `.data/` (or another gitignored runtime path), not into tracked source directories.
- Playwright/Vitest/other report outputs must never be committed.
- Root report/state directories such as `test-results/`, `playwright-report/`, `blob-report/`, and `coverage/` are treated as ephemeral and must remain untracked.

## Brief

This project is a local-first Codex chat application in active implementation, with a runnable React/Vite frontend and Fastify backend that supervise and bridge `codex app-server` over STDIO for session lifecycle, streaming responses, and approval decisions while keeping Codex as the authoritative runtime.

## Repository context

This repository contains both planning documents and active implementation code:

- `apps/web`: React + Vite chat UI with ChatGPT-like split-pane layout, compact/expandable Projects + chats navigation, hover ellipsis context menus with nested move/project flyouts, archive/delete/rename flows, project bulk actions, materialization-aware archive guard, transcript filtering and grouped activity cards, consolidated per-turn transcript rendering (one user card + one unified response bubble where the top thought area is progressively disclosed and the bottom area is the final assistant response text), filters that determine which turns appear while each shown turn preserves full in-order thought activity (reasoning/tools/approvals) for auditability, thought status that shows `Working...` while active then `Worked for <duration>` using turn-level timing when available, per-turn thought disclosure state that stays stable across streaming/approval updates with pending-only auto-open previews when new approvals/tool-input requests arrive while closed, tab-scoped selected-chat persistence by `sessionId` across page reload/HMR (preventing duplicate-title selection drift), inline approval/tool-input handling inside thought details with compact command/file-change approval rows (`Approval required to run …`, `Approval required to create/modify/delete/move file …`) where approval cards are visible only while pending, pending file-change approvals include inline dark-theme diff/content previews above decision buttons and suppress duplicate pending file-change item rows until approval resolves, command-execution rows use inline terminal-style dark blocks (no nested wrapper bubble) with prompt lines whose `~` prefix is derived from runtime user-home path inference plus output beneath, and file-change rows use dark-theme colored diff rendering with displayed file paths and absolute home-path text in diff lines normalized to the same `~`-relative home convention, thread actions (fork/compact/rollback/review/background-terminals clean), active-turn steer controls, single-box composer where suggest-reply populates the main draft plus `Ctrl+Enter` send shortcut, per-session header controls using a combined nested `Model -> Reasoning` menu (model entries open right-side effort submenus; `Thread default` is not exposed; `model+effort` is selected together and forwarded on send/suggest requests), project-create auto-insertion of orchestration chat, project-level working-directory configuration from project context menus (used for new project chats), race-guarded/abortable suggest-reply requests so late responses do not clobber drafts after session switches, insights drawer (plan/diff/usage/tools) that is manually toggled and never auto-opened by plan/diff stream events, settings modal (capabilities/account/config/mcp/skills/apps), websocket reconnect/backoff with chat-pane disconnected overlay + manual reconnect action plus send-time no-response disconnect detection, and right-pane blocking modal behavior when the active session is deleted
- `apps/api`: Fastify backend with Codex app-server JSON-RPC bridge, session/project lifecycle endpoints (including harness-level hard delete + purge tombstones), thread-control endpoints (`fork`, `compact`, `rollback`, `background-terminals/clean`, `review`, `turn steer`), automatic per-project orchestration chat provisioning on project create with startup/list-time self-healing re-provision if mapped orchestration sessions are missing, project metadata `workingDirectory` support (including orchestration-thread startup cwd and project-summary exposure plus orchestration-session re-provision when project cwd changes), sticky short default chat titles (avoiding first-message auto-title churn unless explicitly renamed), message/suggest turn-start effort overrides (`effort`) for reasoning-level control, thread lifecycle start/resume/fork calls that attempt `experimentalRawEvents` with compatibility fallback on runtimes that reject it, suggested-reply orchestration endpoint (routes through project orchestration chat when available, helper-thread fallback for unassigned chats, non-materialized no-context handling, and helper-session cleanup/hiding to avoid list pollution), approval + tool-input request workflows, capability probing, discovery/settings/account/config/integration endpoints, command/feedback endpoints, session/project metadata persistence (including persisted turn timing metadata plus a runtime supplemental transcript ledger that preserves streamed tool/approval events for audit in `GET /api/sessions/:sessionId`), startup auth bootstrap into repo-local CODEX_HOME, websocket event fan-out (session/project/tool-input/plan/diff/token-usage/account/app/mcp events), and structured Codex/Zod error mapping for stable HTTP semantics
- `packages/api-client`: generated TypeScript API client for health, session/project lifecycle, bulk project operations, approvals/tool-input decisions, thread actions, and settings/account/integration surfaces
- root dev tooling includes Playwright browser smoke/e2e commands (`pnpm test:e2e*`) routed through `scripts/run-playwright.mjs` (Linux shared-library bootstrap into `.data/playwright-libs` when needed, and test output under `.data/playwright-test-results`) plus a runtime integration smoke harness (`pnpm smoke:runtime`) for API + websocket lifecycle validation
- `docs/*`: product, architecture, protocol, operations, and implementation-status documentation organized as focused knowledge-tree modules

## Document guide

- `docs/prd.md`: Product requirements and scope. Defines goals, non-goals, functional and UX requirements, milestones, risks, and success metrics.
- `docs/architecture.md`: System architecture and invariants. Describes component responsibilities, lifecycle flows, transport model, persistence boundaries, and security posture.
- `docs/ops.md`: Operations index linking focused runbooks.
- `docs/operations/setup-and-run.md`: Prerequisites, environment setup, local execution, Codex supervision behavior, and MCP runtime operations.
- `docs/operations/generation-and-validation.md`: Contract generation, protocol schema generation, and validation commands.
- `docs/operations/troubleshooting.md`: Debugging steps and failure-mode runbooks.
- `docs/operations/maintenance.md`: Reset procedures, git workflow rules, CI expectations, and operational invariants.
- `docs/codex-app-server.md`: Protocol index linking focused Codex protocol references.
- `docs/protocol/overview.md`: Transport/framing, JSON-RPC model, handshake, and protocol primitives.
- `docs/protocol/methods-core.md`: Core method surface (initialize/thread/turn/review lifecycle).
- `docs/protocol/methods-integrations.md`: Integration/configuration method surface (commands, skills, apps, MCP, config, account, feedback).
- `docs/protocol/events.md`: Stream/event and delta semantics.
- `docs/protocol/approvals-and-tool-input.md`: Approval and server-initiated user-input flows.
- `docs/protocol/config-security-and-client-rules.md`: MCP config semantics, security model, and non-negotiable client rules.
- `docs/implementation-status.md`: Current code-level implementation status and known gaps versus planned behavior.

## How to use these docs

1. Start with `docs/prd.md` for product intent and acceptance criteria.
2. Use `docs/architecture.md` to align implementation boundaries and invariants.
3. Use `docs/codex-app-server.md` as the protocol index, then open the focused file under `docs/protocol/` for the concern you are implementing.
4. Use `docs/ops.md` as the operations index, then open the focused file under `docs/operations/` for setup, validation, troubleshooting, or maintenance tasks.
5. Use `docs/implementation-status.md` to understand current implementation coverage and residual gaps.
