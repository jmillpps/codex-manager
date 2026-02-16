# Codex Manager Gap Inventory vs Codex App-Server Surface

_Last updated: 2026-02-16_

## 1) Scope of this gap analysis

This document compares the Codex app-server surface documented in `docs/codex-app-server.md` with what is currently implemented in this repository.

It covers:

- Missing Codex RPC methods that are documented but not exposed by our API/UI.
- Missing event-stream behaviors that are documented but not yet handled as first-class UX.
- Where each gap should most likely be implemented in:
  - API/Harness layer (`apps/api/src/index.ts`, `apps/api/src/codex-supervisor.ts`)
  - Web frontend/UI layer (`apps/web/src/App.tsx` and adjacent UI components)
- What each feature would add, and why it is valuable.

It does **not** assume every exposed Codex method must be productized immediately. Some are clearly advanced or operational. This doc still lists every gap so prioritization can be explicit.

## 2) Current implemented Codex method usage (baseline)

Currently implemented and wired (directly or indirectly):

- `initialize`, `initialized`
- `thread/start`, `thread/resume`, `thread/list`, `thread/loaded/list`, `thread/read`, `thread/name/set`, `thread/archive`, `thread/unarchive`
- `turn/start`, `turn/interrupt`
- `model/list`, `mcpServerStatus/list`
- Server-initiated approval requests handled for:
  - `item/commandExecution/requestApproval`
  - `item/fileChange/requestApproval`
  - plus compatibility with `execCommandApproval` / `applyPatchApproval`

## 3) Complete missing Codex RPC method inventory

These methods are documented by Codex app-server but are not implemented as first-class API routes/features in this solution yet:

- `thread/fork`
- `thread/compact/start`
- `thread/rollback`
- `thread/backgroundTerminals/clean` (experimental)
- `turn/steer`
- `review/start`
- `command/exec`
- `experimentalFeature/list`
- `collaborationMode/list`
- `skills/list`
- `skills/config/write`
- `skills/remote/read`
- `skills/remote/write`
- `app/list`
- `config/mcpServer/reload`
- `mcpServer/oauth/login`
- `tool/requestUserInput`
- `config/read`
- `config/value/write`
- `config/batchWrite`
- `configRequirements/read`
- `feedback/upload`
- `account/read`
- `account/login/start`
- `account/login/cancel`
- `account/logout`
- `account/rateLimits/read`

## 4) Cross-cutting implementation prerequisites

Before adding most missing methods, there are several cross-cutting improvements that should happen first.

### 4.1 Capability negotiation strategy

Current supervisor starts with `experimentalApi: false`. Several important surfaces are experimental or version-sensitive.

Most likely implementation:

- API/Harness:
  - Add capability/config discovery at startup (call `experimentalFeature/list`, `configRequirements/read` when available).
  - Persist capability map in memory and expose it via a new endpoint (example: `GET /api/capabilities`).
- Frontend/UI:
  - Read capabilities once on load and conditionally render controls.
  - Show disabled controls with explanatory tooltips when not available in the connected Codex runtime.

Benefit:

- Prevents shipping dead buttons for unsupported methods.
- Makes behavior deterministic across Codex version changes.

### 4.2 Method routing and typed wrapper layer

Current API code directly calls `supervisor.call()` inline inside route handlers.

Most likely implementation:

- API/Harness:
  - Create a dedicated Codex service module (example: `apps/api/src/codex-methods.ts`) with typed wrappers per RPC.
  - Keep route handlers thin (parse input, invoke wrapper, map errors).
- Frontend/UI:
  - No direct change required, but this stabilizes endpoint contracts for UI integration.

Benefit:

- Lower defect risk when method count grows.
- Easier to test and document each feature.

### 4.3 Server-initiated request handling expansion

Current `serverRequest` handling supports approvals and rejects other requests.

Most likely implementation:

- API/Harness:
  - Add a request router for server-initiated methods such as `tool/requestUserInput` and (if enabled) dynamic tool calls.
  - Convert requests into durable frontend-visible entities over websocket.
- Frontend/UI:
  - Add a unified “action required” panel for non-approval server requests.

Benefit:

- Unlocks richer Codex workflows that currently fail with unsupported request errors.

### 4.4 Endpoint and client consistency

Most likely implementation:

- API/Harness:
  - Introduce endpoint naming conventions by feature family (`/api/thread/*`, `/api/turn/*`, `/api/account/*`, `/api/config/*`).
- Frontend/UI:
  - Move API calls out of monolithic `App.tsx` into feature clients/hooks.

Benefit:

- Reduces coupling and simplifies UI growth.

## 5) Detailed gap-by-gap plan

Each section below explains what the method adds, where to implement it, and user-facing benefit.

---

## 5A) Thread lifecycle and history-control gaps

### A1. `thread/fork`

What it adds:

- Clone an existing thread into a new branch. This enables branch exploration without mutating original conversation history.

Most likely implementation:

- API/Harness:
  - Add `POST /api/sessions/:sessionId/fork` in `apps/api/src/index.ts`.
  - Call `thread/fork` and return the new session summary.
  - Emit websocket event (new session visible immediately in sidebar).
- Frontend/UI:
  - Add `Fork` action to session ellipsis menu in `apps/web/src/App.tsx`.
  - Auto-select new fork on completion with toast/banner indicating source thread.

Benefit:

- Safe experimentation and “what-if” branches.
- Better parity with modern chat branch workflows.

### A2. `thread/compact/start`

What it adds:

- Starts context compaction/reduction to control context-window pressure on long threads.

Most likely implementation:

- API/Harness:
  - Add `POST /api/sessions/:sessionId/compact`.
  - Relay completion/failure status through websocket notifications.
- Frontend/UI:
  - Add a `Compact context` action in session menu and optionally transcript toolbar.
  - Show progress/status chip in transcript header.

Benefit:

- Improves long-session reliability.
- Reduces token/context overflow risk.

### A3. `thread/rollback`

What it adds:

- Revert recent turns from active context while maintaining rollback markers.

Most likely implementation:

- API/Harness:
  - Add `POST /api/sessions/:sessionId/rollback` with `{ turns: number }`.
  - Refresh session transcript after rollback.
- Frontend/UI:
  - Add rollback action in session menu with explicit confirmation modal.
  - Expose quick rollback of 1 turn and advanced custom count.

Benefit:

- Fast recovery from bad steering or bad edits.
- Cleaner than hard delete/restart.

### A4. `thread/backgroundTerminals/clean` (experimental)

What it adds:

- Clears lingering background terminals attached to a thread.

Most likely implementation:

- API/Harness:
  - Add `POST /api/sessions/:sessionId/background-terminals/clean` behind capability check.
- Frontend/UI:
  - Show inside an “Advanced / Troubleshooting” submenu only.

Benefit:

- Operational cleanup for stuck shell resources.
- Improves local runtime hygiene.

---

## 5B) Turn-control gap

### B1. `turn/steer`

What it adds:

- Mid-stream steering instruction for an in-progress turn.

Most likely implementation:

- API/Harness:
  - Add `POST /api/sessions/:sessionId/turns/:turnId/steer`.
- Frontend/UI:
  - Show `Steer` control while streaming (next to Cancel).
  - Open lightweight inline input (single-line steer directive).

Benefit:

- Higher turn salvage rate without interrupting and restarting.
- Better control for long-running agent actions.

---

## 5C) Review-mode gap

### C1. `review/start`

What it adds:

- Native review workflow from Codex (inline or detached) with review thread semantics.

Most likely implementation:

- API/Harness:
  - Add `POST /api/sessions/:sessionId/review` with mode + prompt.
  - Support returned `reviewThreadId` behavior.
- Frontend/UI:
  - Add `Start review` action in transcript toolbar.
  - Add review-mode badges and clear navigation between main thread and review thread.

Benefit:

- Structured review workflows with explicit review lifecycle.
- Better code-review UX than generic prompting.

---

## 5D) Direct command execution gap

### D1. `command/exec`

What it adds:

- Explicit out-of-band command execution request via Codex runtime.

Most likely implementation:

- API/Harness:
  - Add `POST /api/commands/exec` with strict allowlist and approval integration.
- Frontend/UI:
  - Add advanced panel for command execution with visible cwd and confirmation.

Benefit:

- Useful for operational workflows where command execution is intentional and explicit.
- Can standardize logs and audit trail through Codex event stream.

---

## 5E) Discovery/capabilities gaps

### E1. `experimentalFeature/list`

What it adds:

- Runtime visibility into experimental features exposed by the connected Codex build.

Most likely implementation:

- API/Harness:
  - Add `GET /api/features/experimental`.
- Frontend/UI:
  - Use to gate advanced controls and show environment capability panel.

Benefit:

- Version-aware UX and fewer runtime surprises.

### E2. `collaborationMode/list`

What it adds:

- Discover collaboration modes and valid settings.

Most likely implementation:

- API/Harness:
  - Add `GET /api/collaboration/modes`.
- Frontend/UI:
  - Add a collaboration mode selector in top bar or session settings.

Benefit:

- Enables explicit multi-agent posture control.

### E3. `app/list`

What it adds:

- Discover available app connectors/tools at runtime.

Most likely implementation:

- API/Harness:
  - Add `GET /api/apps`.
  - Subscribe to `app/list/updated` notifications and rebroadcast as typed websocket events.
- Frontend/UI:
  - Add “Apps” panel showing availability/state.

Benefit:

- Makes integrations visible and actionable in UI.

---

## 5F) Skills-surface gaps

### F1. `skills/list`

What it adds:

- Enumerate available skills and metadata.

Most likely implementation:

- API/Harness:
  - Add `GET /api/skills`.
- Frontend/UI:
  - Add skill browser in settings or composer add-menu.

Benefit:

- Better discoverability for reusable workflows.

### F2. `skills/config/write`

What it adds:

- Write skill configuration.

Most likely implementation:

- API/Harness:
  - Add `POST /api/skills/config` with validation.
- Frontend/UI:
  - Add skill settings editor dialog.

Benefit:

- Allows project-specific skill tuning without manual file edits.

### F3. `skills/remote/read` and `skills/remote/write`

What they add:

- Remote skill synchronization and management (under development in upstream).

Most likely implementation:

- API/Harness:
  - Add feature-flagged endpoints only when runtime advertises support.
- Frontend/UI:
  - Keep hidden by default; expose under experimental settings.

Benefit:

- Future-ready path for team skill sharing once stable.

---

## 5G) MCP configuration and OAuth gaps

### G1. `config/mcpServer/reload`

What it adds:

- Reload MCP config without restarting API/Codex process.

Most likely implementation:

- API/Harness:
  - Add `POST /api/mcp/reload`.
- Frontend/UI:
  - Add `Reload` control in MCP panel (`apps/web/src/App.tsx` mcp section).

Benefit:

- Faster MCP iteration and fewer disruptive restarts.

### G2. `mcpServer/oauth/login`

What it adds:

- Initiates OAuth flow for MCP server requiring auth.

Most likely implementation:

- API/Harness:
  - Add `POST /api/mcp/servers/:serverName/oauth/login`.
  - Forward completion from `mcpServer/oauthLogin/completed` notification.
- Frontend/UI:
  - Add `Connect` action per MCP server row with pending state.

Benefit:

- Production-grade connector onboarding inside the app.

---

## 5H) Server-initiated user-input flow gap

### H1. `tool/requestUserInput`

What it adds:

- Server asks the user to choose/confirm inputs for certain tool calls.

Current gap behavior:

- Non-approval server requests are currently rejected as unsupported.

Most likely implementation:

- API/Harness:
  - Extend `serverRequest` handling in `apps/api/src/index.ts`.
  - Persist pending user-input requests similar to approvals.
  - Add response endpoint: `POST /api/tool-input/:requestId/decision`.
- Frontend/UI:
  - Add request cards in transcript (parallel to approvals) with accept/decline/cancel and option rendering.

Benefit:

- Unlocks full tool-call flows that otherwise fail.
- Critical for robust MCP/app interactions.

---

## 5I) Config-surface gaps

### I1. `config/read`

What it adds:

- Read effective Codex config values.

Most likely implementation:

- API/Harness:
  - Add `GET /api/config`.
- Frontend/UI:
  - Show read-only configuration panel for diagnostics.

Benefit:

- Faster troubleshooting and environment transparency.

### I2. `config/value/write`

What it adds:

- Write one config value.

Most likely implementation:

- API/Harness:
  - Add `POST /api/config/value` with strict key allowlist.
- Frontend/UI:
  - Inline setting controls with confirmation for high-risk values.

Benefit:

- Runtime tuning without file edits/restarts (when supported).

### I3. `config/batchWrite`

What it adds:

- Atomically update multiple config values.

Most likely implementation:

- API/Harness:
  - Add `POST /api/config/batch`.
- Frontend/UI:
  - Use this for “Save settings” forms.

Benefit:

- Consistent config updates and fewer partial-state errors.

### I4. `configRequirements/read`

What it adds:

- Read required config/environment constraints from runtime.

Most likely implementation:

- API/Harness:
  - Add `GET /api/config/requirements`.
- Frontend/UI:
  - Show requirement warnings and action hints in settings/health.

Benefit:

- Proactive setup validation and reduced boot-time confusion.

---

## 5J) Feedback-surface gap

### J1. `feedback/upload`

What it adds:

- Upload structured feedback payloads.

Most likely implementation:

- API/Harness:
  - Add `POST /api/feedback`.
- Frontend/UI:
  - Add feedback action on failed turns and destructive-flow confirmations.

Benefit:

- Better product observability and user support loop.

---

## 5K) Account/auth lifecycle gaps

### K1. `account/read`

What it adds:

- Authoritative account/auth mode details from runtime.

Most likely implementation:

- API/Harness:
  - Add `GET /api/account`.
- Frontend/UI:
  - Replace coarse auth hints with actual account state card.

Benefit:

- Accurate auth state; less ambiguity than env-file inference.

### K2. `account/login/start` and `account/login/cancel`

What they add:

- Start/cancel interactive login flow.

Most likely implementation:

- API/Harness:
  - Add `POST /api/account/login/start` and `POST /api/account/login/cancel`.
  - Stream `account/login/completed` to UI.
- Frontend/UI:
  - Add login modal with progress state and cancel control.

Benefit:

- First-class auth onboarding without dropping to CLI.

### K3. `account/logout`

What it adds:

- Explicit logout from runtime auth mode.

Most likely implementation:

- API/Harness:
  - Add `POST /api/account/logout`.
- Frontend/UI:
  - Add logout action in account panel with confirmation.

Benefit:

- Clean auth lifecycle management for shared/local workstations.

### K4. `account/rateLimits/read`

What it adds:

- Current rate-limit budget and reset windows.

Most likely implementation:

- API/Harness:
  - Add `GET /api/account/rate-limits`.
  - Optionally cache for a short TTL.
- Frontend/UI:
  - Show limit status near model selector or account panel.

Benefit:

- Better user expectations and reduced “random failure” perception.

---

## 5L) Event-stream handling gaps (non-method but still major surface gaps)

The Codex stream exposes additional events that are currently not treated as first-class UX.

### L1. `turn/diff/updated`

Most likely implementation:

- API/Harness: pass through typed event as-is over websocket.
- Frontend/UI: add “Diff” drawer in transcript header for live aggregated patch view.

Benefit:

- Immediate visibility into file mutations during long turns.

### L2. `turn/plan/updated`

Most likely implementation:

- API/Harness: pass through typed event.
- Frontend/UI: show live plan tracker panel (pending/in-progress/completed).

Benefit:

- Dramatically improved observability of agent progress.

### L3. `thread/tokenUsage/updated`

Most likely implementation:

- API/Harness: pass through typed event.
- Frontend/UI: token/usage widget near model/runtime status.

Benefit:

- Helps avoid silent usage surprises and debugging guesswork.

### L4. `app/list/updated`

Most likely implementation:

- API/Harness: subscribe and publish dedicated websocket event (not generic fallback).
- Frontend/UI: live-refresh Apps panel content.

Benefit:

- Connector state stays current without full refresh.

### L5. `mcpServer/oauthLogin/completed`

Most likely implementation:

- API/Harness: correlate login attempts and notify all clients.
- Frontend/UI: resolve pending OAuth indicators and refresh MCP server status.

Benefit:

- Reliable OAuth completion UX and reduced confusion.

---

## 6) Suggested implementation sequence (pragmatic)

### Phase 1: Highest leverage / lowest risk

- `config/mcpServer/reload`
- `mcpServer/oauth/login` + `mcpServer/oauthLogin/completed`
- `account/read` + `account/rateLimits/read`
- `turn/plan/updated`, `turn/diff/updated`, `thread/tokenUsage/updated` UI handling

Why first:

- Strong operational value.
- Minimal disruption to core chat flow.

### Phase 2: Workflow quality improvements

- `thread/fork`
- `turn/steer`
- `thread/compact/start`
- `thread/rollback`
- `review/start`

Why next:

- Directly improves day-to-day interaction quality and control.

### Phase 3: Advanced integrations/configuration

- `tool/requestUserInput`
- `app/list` and updates
- `skills/*` and `collaborationMode/list`
- `config/read`, `config/value/write`, `config/batchWrite`, `configRequirements/read`
- `feedback/upload`

Why later:

- Larger UI/modeling surface and more edge cases.

### Phase 4: Niche/experimental operations

- `thread/backgroundTerminals/clean`
- `command/exec`
- `experimentalFeature/list`
- `account/login/start` / `cancel` / `logout` (if account mode strategy finalized)

Why last:

- Either experimental, operationally sensitive, or requiring stronger security/UX policy decisions.

---

## 7) Security and approval considerations for these gaps

Many missing features interact with command execution, tool side effects, auth, or runtime config. Each implementation should include:

- Explicit user confirmations for destructive actions (`rollback`, config writes, logout, command exec).
- Approval-scope clarity (turn vs session) for all new action cards.
- Clear error mapping from Codex RPC errors to stable API/UI messages.
- Capability checks before rendering action controls.

---

## 8) Testing expectations per gap family

For each newly implemented method, add:

- API contract tests:
  - success path
  - unsupported-capability path
  - permission/approval rejection path (if applicable)
  - codex rpc timeout/error mapping
- Frontend integration tests (Playwright where useful):
  - control visibility/disabled state based on capability
  - websocket event handling and UI updates
  - retry and error-display behavior

This is critical because many of these features are stateful and event-driven.

---

## 9) Final note

The largest practical gap is not a single endpoint; it is the missing “capability-aware runtime control layer” across API + UI. Implementing that layer first will make all remaining method integrations safer, more predictable, and significantly faster to add.
