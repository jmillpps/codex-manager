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

- `apps/web`: React + Vite chat UI with ChatGPT-like split-pane layout, project/chat navigation and management flows, consolidated turn rendering (user request + unified response card with progressive thought disclosure), markdown-rendered assistant responses and thought reasoning/message previews (including collapsible bold-title subsections inside expanded thought details), approvals/tool-input inline handling, a pinned per-chat `Session Controls` panel (scope-aware Apply/Revert workflow for `model`, `approval policy`, `network access`, and `filesystem sandbox`, immediate per-chat `Thinking Level` selector, hover-descriptive tooltips for summary/selector values, lock-aware default scope behavior, default/after-apply summary-chip collapse, and `Close` primary action when no tuple edits are pending), canonical protocol approval-policy controls (`untrusted`/`on-failure`/`on-request`/`never`), queue-backed suggest-request integration (single-flight pending guard + websocket completion application), explainability transcript rendering for completed file-change diffs, thread actions/insights/settings surfaces, websocket-backed streaming lifecycle UX, disconnected-chat reconnect overlay UX, optimistic outgoing-message delivery-state indicators (`Sending`/`Sent`/`Delivered`/`Failed`), incoming response receive-state indicators (spinner while streaming, disconnect marker on drop), a completion checkmark on final assistant replies, live transcript rendering from current state (no top-level transcript memo cache), and session-switch race guards that prevent stale transcript/approval/tool-input hydration from leaking prior-chat content, duplicating delivered user bubbles, or dropping newer websocket approval/tool-input requests during in-flight REST hydration. Detailed behavior contracts (including scroll anchoring/snap-back tuning and approval rendering semantics) are documented in `docs/implementation-status.md`.
- `apps/api`: Fastify backend supervising `codex app-server` over STDIO with session/project lifecycle APIs, thread/turn control endpoints, approvals/tool-input workflows, queue-backed suggested-request + file-change explainability orchestration jobs, hidden system-owned orchestrator session isolation, metadata persistence (including supplemental transcript ledger and orchestrator job store), websocket fan-out, deterministic typed extension event dispatch, runtime profile adapter boundaries, extension lifecycle endpoints (`GET /api/agents/extensions`, `POST /api/agents/extensions/reload`) with RBAC/trust controls (disabled/header/jwt), semver-based compatibility enforcement, reload audit logging, portable-extension conformance harness support, and structured error mapping. Session-mutating control routes are existence-gated to avoid orphan per-session control metadata writes. Detailed runtime semantics and endpoint behavior contracts are documented in `docs/implementation-status.md`.
- `apps/cli`: workspace CLI (`@repo/cli`) that provides endpoint-complete operator access to API/websocket workflows with profile-based runtime/auth defaults, command-domain grouping, and API route parity tests.
- `packages/agent-runtime-sdk`: canonical provider-neutral runtime SDK contracts for extension events/tools/typed emit envelopes and reconciliation helper utilities.
- `packages/api-client`: generated TypeScript API client for health, session/project lifecycle, bulk project operations, approvals/tool-input decisions, thread actions, and settings/account/integration surfaces
- root dev tooling includes Playwright browser smoke/e2e commands (`pnpm test:e2e*`) routed through `scripts/run-playwright.mjs` (Linux shared-library bootstrap into `.data/playwright-libs` when needed, and test output under `.data/playwright-test-results`) plus a runtime integration smoke harness (`pnpm smoke:runtime`) for API + websocket lifecycle validation
- host-level API supervision helper script `scripts/install-api-user-service.sh` installs a user-level `systemd` unit (`codex-manager-api.service`) with restart-on-failure semantics for always-on local API availability
- `docs/*`: product, architecture, protocol, operations, and implementation-status documentation organized as focused knowledge-tree modules

## Document guide

- `docs/prd.md`: Product requirements and scope. Defines goals, non-goals, functional and UX requirements, milestones, risks, and success metrics.
- `docs/product/agent-platform-requirements.md`: Extension runtime framework functional/technical requirements and release-blocking portability criteria.
- `docs/architecture.md`: System architecture and invariants. Describes component responsibilities, lifecycle flows, transport model, persistence boundaries, and security posture.
- `docs/architecture/agent-extension-runtime.md`: Extension runtime source discovery, compatibility, dispatch, lifecycle controls, trust model, and profile-adapter boundaries.
- `docs/ops.md`: Operations index linking focused runbooks.
- `docs/operations/setup-and-run.md`: Prerequisites, environment setup, local execution, Codex supervision behavior, and MCP runtime operations.
- `docs/operations/cli.md`: CLI installation/usage, profile/auth runtime options, command groups, websocket streaming, and route parity expectations.
- `docs/operations/api-service-supervision.md`: User-level systemd runbook for always-on API supervision (install/enable/status/logs/recovery).
- `docs/operations/generation-and-validation.md`: Contract generation, protocol schema generation, and validation commands.
- `docs/operations/release-gate-checklist.md`: Release gate command set, doc/code parity checks, and lock-in closure evidence checklist.
- `docs/operations/agent-platform-verification-matrix.md`: Requirement-to-test evidence matrix for agent runtime dispatch, lifecycle, trust, and conformance.
- `docs/operations/agent-extension-lifecycle-and-conformance.md`: Extension source roots, lifecycle RBAC/trust controls, audit semantics, and portability conformance gate usage.
- `docs/operations/troubleshooting.md`: Debugging steps and failure-mode runbooks.
- `docs/operations/agent-queue-framework.md`: Queue framework contract for agent-driven orchestration (events, jobs, transcript contracts, retries/recovery).
- `docs/operations/maintenance.md`: Reset procedures, git workflow rules, CI expectations, and operational invariants.
- `docs/codex-app-server.md`: Protocol index linking focused Codex protocol references.
- `docs/protocol/overview.md`: Transport/framing, JSON-RPC model, handshake, and protocol primitives.
- `docs/protocol/methods-core.md`: Core method surface (initialize/thread/turn/review lifecycle).
- `docs/protocol/methods-integrations.md`: Integration/configuration method surface (commands, skills, apps, MCP, config, account, feedback).
- `docs/protocol/events.md`: Stream/event and delta semantics.
- `docs/protocol/agent-runtime-sdk.md`: Canonical extension SDK type/envelope/helper contracts.
- `docs/protocol/agent-dispatch-and-reconciliation.md`: Deterministic fanout dispatch and reconciliation semantics.
- `docs/protocol/agent-extension-packaging.md`: Extension package layout, manifest compatibility fields, and source-origin model.
- `docs/protocol/approvals-and-tool-input.md`: Approval and server-initiated user-input flows.
- `docs/protocol/config-security-and-client-rules.md`: MCP config semantics, security model, and non-negotiable client rules.
- `docs/implementation-status.md`: Current code-level implementation status and known gaps versus planned behavior.

## How to use these docs

1. Start with `docs/prd.md` for product intent and acceptance criteria.
2. Use `docs/architecture.md` to align implementation boundaries and invariants.
3. Use `docs/codex-app-server.md` as the protocol index, then open the focused file under `docs/protocol/` for the concern you are implementing.
4. Use `docs/ops.md` as the operations index, then open the focused file under `docs/operations/` for setup, validation, troubleshooting, or maintenance tasks.
5. Use `docs/implementation-status.md` to understand current implementation coverage and residual gaps.
