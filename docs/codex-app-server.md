# Codex App Server Protocol Guide

## Purpose

This is the entrypoint for the Codex App Server protocol documentation used by this repository.

The previous single-file reference was split into focused documents so protocol knowledge stays maintainable and does not mix unrelated concerns.

## Last verified

- Codex Manager API surface: February 23, 2026
- Codex Manager web integration: February 23, 2026
- Codex protocol source in repo: `packages/codex-protocol/generated/stable/*`

## Protocol knowledge tree

- `docs/protocol/overview.md`
  - Transport, framing, JSON-RPC model, initialization handshake, capabilities model, and core primitives (thread/turn/item).
- `docs/protocol/methods-core.md`
  - Core method surface for lifecycle operations (initialize, thread lifecycle, turn lifecycle, review entry).
- `docs/protocol/methods-integrations.md`
  - Integrations/configuration methods (commands, models, collaboration modes, skills, apps, MCP management, config, feedback, account).
- `docs/protocol/events.md`
  - Notification/event stream surface and item/delta lifecycle semantics.
- `docs/protocol/approvals-and-tool-input.md`
  - Approval request/decision flow and server-initiated tool user-input requests.
- `docs/protocol/config-security-and-client-rules.md`
  - MCP config semantics, sandbox/approval policy semantics, UI checklist, and non-negotiable client rules.
- `docs/protocol/harness-runtime-events.md`
  - Harness-level runtime contracts: lifecycle surfaces, queue websocket events, transcript deltas, and transcript upsert semantics.
- `docs/protocol/agent-runtime-sdk.md`
  - Canonical extension SDK surface (events, tools, emit envelopes, helper contracts).
- `docs/protocol/agent-dispatch-and-reconciliation.md`
  - Deterministic fanout dispatch, winner/reconciled action semantics, and queue winner selection rules.
- `docs/protocol/agent-extension-packaging.md`
  - Extension package layout, manifest compatibility fields, source-origin model, and conformance expectations.

## How this maps to this repo

- API bridge implementation: `apps/api/src/index.ts`
  - Supervises `codex app-server`.
  - Maps protocol methods/events into REST + WebSocket for the web client.
  - Extends protocol with harness-only hard delete (`DELETE /api/sessions/:sessionId`) because app-server has no native `thread/delete`.
- Web integration: `apps/web/src/App.tsx`
  - Renders protocol-driven transcript/activity stream, approval cards, tool-input prompts, capabilities/settings state, and thread actions.

## Implementation notes (current)

- Method-availability/capability probing is exposed at `GET /api/capabilities` and used for UI state.
- Server-initiated tool-input requests (`tool/requestUserInput`) are persisted in memory and surfaced via:
  - WebSocket events: `tool_user_input_requested`, `tool_user_input_resolved`
  - REST endpoints: `GET /api/sessions/:sessionId/tool-input`, `POST /api/tool-input/:requestId/decision`
- Turn insight events are surfaced via:
  - `turn_plan_updated`
  - `turn_diff_updated`
  - `thread_token_usage_updated`
- Additional account/integration update events surfaced to clients:
  - `app_list_updated`
  - `mcp_oauth_completed`
  - `account_updated`
  - `account_login_completed`
  - `account_rate_limits_updated`
- Harness-managed system-owned agent sessions are treated as internal runtime threads:
  - session ids are tracked in metadata by owner+agent mapping (`<ownerId>::<agent>`, where owner can be project id or `session:<sessionId>`),
  - system-owned worker notifications/server-requests are not forwarded as user chat activity,
  - system-owned sessions are filtered from session-list responses and denied for user chat operations.
- Agent extension modules loaded from repo-local + configured/package roots translate runtime events into queue jobs (repository workflows currently enqueue `agent_instruction`, including `jobKind: suggest_request`) while protocol transport remains in API core.

## Updating protocol docs

When protocol behavior changes in code:

1. Update the focused document under `docs/protocol/` that owns that concern.
2. Update this index if files were added/renamed or responsibilities moved.
3. Keep implementation mapping notes accurate so readers can trace protocol semantics into `apps/api` and `apps/web`.
