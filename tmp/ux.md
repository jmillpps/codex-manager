# Codex Manager UX Architecture and Integration Blueprint

_Last updated: 2026-02-16_

## 1) Purpose and scope

This document is the UX companion to `tmp/gaps.md`.

`tmp/gaps.md` answers: "what is missing across the Codex app-server surface?"

This document answers:

- How all those missing (and existing) capabilities should work together as one coherent product.
- Where each capability should live in the UI to avoid clutter and confusion.
- How backend and frontend responsibilities should be split so behavior is predictable.
- What interaction patterns should be shared so user experience feels consistent.
- How to phase implementation so quality remains high while surface area grows.

This is intentionally comprehensive and execution-oriented.

## 2) Product UX north star

The product should feel like a high-trust, local-first agent console where:

- Everyday chat remains simple and fast.
- Advanced controls exist, but do not pollute primary workflow.
- All runtime states are visible and explainable.
- User always knows what is happening, what is blocked, and what action can unblock it.
- Integrations and approvals feel native, not bolted-on.

## 3) Core user mental model

The user should only need one mental model:

- "I am in a chat thread."
- "Chat output streams in center pane."
- "Thread-level actions are in thread header/menu."
- "Operational status and deep telemetry are in a side drawer."
- "Global runtime setup is in Settings/Integrations."

Everything should reinforce this model.

## 4) UX architecture: the 4 interaction lanes

### 4.1 Primary lane (center chat)

Purpose:

- Conversational flow and immediate task progression.

Contains:

- Transcript
- Inline approval cards
- Inline tool-input cards
- Inline errors and retry affordances
- Composer and send controls

Do not place here:

- Global config editors
- Account management
- Dense integration admin controls

### 4.2 Thread lane (chat header + chat context menu)

Purpose:

- Controls that change thread trajectory/history.

Contains:

- Rename
- Fork
- Start review
- Compact context
- Rollback
- Archive/Restore
- Delete permanently
- Project move actions

Do not place here:

- Account login/logout
- MCP server management
- Cross-thread/global settings

### 4.3 Insight lane (right drawer)

Purpose:

- Explain what the agent/runtime is doing in near real time.

Contains tabs:

- Plan (`turn/plan/updated`)
- Diff (`turn/diff/updated`)
- Usage (`thread/tokenUsage/updated`)
- Tools (rich item stream breakdown)

Do not place here:

- Destructive actions
- Core composer actions

### 4.4 System lane (settings + integrations)

Purpose:

- Global runtime and connector configuration.

Contains:

- Account status/login/logout/rate limits
- MCP server status + OAuth + reload
- App list
- Skills list/config
- Collaboration mode
- Config read/write and requirements
- Experimental capabilities visibility

Do not place here:

- Session-specific prompt actions
- Thread-scoped mutating actions

## 5) Exact information architecture and placement

### 5.1 Left sidebar

Keep focused on navigation only:

- Projects tree
- Your chats
- Archive toggle
- Chat/project context menus

No heavy runtime controls here.

### 5.2 Chat header

Should include:

- Current model selector
- Runtime status badge (`Idle`, `Streaming`, `Waiting for approval`, `Needs input`, `Error`)
- Thread actions menu (trajectory/history actions)
- Optional open/close toggle for insight drawer

### 5.3 Transcript body

Should include:

- User + assistant messages
- System/tool event cards
- Approval request cards
- Tool/user-input request cards
- Turn-level failures with clear causes and next-step actions

### 5.4 Composer footer

Idle state:

- Text input + Send

Streaming state:

- Text input still available
- `Steer` (non-destructive correction)
- `Interrupt` (abort)

### 5.5 Right drawer

Tab structure:

- Plan
- Diff
- Usage
- Tools

Drawer should remember last selected tab per session.

### 5.6 Settings / Integrations modal

Sections:

- Account
- MCP
- Apps
- Skills
- Collaboration
- Config
- Experimental (read-only discovery)

## 6) Feature relationships and how they should work together

### 6.1 Unified “Action Required” pipeline

The following are the same UX class and should share one card pattern + queue model:

- Approval requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, compatibility request types)
- `tool/requestUserInput`

Shared UX traits:

- Common title: `Action required`
- Common metadata area: thread, turn, item, timestamp
- Common decision buttons: accept/decline/cancel when applicable
- Common persistence behavior in transcript
- Common websocket event lifecycle for created/resolved states

### 6.2 Streaming controls relationship

`turn/steer` and `turn/interrupt` should be adjacent while a turn is active:

- `Steer` is "try to save this turn"
- `Interrupt` is "stop this turn now"

Design implication:

- Never hide `Interrupt` behind menus while streaming.
- `Steer` can be secondary but discoverable.

### 6.3 Thread trajectory controls relationship

These belong together in the thread actions menu:

- Fork
- Review start
- Compact
- Rollback

Why:

- They all alter how the thread continues, not just single-message display.

### 6.4 Integration controls relationship

These should share one Integrations panel:

- `app/list` + `app/list/updated`
- `mcpServerStatus/list`
- `mcpServer/oauth/login` + completion event
- `config/mcpServer/reload`

Why:

- They all model connector readiness and authentication state.

### 6.5 Account controls relationship

These should share one account panel:

- `account/read`
- `account/login/start`
- `account/login/cancel`
- `account/logout`
- `account/rateLimits/read`

Why:

- All are global runtime auth lifecycle concerns.

### 6.6 Config/capability controls relationship

These belong in one advanced settings area:

- `config/read`, `config/value/write`, `config/batchWrite`
- `configRequirements/read`
- `experimentalFeature/list`
- `collaborationMode/list`

Why:

- These control behavior at platform-level and need guardrails.

## 7) UX principles that must hold

1. Capability-driven rendering: controls are shown/hidden or enabled/disabled by runtime support.
2. No dead-end errors: every error includes a next recommended action.
3. Progressive disclosure: advanced controls should not crowd default chat use.
4. Consistent confirmations: destructive/high-risk actions always confirm.
5. Stable status vocabulary: users should see the same state labels everywhere.
6. Reversible-by-default where possible (except explicit permanent delete).
7. Cross-client consistency: websocket updates should keep all open clients aligned.

## 8) Canonical state model (UX contract)

### 8.1 Session runtime states

- `idle`
- `streaming`
- `waiting_approval`
- `waiting_user_input`
- `interrupted`
- `failed`

### 8.2 Item states

- `in_progress`
- `completed`
- `declined`
- `failed`
- `canceled`

### 8.3 Sidebar/session visibility states

- `active`
- `archived`
- `deleted` (hard-gone, blocked modal if active)
- `non_materialized` (loaded-memory only)

### 8.4 Transition behavior

- `non_materialized -> materialized` after first successful user turn start/completion.
- `active -> archived` by archive action.
- `active/archived -> deleted` by hard delete.
- Deleted active thread forces right-pane block until re-selection.

## 9) Existing constraints that UX must reflect

### 9.1 Non-materialized semantics

- Non-materialized threads may exist only in loaded-memory state prior to first rollout.
- They may disappear after process restart.

UX requirements:

- Badge non-materialized sessions subtly.
- For archive actions, show clear disabled reason/tooltips.
- In settings/help, explain persistence caveat.

### 9.2 Archive behavior constraints

- Non-materialized sessions cannot be archived.

UX requirements:

- Archive action disabled with explicit reason.
- Move-to-project remains available for non-materialized sessions.

### 9.3 Deletion behavior constraints

- Hard delete purges from disk and returns `410` afterward.

UX requirements:

- Strong confirmation dialog.
- Block active right pane with non-dismissable modal until user navigates to another valid session.

## 10) Frontend architecture guidance for flawless UX

Current `apps/web/src/App.tsx` is doing many responsibilities. To keep UX quality high as features expand, split it into feature modules.

Recommended decomposition:

- `components/layout/AppShell.tsx`
- `components/sidebar/Sidebar.tsx`
- `components/sidebar/ProjectTree.tsx`
- `components/transcript/TranscriptView.tsx`
- `components/transcript/ActionRequiredCard.tsx`
- `components/composer/Composer.tsx`
- `components/drawer/InsightDrawer.tsx`
- `components/settings/SettingsModal.tsx`
- `hooks/useWebsocketStream.ts`
- `hooks/useSessionState.ts`
- `hooks/useCapabilities.ts`
- `hooks/useApprovalsAndInputs.ts`

### 10.1 Unified card components

Create shared components:

- `ActionRequiredCard` for approvals and tool/user-input requests.
- `RuntimeEventCard` for tool/system events.
- `ErrorCard` with standard retry/help actions.

### 10.2 Consistent menu system

All context menus should use a common floating-menu primitive with:

- Portal-based rendering
- Right-opening behavior with viewport fallback
- Keyboard navigation
- Shared hover and focus semantics

### 10.3 Capability-aware controls

Implement a capability context provider from API data and gate controls centrally.

## 11) Backend architecture guidance for flawless UX

### 11.1 Add typed Codex method wrapper layer

Create a typed adapter module so route handlers are straightforward.

Benefits:

- Better runtime error mapping.
- Easier feature gating and testing.

### 11.2 Expand websocket event typing

Current websocket forwards many events as generic notifications. Introduce typed envelopes for key UX surfaces:

- `turn_plan_updated`
- `turn_diff_updated`
- `thread_token_usage_updated`
- `tool_user_input_requested`
- `tool_user_input_resolved`
- `app_list_updated`
- `mcp_oauth_completed`
- account lifecycle updates

### 11.3 Server-request router

Instead of generic reject for unknown server requests:

- Route known request families (`approval`, `tool/requestUserInput`, future dynamic tool calls).
- Persist pending actions in-memory with robust lifecycle cleanup.

### 11.4 Capability endpoint

Add endpoint like `GET /api/capabilities` returning:

- Supported methods
- Experimental flags
- Feature families enabled
- Version info and optional warnings

### 11.5 Error normalization contract

Map Codex RPC error classes to stable API error codes/messages for frontend consistency.

## 12) UX flows (end-to-end)

### 12.1 Standard chat flow

1. User selects/creates session.
2. User sends prompt.
3. Transcript streams assistant delta and item events.
4. Runtime status transitions `Idle -> Streaming -> Idle`.
5. If failure: inline error card with retry.

### 12.2 Streaming with steering

1. Turn active.
2. User sees `Steer` + `Interrupt`.
3. `Steer` submits directional guidance to active turn.
4. Transcript continues under same turn id.
5. If steer rejected/fails, user can still interrupt.

### 12.3 Approval flow

1. Server sends approval request.
2. Transcript gets Action Required card.
3. User accepts/declines/cancels (scope if relevant).
4. Resolution card appended/updated.
5. Pending queue and state badges update.

### 12.4 Tool user-input flow

1. Server sends `tool/requestUserInput`.
2. Action Required card renders options and explanatory context.
3. User decision submitted.
4. Tool-call item continues or completes with error status.

### 12.5 Project move flow (including non-materialized)

1. User opens chat context menu.
2. Uses `Move` submenu to project/Your Chats/Archive where valid.
3. Session row updates via websocket + local optimistic update.
4. If non-materialized + archive path selected, show blocked reason.

### 12.6 Thread history operations

- Fork: creates and selects child thread.
- Review start: opens review context with review badge.
- Compact: starts and tracks compaction lifecycle.
- Rollback: confirms and updates transcript/history state.

## 13) Visual and interaction quality targets

### 13.1 Density and hierarchy

- Sidebar stays compact and scan-friendly.
- Transcript remains dominant visual focus.
- Advanced controls are discoverable but visually secondary.

### 13.2 Motion and transitions

- Subtle transition for menu/drawer open-close.
- No heavy animation on high-frequency streaming updates.

### 13.3 Hover/focus behavior

- Row highlight persists when hovering menu trigger.
- Trigger itself gets slightly stronger chip highlight.
- Keyboard focus ring must be visible and consistent.

### 13.4 Destructive action styling

- Destructive text color communicates risk.
- Danger background appears on hover/focus only.

## 14) Accessibility requirements

1. Full keyboard access to all menus and submenus.
2. ARIA roles for menus/cards/dialogs correctly applied.
3. Screen-reader announcements for action-required and turn state changes.
4. Sufficient contrast in status chips and disabled text/tooltips.
5. Focus management in modal flows (especially deleted-active-session blocker).

## 15) Reliability and consistency requirements

1. Reconnect logic must preserve selected session and pending action state.
2. Duplicate websocket events should be idempotently handled.
3. Pagination + section hiding should never remove access to load-more controls.
4. Cross-client updates (delete/project move/rename) must synchronize deterministically.
5. Any unsupported runtime method should fail gracefully with explanatory messaging.

## 16) Security and safety posture in UX

1. High-risk actions require confirmation (`delete`, `rollback`, config writes, logout, command exec).
2. Approval scope must be explicit (`turn` vs `session`) when applicable.
3. Never auto-accept server requests.
4. Tool and command actions should show human-readable context before decision.

## 17) Telemetry and observability suggestions

Capture frontend analytics/events for:

- Action-required card shown/resolved/timeout.
- Steer usage and outcome.
- Interrupt usage frequency.
- Failure categories and recovery actions.
- MCP OAuth start/completion failures.
- Drawer tab usage (Plan/Diff/Usage/Tools).

Capture backend diagnostics for:

- Unsupported server request methods.
- RPC method failure rates and timeouts.
- Capability mismatch events.

## 18) Testing strategy aligned to UX quality

### 18.1 API tests

- Contract tests for each new endpoint.
- Method capability unavailable scenarios.
- Error mapping correctness.
- Server-request routing behavior.

### 18.2 Frontend unit/integration tests

- Capability-gated rendering.
- Menu and submenu behavior.
- Action Required card lifecycle.
- Streaming state controls (`Steer`/`Interrupt`).

### 18.3 Playwright end-to-end tests

- Streaming + steer + interrupt flow.
- Approval and tool/requestUserInput flow.
- Thread fork/review/rollback/compact flows.
- Integrations panel (MCP OAuth + reload).
- Account lifecycle screens.

## 19) Execution roadmap focused on UX coherence

### Phase 1 (foundation)

- Introduce capability endpoint + client capability context.
- Implement unified Action Required model for approvals and tool input requests.
- Add right drawer skeleton with placeholder tabs.

### Phase 2 (high-value runtime insight)

- Implement `turn/plan/updated`, `turn/diff/updated`, `thread/tokenUsage/updated` in drawer.
- Implement `config/mcpServer/reload` + MCP OAuth flows.

### Phase 3 (thread control maturity)

- Implement `thread/fork`, `turn/steer`, `thread/compact/start`, `thread/rollback`, `review/start`.
- Wire to chat header thread actions.

### Phase 4 (platform/admin surface)

- Implement account lifecycle endpoints and UI.
- Implement config read/write surfaces with safeguards.
- Implement app/skills/collab discovery and selective controls.

### Phase 5 (advanced and experimental)

- Background terminals clean.
- Direct command/exec (if product policy approves).
- Experimental controls behind strict feature flags.

## 20) Feature-to-UI and feature-to-backend map

### 20.1 Primary lane (transcript/composer)

- `turn/start`, `turn/interrupt`, `turn/steer`
- approvals
- `tool/requestUserInput`
- item and error stream handling

### 20.2 Thread lane (header/session menu)

- rename
- archive/restore/delete
- `thread/fork`
- `review/start`
- `thread/compact/start`
- `thread/rollback`

### 20.3 Insight lane (right drawer)

- `turn/plan/updated`
- `turn/diff/updated`
- `thread/tokenUsage/updated`
- deep tool activity representation

### 20.4 System lane (settings/integrations)

- account lifecycle + rate limits
- MCP status/oauth/reload
- app list
- skills
- collaboration modes
- config + requirements
- experimental feature inventory

## 21) Definition of “flawless UX” for this product

A release should be considered UX-complete when:

1. A user can accomplish common tasks without opening settings.
2. Every advanced feature is discoverable in a logical location.
3. Runtime state is always legible (no silent failure states).
4. Action-required items are unified and unambiguous.
5. Destructive/high-risk actions are guarded and reversible when possible.
6. Multi-client behavior stays consistent under websocket updates.
7. Capability mismatches degrade gracefully and visibly.

## 22) Open UX decisions to settle before large implementation push

1. Should `Steer` be inline text in composer or modal input?
2. Should right drawer default open on streaming/tool-heavy turns?
3. For review mode, do we prefer detached thread by default or inline?
4. Should account panel be in top nav popover or settings modal only?
5. Which config keys, if any, are writable from UI initially?
6. How much of skills surface is exposed in v1 vs hidden behind advanced toggle?

## 23) Final synthesis

The system is already strong in core chat/project/delete/approval fundamentals.

To reach a truly flawless UX while expanding Codex app-server coverage, the key is not adding isolated buttons. The key is preserving a strict separation of concerns:

- primary chat flow stays clean,
- thread controls stay thread-scoped,
- deep observability lives in a dedicated drawer,
- global integrations/auth/config live in system settings,
- action-required interactions are unified.

If this architecture is followed, the backend and frontend can grow significantly without degrading usability.
