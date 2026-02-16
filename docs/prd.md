# Product Requirements Document

## Product name

Codex Chat UI (local-first)

## One-line summary

A **local-first, chat-like UI** that lets a user **create and drive Codex sessions** with streaming responses, persistent session history, and safe handling of approvals and tool activity—powered by the **Codex App Server** as the authoritative runtime.

---

## Problem statement

Codex is highly capable, but its native interfaces are not always the best fit for:

- a lightweight, custom “ChatGPT-style” workflow
- persistent session navigation
- consistent UX for streaming
- structured display of tool actions and approvals
- local-first development flows

We want a purpose-built UI that makes Codex feel like a high-quality chat client while preserving fidelity to the Codex App Server protocol and features.

---

## Target user

Primary user:

- A single developer (you) running locally.

Secondary users:

- Other developers on the same codebase who want a consistent local Codex UI.

Non-goals include multi-tenant SaaS or enterprise user management in v1.

---

## Goals

### Core goals

- Create a new Codex session from the UI.
- List and resume existing sessions.
- Send messages and receive **streaming responses**.
- Maintain a clean, chat-style conversation view.
- Support interruptions/cancelation of an in-flight response.
- Support approval prompts (when Codex requires them).
- Support tool call visibility (collapsed by default) without overwhelming the chat.
- Remain local-first and reliable across restarts.

### Quality goals

- Fast and responsive streaming UX (low latency, minimal jitter).
- No message corruption (deltas merge correctly, completion finalizes correctly).
- Clear states: idle, streaming, waiting for approval, error.
- Clear error handling with user-recoverable actions.
- Deterministic session persistence.

---

## Non-goals

- Multi-user authentication and permissions (v1).
- Hosting Codex remotely or supporting external clients (v1).
- Re-implementing Codex capabilities in the backend (the backend is a protocol adapter).
- “IDE-grade” file explorers, diff editors, or repo management UI (v1).
- Complex workflow orchestration / multi-agent coordination (v1).

---

## Product experience overview

### Primary user journey

- User opens the web UI.
- User clicks **New Chat**.
- User types a prompt and presses **Send**.
- Assistant response streams in real time.
- If Codex requests approval, the UI shows an inline approval card.
- User can approve/deny and continue.
- User can switch to another session and return later.
- Sessions persist across app restarts.

### UI structure

- Left sidebar: session list + new chat button
- Main area: chat transcript (messages + minimal tool events)
- Bottom: composer (text input, send button, cancel button during streaming)
- Optional: “Details” panel or expandable cards for tool/approval events

---

## System architecture summary

- Web UI (React + Vite) communicates with a backend service (Fastify).
- Backend supervises and talks to `codex app-server` via STDIO JSON-RPC.
- Backend exposes:
  - REST endpoints for session management
  - WebSocket streaming for turn events

Codex App Server is the source of truth for:

- threads (sessions)
- turns
- streamed items and deltas
- approvals and tool calls
- model selection and configuration

---

## Functional requirements

## Session management

### FR-1: Create a new session

- UI provides “New Chat”.
- A new Codex thread is created.
- UI navigates to the new session immediately.

Acceptance criteria:

- Clicking “New Chat” results in a usable session with an empty transcript.
- The session appears in the session list within 1 second under normal conditions.

### FR-2: List sessions

- UI loads existing sessions at startup.
- UI supports selecting a session.

Acceptance criteria:

- Sessions show title (or fallback name), last activity time.
- Pagination supported if many sessions exist.

### FR-3: Resume session

- Selecting a session loads transcript and allows continuing conversation.

Acceptance criteria:

- User can send a new message in an existing session.
- Transcript includes prior messages (not only the new ones).

### FR-4: Rename session (optional v1)

- User can rename session.

Acceptance criteria:

- Renamed title appears in list and in session header.

### FR-5: Archive session (optional v1)

- User can archive sessions to reduce clutter.

Acceptance criteria:

- Archived sessions are hidden by default.

---

## Chat messaging

### FR-6: Send user message

- User composes a message and sends it.
- Message appears in transcript immediately.

Acceptance criteria:

- The UI renders the user bubble locally without waiting for server round-trip.

### FR-7: Stream assistant response

- Assistant output streams as deltas and resolves into a final assistant message.

Acceptance criteria:

- The assistant bubble begins within 1 second for typical prompts.
- Deltas are appended smoothly.
- Completion finalizes message with no duplicated or missing text.

### FR-8: Cancel in-flight response

- User can cancel generation while streaming.

Acceptance criteria:

- Cancel stops further deltas within 1 second.
- The final state reflects canceled/interrupted.

---

## Approvals

### FR-9: Display approval request

If Codex requires approval:

- Display an inline approval card in the chat stream.
- Show the summary and details needed to decide.

Acceptance criteria:

- User sees:
  - What action is proposed
  - Why approval is needed (when provided)
  - Action parameters (collapsible)
  - Approve/Deny buttons

### FR-10: Submit approval decision

- Approve or deny sends a response back to Codex and unblocks execution.

Acceptance criteria:

- Only one decision is accepted.
- UI shows “decision sent” state and then result in the transcript.

---

## Tool activity visibility

### FR-11: Show minimal tool activity

Tool usage must not overwhelm chat.

Requirements:

- Tool calls appear as collapsed cards:
  - tool name
  - status (running/success/fail)
  - expandable details (arguments/result)

Acceptance criteria:

- Default view remains chat-first.
- Power users can expand for debugging.

---

## Reliability and persistence

### FR-12: Persist session list and history

- Sessions and history remain after restarting UI/backend.

Acceptance criteria:

- Sessions remain accessible after restart.
- Transcript reconstructs correctly from persisted items.

### FR-13: Reconnect handling

If the WebSocket disconnects:

- UI shows a clear reconnect indicator.
- UI attempts reconnect automatically.

Acceptance criteria:

- Reconnect attempts are exponential backoff.
- UI recovers without forcing refresh under normal conditions.

---

## Configuration and settings (v1 minimal)

### FR-14: Model selection (optional v1)

- UI optionally allows selecting a model per session or per turn.

Acceptance criteria:

- Model list is loaded from Codex capabilities.
- Selection persists for that session.

### FR-15: MCP configuration visibility (optional v1)

- UI can show MCP server status.

Acceptance criteria:

- User can see which MCP servers are enabled and healthy.
- No secrets displayed.

---

## Technical requirements

## TR-1: Codex App Server protocol fidelity

The backend must:

- implement the handshake correctly (`initialize` → `initialized`)
- pass through and preserve ordering of streamed events
- treat `item/completed` as authoritative
- properly support server-initiated approval requests

## TR-2: Streaming transport

- Browser receives streaming events via WebSocket.
- Backend must support multiple subscribers per session (optional) without duplicating Codex requests.

## TR-3: Deterministic data model

The persisted representation must be sufficient to:

- list sessions
- load transcript
- resume sending messages

Codex’s own rollout persistence may be used; the backend can store additional metadata.

## TR-4: Local-only networking (v1 default)

- Backend binds to localhost by default.
- UI expects `VITE_API_BASE=/api`.

## TR-5: No secrets in the browser

- All secrets remain backend-side or in OS credential stores.
- MCP credentials are not transmitted to the browser.

---

## UX requirements

## UX-1: Chat-first interface

- The main transcript reads like a chat.
- Tool events and approvals appear as chat entries, but are visually distinct.

## UX-2: Streaming polish

- Smooth streaming cursor
- Auto-scroll behavior:
  - auto-scroll while user is at bottom
  - do not force scroll if user scrolls up
  - show “Jump to bottom” indicator

## UX-3: State clarity

Session/turn state should be obvious:

- Idle
- Streaming
- Waiting for approval
- Error
- Canceled

## UX-4: Error recovery

Errors should provide:

- short explanation
- “Retry” where applicable
- actionable troubleshooting hint (e.g., Codex not installed)

---

## Data model (product-level)

### Session

- `sessionId` (maps to Codex `threadId`)
- `title`
- `createdAt`
- `updatedAt`
- `archivedAt` (optional)
- `model` (optional)

### Message (renderable transcript unit)

- `messageId`
- `sessionId`
- `role` (`user | assistant | system`)
- `content` (string)
- `createdAt`
- `status` (`streaming | complete | canceled | error`)

### Event (optional internal)

- Used for tool cards and approvals
- Not necessarily shown as “messages” in the UI

---

## Milestones

## Milestone 1: Basic chat sessions

- New session
- Session list
- Send message
- Stream assistant response
- Persist sessions
- Cancel streaming

## Milestone 2: Approvals

- Display approval prompt
- Approve/deny handling
- Persist approval events in transcript

## Milestone 3: Tool visibility

- Collapsed tool cards
- Expand for details
- Basic error display for tools

## Milestone 4: Configuration UX (optional)

- Model selection
- MCP status panel

---

## Success metrics

- Time to first streamed token ≤ 1s for typical prompts (local environment dependent)
- 99% of sessions resume correctly after restart in normal usage
- No transcript corruption (no duplicated/missing delta text) in manual testing
- Approval flows succeed without requiring refresh

---

## Risks and mitigations

### Risk: Protocol drift between Codex versions

Mitigation:

- Pin Codex version for development.
- Regenerate protocol schemas when upgrading.
- Add automated tests for method/event shape compatibility.

### Risk: Streaming bugs (delta mismatch)

Mitigation:

- Always treat `item/completed` as final source of truth.
- Use deterministic merge logic for deltas per `itemId`.
- Maintain per-item streaming buffers.

### Risk: App server crashes or restarts

Mitigation:

- Backend supervision and restart.
- UI reconnect strategy with clear status messaging.

### Risk: Approval flows are confusing

Mitigation:

- Present a clear action summary.
- Collapsible raw details.
- Strong affordances for approve vs deny.

---

## Open questions (explicitly deferred)

- Whether we want multi-tab session rendering (one tab per session) vs single view.
- Whether sessions should be stored purely via Codex rollouts or mirrored in backend DB.
- Whether MCP configuration should be editable in the UI in v1 or read-only.

---

## Requirements traceability

Every feature described here must map to:

- backend API endpoints and WebSocket messages
- Codex App Server method calls
- UI components and state transitions
- tests that validate streaming + approvals

Any change to behavior requires updating this document in the same PR.

