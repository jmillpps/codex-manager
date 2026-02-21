# Implementation Status

## Purpose

This document records what is implemented in code now and the current verification posture.

Use this with:

- `docs/prd.md` for product intent and acceptance criteria.
- `docs/architecture.md` for system boundaries/invariants.
- `docs/codex-app-server.md` and `docs/protocol/*` for protocol semantics.
- `docs/ops.md` and `docs/operations/*` for operational procedures.

## Last verified

- Date: February 21, 2026
- Validation run:
  - `pnpm --filter @repo/api typecheck` (pass)
  - `pnpm --filter @repo/api test` (pass)
  - `pnpm --filter @repo/web typecheck` (pass)
  - `pnpm --filter @repo/web test` (pass)

## Current implemented scope

### API (`apps/api`)

- Codex supervision and bridge:
  - Starts/supervises `codex app-server`.
  - Handles initialize lifecycle and forwards notifications to WebSocket clients.
- Session lifecycle:
  - list/create/read/resume/rename/archive/unarchive/delete.
  - project create auto-provisions a project orchestration chat and assigns it to the new project.
  - startup plus project/session list paths self-heal missing project-orchestration sessions by re-provisioning from metadata mappings.
  - hard delete is harness-level (disk purge + session tombstone + websocket broadcast) because app-server has no native `thread/delete`.
- Messaging and turn control:
  - send message (`turn/start`) and interrupt.
  - new user-created chats are initialized with a short sticky default title (`New chat`) and remain renameable via existing rename flow.
  - send message supports optional reasoning effort override (`effort`) and applies it to `turn/start`.
  - session controls API supports persisted per-chat and default tuples via `GET/POST /api/sessions/:sessionId/session-controls` with explicit scope (`session` / `default`), lock-aware default editing (`SESSION_DEFAULTS_LOCKED`), and audit-log transcript entries for control changes (`old -> new`, actor, source=`ui`).
  - send message applies the persisted session-controls tuple (`model`, approval policy, network access, filesystem sandbox) and still accepts optional per-turn overrides for compatibility.
  - thread lifecycle calls (`thread/start`, `thread/fork`, `thread/resume`) optimistically request `experimentalRawEvents` and automatically retry without it when unsupported (`requires experimentalApi capability`) so runtime compatibility is preserved across app-server versions.
  - queue-backed suggested reply APIs:
    - `POST /api/sessions/:sessionId/suggested-reply/jobs` enqueues `suggest_reply` and returns `202` with queue dedupe status.
    - `POST /api/sessions/:sessionId/suggested-reply` enqueues the same job and waits briefly (`ORCHESTRATOR_SUGGEST_REPLY_WAIT_MS`) before returning `200` suggestion or `202 queued`.
    - suggest-reply jobs are single-flight per source chat (`already_queued` dedupe when one is queued/running).
  - suggest-reply generation supports optional reasoning effort override (`effort`) for suggestion-generation turns.
  - suggest-reply helper fallback is disabled by default in queue mode; optional helper fallback is controlled by `ORCHESTRATOR_SUGGEST_REPLY_ALLOW_HELPER_FALLBACK`.
  - completed eligible `fileChange` items enqueue background `file_change_explain` jobs, and lifecycle writes synthetic explainability transcript rows anchored to the source diff item.
  - orchestrator queue inspection/cancel APIs:
    - `GET /api/orchestrator/jobs/:jobId`
    - `GET /api/projects/:projectId/orchestrator/jobs`
    - `POST /api/orchestrator/jobs/:jobId/cancel`
  - thread actions: fork, compact, rollback, background terminals clean, review start.
  - turn steering endpoint for active turns.
- Approvals + tool user-input:
  - pending approvals listing and decisions.
  - server-initiated tool user-input request ingestion and decision submission.
  - pending tool-input listing per session.
- Projects and session organization:
  - project create/list/rename/delete with optional per-project `workingDirectory` configuration.
  - project rename preserves existing `workingDirectory` when omitted from the request; explicit `null` clears it.
  - project `workingDirectory` changes re-provision the project orchestration session so suggested-reply orchestration uses the updated cwd immediately.
  - assign/unassign session to project.
  - bulk project chat move (`unassigned`/`archive`) and bulk project chat delete.
  - project orchestration sessions start in the project working directory when configured (fallback: workspace root).
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
  - orchestrator queue lifecycle events (`orchestrator_job_queued|started|progress|completed|failed|canceled`).
  - plan/diff/token-usage updates.
  - app/account/mcp update notifications.
- Error handling:
  - Codex RPC errors are mapped to structured HTTP responses (unsupported, invalid params, invalid state, auth required, timeout, fallback).
  - global Zod request-validation errors return HTTP 400 with validation issues.
- API lifecycle/status contracts:
  - `GET /api/sessions` merges persisted `thread/list` output with `thread/loaded/list` so newly created, non-materialized chats appear immediately.
  - Session summaries expose `materialized` (`true` when backed by persisted rollout state; `false` for loaded in-memory threads read via `includeTurns: false` fallback).
  - Session summaries expose `projectId` (`string | null`) so assigned chats render under project sections and unassigned chats render under `Your chats`.
  - System-owned orchestration/helper sessions are hidden from session lists and denied for normal chat operations with HTTP `403` + `code: "system_session"`.
  - Session summaries expose `sessionControls` (`model | approvalPolicy | networkAccess | filesystemSandbox`) and retain `approvalPolicy` for backward compatibility.
  - `POST /api/sessions/:sessionId/approval-policy` and `POST /api/sessions/:sessionId/messages` now require the target session to resolve via runtime existence checks; unknown/invalid/deleted-after-restart ids return `404 not_found` and do not create session-control metadata entries.
  - `POST /api/sessions/:sessionId/messages` persists per-chat session controls only after turn acceptance (`202`), preventing orphan control writes when `turn/start` fails.
  - Startup prunes stale `sessionControlsById` / `sessionApprovalPolicyById` entries whose session ids are no longer known to active, archived, or loaded runtime threads.
  - Non-materialized sessions are movable/assignable but are not guaranteed to survive API/Codex restart before first-turn rollout materialization.
  - `POST /api/sessions/:sessionId/archive` returns HTTP `409` + `status: "not_materialized"` when no rollout exists yet.
  - `DELETE /api/sessions/:sessionId` returns `status: "ok"` on successful purge, `status: "not_found"` when the session cannot be resolved, and returns HTTP `410` deleted payloads for already-purged ids.
  - `DELETE /api/projects/:projectId` returns HTTP `409` + `status: "project_not_empty"` only for live assigned chats after stale assignment metadata is pruned.
  - `POST /api/projects/:projectId/chats/move-all` with `destination: "archive"` returns HTTP `409` + `status: "not_materialized_sessions"` and explicit `sessionIds` when any assigned chat lacks rollout state.
  - `POST /api/sessions/:sessionId/project` supports loaded non-materialized sessions, so chats can be moved between projects before first message.
  - Session transcript entries now include optional `startedAt`/`completedAt` turn-timing values (epoch ms) when available from live turn lifecycle capture or persisted session metadata.
  - `GET /api/sessions/:sessionId` transcript now merges a supplemental runtime event ledger built from websocket `item/*` notifications and approval/tool-input server requests, preserving command/file/tool/approval audit rows when `thread/read(includeTurns)` omits them in non-experimental runtimes.
  - Supplemental runtime transcript ledger is persisted to `.data/supplemental-transcript.json` and reloaded at startup so thought-block audit rows (approvals/command execution/file changes/tool-input events) survive API restarts.
  - Supplemental transcript merge is additive for existing turns (no anchor-based full-turn replacement), so base historical tool rows are retained when supplemental snapshots are partial.
  - Transcript assembly now canonicalizes per-turn synthetic `item-N` rows emitted by raw-events fallbacks: when a canonical same-turn item exists, matching synthetic duplicates are removed (including duplicate user/assistant/reasoning rows) so reload/restart does not double-render thought content.
  - Supplemental transcript rows now capture locally observed item timing (`startedAt`/`completedAt`) when Codex item payloads omit timestamps, and merge/upsert logic preserves earliest start plus latest completion per item id for stronger post-restart timing fidelity.
  - `POST /api/sessions/:sessionId/suggested-reply` now builds context from the same merged/canonicalized transcript pipeline as `GET /api/sessions/:sessionId`, keeping suggested-reply context consistent with visible chat history after reload/restart.
  - `GET /api/health` exposes orchestrator queue availability and state counters (`enabled`, queued/running/completed/failed/canceled/projects).
  - Explainability supplemental transcript rows (`type: fileChange.explainability`) are upserted by stable message id and anchored after the corresponding file-change item when present in-turn.
  - Suggested-reply helper sessions remain harness metadata for optional fallback mode and are still filtered from `GET /api/sessions`, filtered from forwarded stream traffic, auto-declined/canceled for helper-thread approvals/tool-input requests, and cleaned on startup plus post-request finally cleanup.

### Web (`apps/web`)

- ChatGPT-like split-pane layout with independent sidebar/chat scrolling and fixed composer in right pane.
- Sidebar features:
  - collapsible `Projects` and `Your chats` sections.
  - archived view filtering with section visibility gating (only projects with archived chats are shown; empty `Projects`/`Your chats` sections are omitted).
  - session pagination with load-more controls for long chat lists.
  - compact rows with hover ellipsis actions.
  - project-level and chat-level context menus with nested move menus/flyouts, including project-scoped bulk operations and project-aware move destinations.
- Session/project actions:
  - create, rename, archive/unarchive, hard delete with confirmation.
  - project creation still provisions an orchestration session, but it is system-owned/hidden and does not render as a user chat row.
  - project creation/rename/delete, bulk move/delete chats, session assignment and move flows.
  - project context menu action to set/clear project working directory; new chats from that project start in that directory.
  - selected chat is persisted by `sessionId` in tab-scoped browser storage across page reloads/HMR so duplicate chat titles do not cause selection drift.
  - non-materialized session movement supported.
- Chat runtime features:
  - websocket reconnect/backoff.
  - disconnected websocket state now blocks the chat pane with a reconnect overlay/action until connectivity resumes.
  - send-message health check: when no turn/activity response arrives shortly after send, the UI marks websocket as effectively disconnected and prompts reconnect.
  - outgoing user bubbles include local delivery-state indicators (`Sending`, `Sent`, `Delivered`, `Failed`) with circle/check-style icons driven by optimistic send + websocket activity/timeout state.
  - incoming assistant responses show a live receive indicator (spinner) while turn activity is streaming and flip to a red disconnect marker if websocket drops mid-stream.
  - assistant completion adds a green check icon on final responses, and transcript rendering is memoized so composer typing does not re-render the full history on each keystroke.
  - transcript/approval/tool-input hydration on chat selection is request-id race-guarded, so stale fetches from previously selected chats cannot overwrite active-chat UI state after rapid chat switching.
  - transcript hydration preserves only unresolved local user bubbles (`Sending`/`Sent`/`Failed`) plus pending approval/tool-input rows, preventing duplicate delivered user bubbles after chat switches while keeping pending decision rows visible if transcript payloads lag.
  - message send/cancel/retry flows.
  - streamed transcript rendering always shows full turn chronology (no top-level transcript filter bar), and each turn card preserves full in-order thought activity (reasoning/tools/approvals) for auditability.
  - transcript tail-follow uses bottom-distance hysteresis (wider disengage threshold than re-engage threshold) to avoid flicker between follow/manual modes during rapid approval/event layout updates.
  - tail-follow + approval anchoring constants are explicitly tuned in `apps/web/src/App.tsx`: follow-mode disengage threshold `96px`, re-engage threshold `24px`, approve-click near-bottom arming threshold `128px`, manual snap-back release threshold `420px` from bottom, incoming-approval snap-back window `3200ms`, approve-click snap-back window `2600ms`, and delayed snap-back start `60ms` to avoid pre-layout jitter.
  - incoming approval requests for the active chat force-focus the tail and arm a short snap-back lock so approvals are visible immediately; approving while near the tail re-arms the same lock to stay anchored through approval grow/shrink + immediate follow-on item streaming; the lock auto-expires and cancels if the user intentionally scrolls far upward.
  - `Jump to bottom` is rendered as an absolute overlay in the transcript pane (not in scroll-content flow), so it no longer perturbs transcript height or bottom anchoring when shown/hidden.
  - transcript turn grouping renders one user request card plus one consolidated response card per turn.
  - response card layout is a single bubble: top thought area (shown only when the turn has reasoning/tool/approval activity) plus bottom final assistant response area.
  - final assistant response area renders Markdown (GFM tables/lists/strikethrough/task lists) via safe Markdown rendering (raw HTML is not executed), with inline code and block code styled for chat readability.
  - thought preview/header text and thought-line reasoning/agent message content also render through the same safe Markdown pipeline, so multiline reasoning updates and markdown-formatted progress notes keep structure (paragraphs/lists/code) instead of flattening into a single plain-text line.
  - inside expanded thought details, reasoning/agent markdown lines that start with a bold title prefix (`**Title** ...`) become collapsible section headers (caret indicator) that group all following thought activity until the next section header (or end of the thought block); when the header line has trailing text after the bold prefix, that trailing text is retained as the first line inside the section body; section-toggle hit targets are content-width (not full-row), while clicks in surrounding thought background still collapse the full thought panel.
  - thought status is keyed to active turn lifecycle state (not inferred from partial thought rows): while the selected turn is active, the collapsed header shows a live progress preview (`Working...` until reasoning/agent progress text is available, then latest progress text); once the turn reaches a terminal lifecycle notification (`turn/completed` or `turn/failed`) it switches to `Worked for <duration>` using turn/message timing with `<1s` fallback for legacy timing gaps.
  - empty reasoning placeholders are auto-suppressed once completion can be inferred (turn ended, later meaningful events exist, or final assistant output is present/settled), preventing stale `thinking...` rows in completed turns.
  - thought disclosure keeps per-turn open/closed state stable across stream/approval updates; when a new pending approval/tool-input arrives while the panel is closed it auto-opens in pending-only preview, and users can explicitly expand to full prior activity. Pending resolution no longer force-flips panel mode, preventing abrupt pending-only/full layout churn mid-turn. Expanded mode hides the collapsed header label for normal full view, while pending-only view shows the latest live reasoning/agent preview text above `Show prior activity` for context.
  - expanded thought panels collapse only from background/plain-thought clicks; clicks inside event/approval bubbles and their controls do not auto-collapse.
  - expanded thought details render reasoning summary/content line rows and inline tool/approval/tool-input context with actions.
  - command and file-change approvals render as compact action-first rows (`Approval required to run …`, `Approval required to create/modify/delete/move file …`) with inline decision actions; decision UX is websocket-authoritative (buttons enter submitting state locally, pending/resolved transitions are applied from runtime events, and a bounded fallback reconcile reloads pending approvals after submit if a resolution event is missed), approval rows are rendered only while pending (resolved/expired approval update rows are intentionally suppressed), pending file-change approvals include an inline dark-theme diff/content preview above decision buttons and suppress duplicate pending file-change item rows until approved, command-execution rows render inline terminal-style dark blocks (no nested wrapper bubble) with prompt lines whose `~` prefix is mapped to inferred user home from runtime cwd paths, and file-change rows render structured dark-theme diffs with add/remove/hunk/context coloring where displayed file paths and absolute home-path text in diff lines are normalized to `~`. Approval/tool-input hydration now merges late REST snapshots with newer websocket-delivered pending items for the active chat so fresh approval/input requests are not dropped by stale in-flight loads.
  - synthetic explainability transcript entries (`type: fileChange.explainability`) are rendered in thought details as markdown explainability blocks once queued background analysis rows complete.
  - composer uses a single message input; `Suggest Reply` populates that same draft box and `Ctrl+Enter` sends.
- chat view includes a pinned `Session Controls` panel that defaults to a collapsed summary chip and expands on demand, with explicit Apply/Revert semantics for `Model`, `Approval Policy` (`untrusted` / `on-failure` / `on-request` / `never`), `Network Access` (`restricted` / `enabled`), and `Filesystem Sandbox` (`read-only` / `workspace-write` / `danger-full-access`).
- approval policy values are canonical protocol literals end-to-end (`untrusted`, `on-failure`, `on-request`, `never`).
  - panel also exposes `Thinking Level` (`none` / `minimal` / `low` / `medium` / `high` / `xhigh`) as an immediate per-chat selector (local preference used on send/suggest), constrained to model-supported effort options when the selected model reports them.
  - after a successful `Apply`, and when switching chats, the panel auto-collapses into the summary chip so controls stay out of the way until reopened.
  - when no session-control tuple edits are pending, the primary action becomes `Close` so users can collapse the expanded panel without sending a no-op apply request.
  - scope toggle supports `This chat` vs `New chats default`; when defaults are harness-locked, `New chats default` remains viewable in read-only mode (lock icons + `Set by harness at session start`) while per-chat controls remain editable.
  - panel summary line is rendered in monospace as `<model> | <thinking> | <approval> | <network> | <sandbox>`; when the session model control is inherited, the model segment renders as `default (<resolved default model id>)` (or `default (default)` only when no default model id is available), announced for assistive tech as `Current session controls: ...`, and apply success surfaces a toast with the full applied tuple.
  - each summary segment is hover-descriptive (native tooltip) so users can inspect value semantics inline (`model`, `thinking`, `approval`, `network`, `sandbox`) without leaving the chat view; selector controls and selector options also expose matching tooltips for the currently selected value and available alternatives.
  - when approval policy is `never`, panel displays `Escalation requests disabled for this chat.` and runtime state avoids approval-focused copy.
  - model list hydration is normalized to one entry per model id, and same-session synchronization now preserves a valid local model/effort selection instead of reapplying fallback/session defaults during unrelated state updates.
  - suggest-reply interactions are queue-job guarded: duplicate clicks while a suggest job is pending are suppressed, and composer updates apply only when websocket completion events match the active request guard (`sessionId` + draft snapshot + request id + job id).
  - pending approval cards and approval decisions.
  - tool-input request cards with answer submission.
  - active-turn controls (interrupt + steer).
  - thread actions menu (fork/compact/rollback/review/background-terminals clean).
  - insight drawer (plan/diff/usage/tools), manually toggled by the user; incoming plan/diff events update stored insight data without auto-opening the drawer.
  - settings modal for capability/account/mcp/config/skills/apps visibility and actions.
- Deleted active-session UX:
  - right pane blocks interaction and requires selecting/creating another chat.

### API client and contracts

- OpenAPI/client generation covers core session/settings/account/tool-input APIs, but currently does not yet model all newer orchestrator/session-control surfaces in generated helper signatures (for example `/sessions/:id/session-controls`, queue-backed suggested-reply jobs endpoint, and orchestrator job inspection/cancel endpoints).
- Generated API client includes helpers for:
  - project bulk operations,
  - project creation with optional `orchestrationSession` response payload,
  - thread-control endpoints,
  - suggested-reply endpoint (`suggestSessionReply`) with optional `effort`,
  - message send endpoint (`sendSessionMessage`) with optional `effort`,
  - capability/settings/account/integration endpoints,
  - tool-input decision endpoint,
  - existing session/message/approval operations.

## Validation status

### Passing checks

- `pnpm --filter @repo/api typecheck`
- `pnpm --filter @repo/api test`
- `pnpm --filter @repo/web typecheck`
- `pnpm --filter @repo/web test`

### Current validation limitations

- `pnpm lint` is still placeholder-only in workspace packages; enforceable lint rules are not configured yet.
- Browser-level Playwright requires Linux shared libraries. Root `pnpm test:e2e*` commands now run through `scripts/run-playwright.mjs`, which bootstraps missing libs into `.data/playwright-libs` when `apt-get download` is available.
- `pnpm gen` can fail under restricted file-permission environments when writing `apps/api/openapi/openapi.json`; rerun contract generation in a writable environment before release.
- `pnpm test` can fail under restricted file-permission environments when creating runtime directories under `.data/`.
- `pnpm build` can fail under restricted file-permission environments when Vite writes temp files under `apps/web/node_modules/.vite-temp`.

## Known follow-up hardening work

- Expand API/web test coverage breadth beyond current contract/integration + smoke suites.
- Add CI-enforced lint rules instead of placeholder scripts.
- Add additional Playwright scenarios for deeper runtime behaviors (approvals lifecycle, tool-input decisions, insight drawer updates, and project bulk workflows).
