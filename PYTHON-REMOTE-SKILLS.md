# Python Remote Skills Feasibility Review

## Goal

Provide a drop-in framework where Python code can register session-scoped handlers and answer Codex dynamic tool calls through codex-manager, with clean lifecycle boundaries and no direct `codex app-server` coupling.

## Feasibility summary

Feasible now with the current architecture.

Why:

- codex-manager already captures app-server server requests and owns the response channel (`codexRuntime.respond`).
- codex-manager already has session-scoped websocket fan-out and pending-request stores.
- API/CLI/Python SDK already expose route-complete control surfaces and parity gates.

Main required gap was a first-class dynamic tool-call bridge in codex-manager itself.

## Implemented in this change

### 1) True server-side dynamic tool-call bridge

- Added pending dynamic tool-call tracking for `item/tool/call` requests in API runtime.
- Added routes:
  - `GET /api/sessions/:sessionId/tool-calls`
  - `POST /api/tool-calls/:requestId/response`
- Added websocket lifecycle events:
  - `tool_call_requested`
  - `tool_call_resolved`
- Added transcript rows:
  - `tool_call.request`
  - `tool_call.resolved`
- Added expiration handling on turn/session cleanup.
- System-owned sessions now auto-fail dynamic tool-call requests safely.

### 2) CLI parity

- Added `sessions tool-calls list`.
- Added `tool-calls respond`.
- Updated route parity map so CLI coverage remains endpoint-complete.

### 3) Python SDK parity

- Added API wrappers:
  - `sessions.tool_calls(...)`
  - `tool_calls.respond(...)`
- Added session helper:
  - `client.session(session_id).tool_calls.list()`
- Added remote-skill bridge layer:
  - `client.remote_skills.session(session_id)`
  - context-managed registration (`using(...)`)
  - dispatch + response helper (`respond_to_signal(...)`) that posts to codex-manager route, not directly to app-server.

### 4) Contract and generation surfaces

- OpenAPI updated with new paths/schemas/operation IDs.
- Generated TypeScript API client updated.
- Generated Python OpenAPI models updated.
- Typed operation-id contract set updated for new raw operations.

## Lifecycle model

1. Tool request arrives from app-server as `item/tool/call`.
2. codex-manager stores pending request and publishes `tool_call_requested`.
3. Python runtime handles signal, executes local callable, submits route response.
4. codex-manager responds upstream to app-server and emits `tool_call_resolved`.
5. Pending record is removed; transcript is reconciled.

## Practical integration pattern

- Build one `remote_skills.session(session_id)` registry per session pipeline.
- Register only capabilities needed for the active pipeline segment.
- Use `with` / `async with` registration to guarantee cleanup.
- Keep per-handler side effects isolated and return explicit structured outputs.

## Current constraints

- Dynamic tool availability still depends on runtime capability (`item/tool/call` support).
- Request routing is session-scoped; handler orchestration remains application-owned.
- If a request is already resolved/expired, response route returns `404` and should be treated as reconciled terminal state.

## Outcome

The bridge is now service-native: Python acts as a handler implementation layer while codex-manager remains the authoritative transport/lifecycle boundary.
