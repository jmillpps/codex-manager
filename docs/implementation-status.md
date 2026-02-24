# Implementation Status

## Purpose

This document records implemented code behavior and the current verification posture.

Use this with:

- `docs/prd.md` for product intent and acceptance criteria.
- `docs/architecture.md` for system boundaries/invariants.
- `docs/codex-app-server.md` and `docs/protocol/*` for protocol semantics.
- `docs/ops.md` and `docs/operations/*` for operational procedures.

## Last verified

- Date: February 23, 2026
- Validation run:
  - `pnpm --filter @repo/api typecheck` (pass)
  - `pnpm --filter @repo/api test` (pass)
  - `pnpm --filter @repo/web typecheck` (pass)
  - `pnpm --filter @repo/web test` (pass)
  - `pnpm smoke:runtime` (pass, with API running)
  - `node scripts/run-agent-conformance.mjs` (pass)

## Current implemented scope

### API (`apps/api`)

- Codex supervision and bridge:
  - Starts/supervises `codex app-server`.
  - Handles initialize lifecycle and forwards notifications to WebSocket clients.
- Session lifecycle:
  - list/create/read/resume/rename/archive/unarchive/delete.
  - project create stores project metadata only; system-owned agent chats are provisioned lazily on first queued agent job.
  - hard delete is harness-level (disk purge + session tombstone + websocket broadcast) because app-server has no native `thread/delete`.
- Messaging and turn control:
  - send message (`turn/start`) and interrupt.
  - new user-created chats are initialized with a short sticky default title (`New chat`) and remain renameable via existing rename flow.
  - send message supports optional reasoning effort override (`effort`) and applies it to `turn/start`.
  - session controls API supports persisted per-chat and default tuples via `GET/POST /api/sessions/:sessionId/session-controls` with explicit scope (`session` / `default`), lock-aware default editing (`SESSION_DEFAULTS_LOCKED`), and audit-log transcript entries for control changes (`old -> new`, actor, source=`ui`).
  - send message applies the persisted session-controls tuple (`model`, approval policy, network access, filesystem sandbox) and accepts optional per-turn overrides for compatibility.
  - thread lifecycle calls (`thread/start`, `thread/fork`, `thread/resume`) optimistically request `experimentalRawEvents` and automatically retry without it when unsupported (`requires experimentalApi capability`) so runtime compatibility is preserved across app-server versions.
  - queue-backed suggest-request APIs:
    - `POST /api/sessions/:sessionId/suggested-request/jobs` emits `suggest_request.requested`; repository supervisor enqueues one `agent_instruction` job (`jobKind: suggest_request`) and API returns `202` with queue dedupe status plus `requestKey`.
    - `POST /api/sessions/:sessionId/suggested-request` emits the same event, waits briefly (`ORCHESTRATOR_SUGGEST_REQUEST_WAIT_MS`) for queued completion, and returns either `200` suggested request text or `202 queued`.
    - `POST /api/sessions/:sessionId/suggested-request/upsert` updates streaming/terminal suggest-request state (`streaming|complete|error|canceled`) for a specific `requestKey` and emits websocket delta `suggested_request_updated`.
    - suggest-request jobs are single-flight per source chat (`already_queued` dedupe when one is queued/running).
    - unassigned-chat suggest-request jobs run under session-scoped owner ids (`session:<sessionId>`), so they do not require project assignment.
    - when no loaded agent event handler enqueues `suggest_request`, endpoints return structured queue conflict semantics instead of an unhandled server error.
  - transcript supplemental upsert API:
    - `POST /api/sessions/:sessionId/transcript/upsert` validates and upserts one transcript entry (`messageId`, `turnId`, `role`, `type`, `content`, `status`, optional `details` + timing), then emits `transcript_updated` websocket delta.
  - suggest-request generation supports optional reasoning effort override (`effort`) for suggestion-generation turns.
  - queue workers propagate queue abort signals and running turn context so cancel/timeout behavior can interrupt active agent turns and avoid wedged shutdown lanes.
  - queue replay preserves unknown-type or schema-invalid persisted jobs as explicit terminal failures (`recovery_unknown_job_type:*`, `recovery_invalid_payload:*`) for observability and client reconciliation.
  - core API runs a generic extension runtime:
    - dynamically loads extensions from deterministic source roots:
      - repo-local `agents/*`
      - `AGENT_EXTENSION_PACKAGE_ROOTS`
      - `AGENT_EXTENSION_CONFIGURED_ROOTS`
    - validates manifest/entrypoint/runtime compatibility before activation (including full semver range checks for core/profile ranges).
    - emits named events (`file_change.approval_requested`, `turn.completed`, `suggest_request.requested`) with fanout deterministic dispatch (`priority`, module name, registration index).
    - dispatch enforces first-wins action reconciliation per emitted event: after first `action_result(performed)`, later action requests are normalized as `not_eligible` without executing additional side effects.
    - normalizes handler outputs to typed envelopes (`enqueue_result`, `action_result`, `handler_result`, `handler_error`) with per-handler timeout isolation.
    - exposes queue/execution primitives without hard-coding workflow review logic in API core; repository supervisor workflows (including suggest-request) run through `agent_instruction`.
  - extension lifecycle controls:
    - `GET /api/agents/extensions` returns snapshot + module inventory (origin, compatibility, capability declaration, trust evaluation).
    - `POST /api/agents/extensions/reload` supports atomic snapshot-swap reload with prior-snapshot preservation on failure.
    - reload/list role control uses `AGENT_EXTENSION_RBAC_MODE=disabled|header|jwt` (`disabled` is loopback-only; header mode validates shared token `x-codex-rbac-token` and is loopback-guarded unless explicitly opted out).
    - trust/capability behavior uses `AGENT_EXTENSION_TRUST_MODE=disabled|warn|enforced`.
    - reload attempts are audit logged to `.data/agent-extension-audit.json` with success/failed/forbidden outcomes.
  - runtime profile adapter boundary:
    - turn start/read/interrupt and approval/steer actions execute through `RuntimeProfileAdapter` contracts.
    - codex profile adapter is the default implementation; fixture profile adapter is used for portability tests.
- each queued `agent_instruction` job executes exactly one instruction turn on an agent-owned system chat (owner + agent), one job at a time through the queue.
  - agent chats are created lazily and tracked in session metadata under `projectAgentSessionByKey`.
- core performs one mandatory system queue-runner orientation turn per agent session during startup preflight, before the first `agent_instruction` job turn executes.
  - agent execution policy is agent-owned:
    - if `agents/<agent>/agent.config.json` exists, orientation/job turns use its declared policy (including optional `model`, `turnPolicy`, `orientationTurnPolicy`, `instructionTurnPolicy`, and `threadStartPolicy` overrides; turn policies also support optional reasoning `effort`).
    - if no config file exists, policy falls back to API defaults (`DEFAULT_SANDBOX_MODE`, `DEFAULT_NETWORK_ACCESS`, `DEFAULT_APPROVAL_POLICY`).
    - repository supervisor defaults are defined in `agents/supervisor/agent.config.json` (`model: gpt-5.3-codex-spark`, `sandbox: workspace-write`, `networkAccess: enabled`, `approvalPolicy: never`, `effort: low`).
  - agent instruction execution auto-recovers one time from stale/missing mapped agent chats (`thread not found` / rollout-missing): mapping is cleared, session is reprovisioned, and the job retries once.
  - queue retries for agent-driven jobs (`agent_instruction`) use an immediate-first linear backoff (`0ms`, then `+60ms` per subsequent retry attempt) for fast stale-session recovery on first-turn workloads.
  - supervisor/agent worker turn tracking is event-driven for system-owned agent chats:
    - API observes runtime notifications (`turn/*`, `item/*`, agent-message deltas) for hidden agent sessions and settles worker waits from that stream first.
    - `thread/read(includeTurns)` remains a fallback path only (mainly for non-system sessions or missed event windows).
    - includeTurns fallback materialization is bounded by `ORCHESTRATOR_AGENT_INCLUDE_TURNS_GRACE_MS`; when the grace window is exceeded, the job fails retryable instead of burning the full turn-timeout window.
    - untrusted terminal fallback reads (completed while active-turn marker still points to same turn) are only accepted after stable no-progress duration (`ORCHESTRATOR_AGENT_UNTRUSTED_TERMINAL_GRACE_MS`), preventing premature next-turn starts on transient completed snapshots.
    - running turns that remain empty (no materialized turn items) beyond `ORCHESTRATOR_AGENT_EMPTY_TURN_GRACE_MS` fail retryable so phantom in-progress turns do not burn the full timeout window.
    - completed-turn assistant-text waits now include an explicit post-completion grace window before failing when no assistant text is yet readable, reducing false negatives when final assistant output lands slightly after `turn/completed`.
    - failed worker turns are treated as job failures (not success) in both assistant-text and settle-only wait paths.
- queue payloads can provide optional extension bootstrap instructions (`bootstrapInstruction`) that core runs once per `(agent session, bootstrap key)` during startup preflight, after system orientation and before job turns.
  - file-change approval requests enqueue agent workflows via event handlers; API core does not include built-in explainability/risk/review processors.
  - `turn.completed` event context snapshots are built from canonical `thread/read(includeTurns)` turn content merged with supplemental ledger entries (supplemental-only fallback if canonical read is unavailable), so end-of-turn supervisor review receives the same transcript model users see.
  - default supervisor auto-action policy in `agents/supervisor/events.ts` is:
    - auto-approve enabled at `high` threshold (effectively always eligible).
    - auto-steer enabled at `med` threshold (ignores low/none risk).
    - auto-reject disabled.
    - all three remain environment-overridable via `SUPERVISOR_AUTO_*` flags and thresholds.
  - turn-completed event emission for agent review is gated by observed per-turn file-change approval anchors (stable `anchorItemId` set), so approval-reconcile polling does not overcount and first-turn review gating remains deterministic.
  - when in-memory turn anchor tracking is absent (for example after API restart), turn-completed gating recovers file-change activity from persisted supplemental approval transcript rows (`approval.request` where `details.method=item/fileChange/requestApproval`) to avoid silently skipping final review.
  - turn-completed dispatch is in-flight deduped per `(threadId, turnId)` and retried up to three attempts (`0ms`, `+60ms`, `+120ms`) before terminal give-up; when handlers are present but no actionable enqueue/action result is returned, dispatch is treated as failed for retry instead of silently succeeding.
  - file-change turn tracking is cleared on explicit turn terminalization and on session deletion paths to avoid stale-memory drift.
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
  - project `workingDirectory` changes clear existing system-owned agent chats for that project so future jobs re-provision with the updated cwd.
  - assign/unassign session to project.
  - bulk project chat move (`unassigned`/`archive`) and bulk project chat delete.
  - system-owned agent chats start in the project working directory when configured (fallback: workspace root).
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
  - suggested-request state deltas (`suggested_request_updated`).
  - plan/diff/token-usage updates.
  - app/account/mcp update notifications.
- Error handling:
  - Codex RPC errors are mapped to structured HTTP responses (unsupported, invalid params, invalid state, auth required, timeout, fallback).
  - global Zod request-validation errors return HTTP 400 with validation issues.
- API lifecycle/status contracts:
  - `GET /api/sessions` merges persisted `thread/list` output with `thread/loaded/list` so newly created, non-materialized chats appear immediately.
  - `GET /api/sessions` hides system-owned worker sessions by default; `includeSystemOwned=true` opt-in returns those worker sessions for API/operator visibility.
  - Session summaries expose `materialized` (`true` when backed by persisted rollout state; `false` for loaded in-memory threads read via `includeTurns: false` fallback).
  - Session summaries expose `projectId` (`string | null`) so assigned chats render under project sections and unassigned chats render under `Your chats`.
  - `GET /api/projects/:projectId/agent-sessions` returns owner-scoped agent worker mappings (`agent`, `sessionId`, `systemOwned`) so worker threads are discoverable through API without listing them as normal chats.
  - `GET /api/sessions/:sessionId` supports system-owned worker sessions for transcript/debug visibility; mutating user-chat operations on worker sessions remain rejected with HTTP `403` + `code: "system_session"`.
  - Session summaries expose `sessionControls` (`model | approvalPolicy | networkAccess | filesystemSandbox`) and retain `approvalPolicy` for backward compatibility.
  - `POST /api/sessions/:sessionId/approval-policy` and `POST /api/sessions/:sessionId/messages` require the target session to resolve via runtime existence checks; unknown/invalid/deleted-after-restart ids return `404 not_found` and do not create session-control metadata entries.
  - `POST /api/sessions/:sessionId/messages` persists per-chat session controls only after turn acceptance (`202`), preventing orphan control writes when `turn/start` fails.
  - Startup prunes stale `sessionControlsById` / `sessionApprovalPolicyById` entries whose session ids are no longer known to active, archived, or loaded runtime threads.
  - Non-materialized sessions are movable/assignable but are not guaranteed to survive API/Codex restart before first-turn rollout materialization.
  - `POST /api/sessions/:sessionId/archive` returns HTTP `409` + `status: "not_materialized"` when no rollout exists yet.
  - `DELETE /api/sessions/:sessionId` returns `status: "ok"` on successful purge, `status: "not_found"` when the session cannot be resolved, and returns HTTP `410` deleted payloads for already-purged ids.
  - `DELETE /api/projects/:projectId` returns HTTP `409` + `status: "project_not_empty"` only for live assigned chats after stale assignment metadata is pruned.
  - `POST /api/projects/:projectId/chats/move-all` with `destination: "archive"` returns HTTP `409` + `status: "not_materialized_sessions"` and explicit `sessionIds` when any assigned chat lacks rollout state.
  - `POST /api/sessions/:sessionId/project` supports loaded non-materialized sessions, so chats can be moved between projects before first message.
  - Session transcript entries include optional `startedAt`/`completedAt` turn-timing values (epoch ms) when available from live turn lifecycle capture or persisted session metadata.
  - `GET /api/sessions/:sessionId` transcript merges a supplemental runtime event ledger built from websocket `item/*` notifications and approval/tool-input server requests, preserving command/file/tool/approval audit rows when `thread/read(includeTurns)` omits them in non-experimental runtimes.
  - Supplemental runtime transcript ledger is persisted to `.data/supplemental-transcript.json` and reloaded at startup so thought-block audit rows (approvals/command execution/file changes/tool-input events) survive API restarts.
  - Supplemental transcript merge is additive for existing turns (no anchor-based full-turn replacement), so base historical tool rows are retained when supplemental snapshots are partial.
  - Transcript assembly canonicalizes per-turn synthetic `item-N` rows emitted by raw-events fallbacks: when a canonical same-turn item exists, matching synthetic duplicates are removed (including duplicate user/assistant/reasoning rows) so reload/restart does not double-render thought content.
  - Supplemental transcript rows capture locally observed item timing (`startedAt`/`completedAt`) when Codex item payloads omit timestamps, and merge/upsert logic preserves earliest start plus latest completion per item id for stronger post-restart timing fidelity.
  - `POST /api/sessions/:sessionId/suggested-request` builds context from the same merged/canonicalized transcript pipeline as `GET /api/sessions/:sessionId`, keeping suggested-request context consistent with visible chat history after reload/restart.
  - suggest-request event context currently includes full user+assistant chat history (not a tail window) and is passed directly into `suggest_request.requested` payload (`turnTranscript`) for immediate worker synthesis without extra lookup dependency.
  - `GET /api/health` exposes orchestrator queue availability and state counters (`enabled`, queued/running/completed/failed/canceled/projects).
- Explainability supplemental transcript rows (`type: fileChange.explainability`) are upserted by stable message id and anchored after the corresponding file-change item when present in-turn.
- Supplemental supervisor placeholders (`fileChange.explainability`, `fileChange.supervisorInsight`) are replaced with explicit error/canceled fallback text on terminal failure/cancel when the content is still a placeholder, avoiding misleading perpetual queued/running copy.
- `agent_instruction` orchestrator jobs support response modes:
  - `assistant_text`: streams assistant output snapshots into supplemental transcript rows (`type: agent.jobOutput`, stable `messageId: agent-job-output::<jobId>`).
  - `action_intents`: parses worker JSON action intents and executes them in API core with trust/capability checks, idempotency replay/conflict semantics, and project/session/turn scope locks.
  - `none`: no structured response contract; worker is expected to perform side effects live (for example via CLI calls) while the turn runs.
  - fallback idempotency keys for intents that omit `idempotencyKey` are derived from a SHA-256 digest of normalized action signatures (stable across JSON object key ordering and independent of intent array index).
- repository supervisor extension currently runs `agent_instruction` in `expectResponse: "none"` mode and performs transcript/approval/steer actions through CLI commands (not JSON action-intent envelopes).
- repository supervisor extension runs suggest-request as `agent_instruction` (`jobKind: suggest_request`) with CLI side-effect flows (`sessions suggest-request upsert`) and does not rely on assistant-text output as the delivery contract.
- suggest-request `agent_instruction` jobs support completion-signal metadata (`completionSignal`) plus optional `model`/`effort` and `fallbackSuggestionDraft` payload fields.
- suggest-request `agent_instruction` execution is deadline-bounded: if no completion signal is observed by the bounded window (`ORCHESTRATOR_SUGGEST_REQUEST_WAIT_MS`), core writes a deterministic fallback suggestion via runtime state upsert, interrupts the worker turn best-effort, and completes the queue job without waiting for assistant-text output.
- direct extension `action_request` execution in event fanout uses the same scoped-action executor; when event context is present, scope is derived from payload context and enforced for all action types (including `queue.enqueue` project/session constraints).
- runtime turn wait loops for system-owned agent sessions reconcile with periodic `thread/read` polling when in-memory runtime updates go stale or settle without output, reducing false timeout/stuck states when websocket/runtime signals are delayed.
- Queue terminal handlers reconcile supplemental rows from payload-declared `supplementalTargets` (message id/type/placeholder/fallback contract) to explicit terminal status when needed, so UI cards do not remain indefinitely pending after job completion/failure/cancel.
- Supplemental transcript upsert preserves terminal status against stale streaming regressions for the same message id, preventing late retry/duplicate streaming writes from downgrading already-finalized transcript rows.
- System-owned agent sessions remain harness metadata, are hidden from default session list responses, and still auto-decline/cancel server requests (approvals/tool-input) on request-path cleanup.
- websocket traffic for system-owned sessions is thread-filtered: system-session events are delivered only to sockets explicitly subscribed to that worker `threadId`, preventing leakage into global/user chat streams while preserving full session observability.
  - extension portability/conformance gate:
    - `node scripts/run-agent-conformance.mjs` generates `.data/agent-conformance-report.json`.
    - portable extension fixture proves parity across `codex-manager` and `fixture-profile`.

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
  - project creation writes project metadata; system-owned agent chats are provisioned lazily and do not render as user chat rows.
  - project creation/rename/delete, bulk move/delete chats, session assignment and move flows.
  - project context menu action to set/clear project working directory; new chats from that project start in that directory.
  - selected chat is persisted by `sessionId` in tab-scoped browser storage across page reloads/HMR so duplicate chat titles do not cause selection drift.
  - non-materialized session movement supported.
- Chat runtime features:
  - websocket reconnect/backoff.
  - disconnected websocket state blocks the chat pane with a reconnect overlay/action until connectivity resumes.
  - send-message health check: when no turn/activity response arrives after send, the UI first attempts transcript reconciliation and reconnect-aware retries; only after an extended recovery window does it mark the send as failed and prompt reconnect.
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
  - while a turn is active or has unresolved approval/tool-input decisions, assistant progress lines remain in the thought area and are not promoted into the final response area.
  - final assistant response area renders Markdown (GFM tables/lists/strikethrough/task lists) via safe Markdown rendering (raw HTML is not executed), with inline code and block code styled for chat readability.
  - thought preview/header text and thought-line reasoning/agent message content also render through the same safe Markdown pipeline, so multiline reasoning updates and markdown-formatted progress notes keep structure (paragraphs/lists/code) instead of flattening into a single plain-text line.
  - inside expanded thought details, reasoning/agent markdown lines that start with a bold title prefix (`**Title** ...`) become collapsible section headers (caret indicator) that group all following thought activity until the next section header (or end of the thought block); when the header line has trailing text after the bold prefix, that trailing text is retained as the first line inside the section body, while header-only lines (`**Title**`) render the title once without duplicating it as the first body row; section-toggle hit targets are content-width (not full-row), while clicks in surrounding thought background still collapse the full thought panel.
  - thought status is keyed to active turn lifecycle state (not inferred from partial thought rows): while the selected turn is active, the collapsed header shows a live progress preview (`Working...` until reasoning/agent progress text is available, then latest progress text); once the turn reaches a terminal lifecycle notification (`turn/completed` or `turn/failed`) it switches to `Worked for <duration>` using turn/message timing with `<1s` fallback for legacy timing gaps.
  - empty reasoning placeholders are auto-suppressed once completion can be inferred (turn ended, later meaningful events exist, or final assistant output is present/settled), preventing stale `thinking...` rows in completed turns.
  - thought disclosure keeps per-turn open/closed state stable across stream/approval updates; when a new pending approval/tool-input arrives while the panel is closed it auto-opens in pending-only preview, and users can explicitly expand to full prior activity. Pending resolution no longer force-flips panel mode, preventing abrupt pending-only/full layout churn mid-turn. Expanded mode hides the collapsed header label for normal full view, while pending-only view shows the latest live reasoning/agent preview text above `Show prior activity` for context.
  - expanded thought panels collapse only from background/plain-thought clicks; clicks inside event/approval bubbles and their controls do not auto-collapse.
  - expanded thought details render reasoning summary/content line rows and inline tool/approval/tool-input context with actions.
  - command and file-change approvals render as compact action-first rows (`Approval required to run …`, `Approval required to create/modify/delete/move file …`) with inline decision actions; decision UX is websocket-authoritative (buttons enter submitting state locally, pending/resolved transitions are applied from runtime events, and a bounded fallback reconcile reloads pending approvals after submit if a resolution event is missed), approval rows are rendered only while pending (resolved/expired approval update rows are intentionally suppressed), pending file-change approvals include an inline dark-theme diff/content preview above decision buttons and suppress duplicate pending file-change item rows until approved, command-execution rows render inline terminal-style dark blocks (no nested wrapper bubble) with prompt lines whose `~` prefix is mapped to inferred user home from runtime cwd paths, and file-change rows render structured dark-theme diffs with add/remove/hunk/context coloring where displayed file paths and absolute home-path text in diff lines are normalized to `~`. Approval/tool-input hydration merges late REST snapshots with newer websocket-delivered pending items for the active chat so fresh approval/input requests are not dropped by stale in-flight loads.
  - synthetic explainability transcript entries (`type: fileChange.explainability`) are rendered in thought details as markdown explainability blocks once queued background analysis rows complete, and when anchored to a file-change item they render inside a shared diff bubble.
  - supervisor diff-insight transcript entries (`type: fileChange.supervisorInsight`) are linked into the same file-change/approval diff bubble, so users can see queued/running/completed supervisor insight directly in the approval context before or after decision.
  - supervisor queue-output transcript entries (`type: agent.jobOutput`) render as `Supervisor Job Output`; when anchored to the same file-change approval they render in the same grouped diff/insight bubble, otherwise they render as standalone thought rows.
  - turn-end supervisor output renders as a dedicated thought row:
    - `turn.supervisorReview` (`Turn Supervisor Review`)
  - composer uses a single message input; `Suggest Request` populates that same draft box and `Ctrl+Enter` sends.
- chat view includes a pinned `Session Controls` panel that defaults to a collapsed summary chip and expands on demand, with explicit Apply/Revert semantics for `Model`, `Approval Policy` (`untrusted` / `on-failure` / `on-request` / `never`), `Network Access` (`restricted` / `enabled`), and `Filesystem Sandbox` (`read-only` / `workspace-write` / `danger-full-access`).
- approval policy values are canonical protocol literals end-to-end (`untrusted`, `on-failure`, `on-request`, `never`).
  - panel also exposes `Thinking Level` (`none` / `minimal` / `low` / `medium` / `high` / `xhigh`) as an immediate per-chat selector (local preference used on send); suggest-request uses a faster effort profile derived from model-supported options to keep request suggestions responsive.
  - after a successful `Apply`, and when switching chats, the panel auto-collapses into the summary chip so controls stay out of the way until reopened.
  - when no session-control tuple edits are pending, the primary action becomes `Close` so users can collapse the expanded panel without sending a no-op apply request.
  - scope toggle supports `This chat` vs `New chats default`; when defaults are harness-locked, `New chats default` remains viewable in read-only mode (lock icons + `Set by harness at session start`) while per-chat controls remain editable.
  - panel summary line is rendered in monospace as `<model> | <thinking> | <approval> | <network> | <sandbox>`; when the session model control is inherited, the model segment renders as `default (<resolved default model id>)` (or `default (default)` only when no default model id is available), announced for assistive tech as `Current session controls: ...`, and apply success surfaces a toast with the full applied tuple.
  - each summary segment is hover-descriptive (native tooltip) so users can inspect value semantics inline (`model`, `thinking`, `approval`, `network`, `sandbox`) without leaving the chat view; selector controls and selector options also expose matching tooltips for the currently selected value and available alternatives.
  - when approval policy is `never`, panel displays `Escalation requests disabled for this chat.` and runtime state avoids approval-focused copy.
  - model list hydration is normalized to one entry per model id, and same-session synchronization preserves a valid local model/effort selection instead of reapplying fallback/session defaults during unrelated state updates.
  - suggest-request interactions are queue-job guarded: duplicate clicks while a suggest job is pending are suppressed, and composer updates apply only when websocket completion events match the active request guard (`sessionId` + draft snapshot + request id + job id).
  - suggest-request pending state includes job-status reconcile polling against `GET /api/orchestrator/jobs/:jobId`, so missed websocket terminal events do not leave the composer in a permanently pending state.
  - transcript websocket updates are delta-applied in the client: `transcript_updated` carries the upserted transcript entry payload, the active chat applies it directly to message/timing state for immediate explainability/insight/job-output rendering, and REST transcript reload is used as a debounced reconcile fallback.
  - pending approval cards and approval decisions.
  - tool-input request cards with answer submission.
  - active-turn controls (interrupt + steer).
  - thread actions menu (fork/compact/rollback/review/background-terminals clean).
  - insight drawer (plan/diff/usage/tools), manually toggled by the user; incoming plan/diff events update stored insight data without auto-opening the drawer.
  - settings modal for capability/account/mcp/config/skills/apps visibility and actions.
- Deleted active-session UX:
  - right pane blocks interaction and requires selecting/creating another chat.

### CLI (`apps/cli`)

- Operator CLI package is implemented as `@repo/cli` with binaries:
  - `codex-manager`
  - `cmgr`
- Runtime/profile model:
  - profile store at `~/.config/codex-manager/cli/config.json` (or `$XDG_CONFIG_HOME/codex-manager/cli/config.json`).
  - profile defaults for `baseUrl`, `apiPrefix`, `timeoutMs`, base headers, and auth fields.
  - runtime resolution order is flag > environment > profile.
- Auth and RBAC headers are first-class globals:
  - bearer token (`Authorization`)
  - extension RBAC headers (`x-codex-rbac-token`, `x-codex-role`, `x-codex-actor`)
- Command coverage:
  - domain commands for system/models/apps/skills/mcp/account/config/runtime/feedback/extensions/orchestrator/projects/sessions.
  - dedicated approval and tool-input decision commands.
  - websocket stream command (`stream events`) for live event inspection.
  - raw escape hatch (`api request`) for direct endpoint invocation.
- Route coverage parity:
  - explicit CLI route mapping in `apps/cli/src/lib/route-coverage.ts`.
  - parity test compares CLI bindings to API route registrations in `apps/api/src/index.ts`.
  - parity mismatch is treated as a release blocker for CLI endpoint coverage.

### API client and contracts

- OpenAPI/client generation covers core session/settings/account/tool-input APIs, but currently does not yet model all newer orchestrator/session-control surfaces in generated helper signatures (for example `/sessions/:id/session-controls`, queue-backed suggested-request jobs endpoint, and orchestrator job inspection/cancel endpoints).
- Generated API client includes helpers for:
  - project bulk operations,
  - project creation (returns `orchestrationSession: null` under lazy agent-session provisioning),
  - thread-control endpoints,
  - suggested-request endpoint (`suggestSessionRequest`) with optional `effort`,
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
- `pnpm smoke:runtime` (with API running)
- `node scripts/run-agent-conformance.mjs`

### Current validation limitations

- `pnpm lint` is placeholder-only in workspace packages; enforceable lint rules are not configured yet.
- Browser-level Playwright requires Linux shared libraries. Root `pnpm test:e2e*` commands run through `scripts/run-playwright.mjs`, which bootstraps missing libs into `.data/playwright-libs` when `apt-get download` is available.
- `pnpm gen` can fail under restricted file-permission environments when writing `apps/api/openapi/openapi.json`; rerun contract generation in a writable environment before release.
- `pnpm test` can fail under restricted file-permission environments when creating runtime directories under `.data/`.
- `pnpm build` can fail under restricted file-permission environments when Vite writes temp files under `apps/web/node_modules/.vite-temp`.

## Known follow-up hardening work

- Expand API/web test coverage breadth beyond current contract/integration + smoke suites.
- Add CI-enforced lint rules instead of placeholder scripts.
- Add additional Playwright scenarios for deeper runtime behaviors (approvals lifecycle, tool-input decisions, insight drawer updates, and project bulk workflows).
