# Architecture

> This document describes the target architecture. For current code-level scope, see `docs/implementation-status.md`.

## Overview

This system is a **local-first Codex session UI** built around the official **Codex App Server** (`codex app-server`) as the authoritative runtime.

The architecture is intentionally simple:

- The **browser UI** provides a chat-like interface.
- The **backend service** acts as a thin, stateful bridge.
- The **Codex App Server** is the execution engine and source of truth.
- Optional **MCP servers** extend Codex with additional tools.

The backend does not reimplement Codex behavior.  
It supervises the Codex process and translates its protocol into a browser-friendly streaming interface.

---

# Architectural Goals

1. Provide a clean, chat-style interface for Codex sessions.
2. Preserve full fidelity of the Codex App Server protocol.
3. Maintain persistent sessions across restarts.
4. Support streaming responses.
5. Support approvals and tool calls.
6. Support MCP tool configuration.
7. Remain local-first and single-user.

---

# High-Level Topology

```
Browser (React + Vite)
        |
        |  HTTP + WebSocket
        v
Backend API (Node + Fastify)
        |
        |  STDIO (JSONL)
        v
Codex App Server (codex app-server)
        |
        |  MCP Protocol
        v
MCP Servers (optional)
```

---

# Component Responsibilities

## 1. Browser UI

The UI is responsible for:

- Session selection and creation
- Project grouping and session-to-project organization
- Chat message input
- Rendering streaming assistant output
- Displaying approval prompts
- Rendering tool activity (collapsed by default)
- Managing WebSocket connection
- Rendering session history

The UI **never communicates directly with Codex**.  
All communication flows through the backend.

---

## 2. Backend API Service

The backend is a stateful protocol adapter.

### Responsibilities

- Start and supervise the `codex app-server` process
- Maintain a persistent connection to Codex via STDIO
- Perform JSON-RPC handshake
- Map Codex JSON-RPC methods to HTTP + WebSocket endpoints
- Maintain active session registry
- Forward streaming notifications to connected clients
- Forward approval responses back to Codex
- Handle reconnection and restart recovery
- Expose MCP configuration endpoints
- Provide a stable REST surface to the UI
- Implement product-level extensions that are outside native app-server methods (for example, hard-delete semantics with local artifact purge)
- Persist and serve harness-owned session metadata (titles, project definitions, session-project mapping)
- Load agent extension event modules from `agents/*/events.(ts|js|mjs)` and emit named runtime events into those handlers
- Expose queue enqueue primitives to extension handlers so feature workflows are implemented in agent extension code instead of hard-coded API processors
- Provision and manage system-owned agent sessions per project for queued worker turns

The backend does **not** interpret agent reasoning or rewrite messages.  
It is a transport bridge.

---

## 3. Codex App Server

The Codex App Server is the authoritative runtime.

It manages:

- Threads
- Turns
- Items
- Plans
- Diffs
- Tool calls
- Approvals
- MCP integration
- Authentication
- Configuration
- Skills
- Apps

It communicates exclusively via JSON-RPC over STDIO.

The backend must treat it as the source of truth.

---

## 4. MCP Servers (Optional)

MCP servers are external tool providers.

Codex acts as an MCP client and may:

- Call MCP tools
- Request OAuth login
- Stream tool results

The backend may expose:

- MCP server status
- OAuth initiation
- Configuration reload

But tool execution logic remains inside Codex.

---

# Transport Layers

## Browser ↔ Backend

- REST for session management
- WebSocket for streaming turns

All streaming from Codex is forwarded over WebSocket.

---

## Backend ↔ Codex

- STDIO
- Newline-delimited JSON
- One JSON object per line

Backend must:

- Serialize one request per line
- Read one response per line
- Support concurrent in-flight requests
- Maintain request id map

---

# Agent Extension Runtime

The API hosts a generic event runtime for `agents/*` modules:

- Each agent directory can provide `events.ts|events.js|events.mjs`.
- Event modules register handlers by event name.
- Handlers receive two tools: queue enqueue (`enqueueJob`) and logger.
- Handlers transform runtime events into queue jobs (`agent_instruction`, `suggest_request`).

This keeps API core behavior generic. Workflow-specific logic (prompt construction, routing strategy, transcript side effects, and optional auto actions) lives in agent extension code.

Agent worker sessions are system-owned owner-scoped infrastructure:

- They are mapped in metadata by `ownerId::agent`.
- `ownerId` is either a real project id or `session:<sessionId>` for unassigned-chat workflows.
- They are hidden from user chat lists.
- User chat operations against them are rejected (`403 system_session`).
- Optional one-time orientation is executed from `agents/<agent>/orientation.md`.
- Turn runtime policy is read from `agents/<agent>/agent.config.json` when present.

---

# Session Lifecycle

## Creating a Session

1. UI calls `POST /api/sessions`
2. Backend sends `thread/start`
3. Codex returns thread object
4. Backend stores thread id
5. UI receives session metadata
6. Until first user turn creates a persisted rollout, visibility relies on loaded in-memory thread state and is not guaranteed across API/Codex restart

---

## Sending a Message

1. UI sends message via `POST /api/sessions/:sessionId/messages`
2. Backend calls `turn/start`
3. Codex emits:
   - `turn/started`
   - `item/started`
   - `item/*/delta`
   - `item/completed`
   - `turn/completed`
4. Backend forwards streamed events over WebSocket
5. UI renders progressively

---

## Suggested Request Generation (Queue-Backed Agent Strategy)

`codex app-server` does not expose a dedicated suggest-request primitive, so the backend uses event-driven queue orchestration:

1. `POST /api/sessions/:sessionId/suggested-request/jobs` emits `suggest_request.requested` and returns `202` with a queued job id.
2. `POST /api/sessions/:sessionId/suggested-request` emits the same event, waits up to a bounded window, and returns either a completed suggestion (`200`) or queued status (`202`).
3. Suggest jobs are single-flight per source chat; repeated clicks while one is queued/running return the existing job identity (`dedupe: "already_queued"`).
4. Agent event modules convert that event into a `suggest_request` queue job with one text instruction turn on a hidden, system-owned agent chat.
5. For unassigned chats, the queue owner id is `session:<sessionId>`, so suggestion jobs do not require a project assignment.
6. If the queue is disabled/unavailable, queue-backed routes return structured `503` `job_conflict` errors.
7. If a suggestion cannot be produced, the endpoint returns a deterministic fallback suggestion.

Agent runtime permissions are agent-owned: if `agents/<agent>/agent.config.json` is present, orientation/job turns run with that declared policy (sandbox/network/approval); otherwise API defaults are used.

## File-Change Supervisor Pipeline (Best-Effort Event-Driven Queue)

File-change supervision is executed as agent-driven queue work:

1. Pending file-change approval requests emit `file_change.approval_requested` with normalized diff details plus turn/user context.
2. Supervisor event handlers enqueue one `agent_instruction` job per file-change event. The instruction requires ordered execution: diff explainability, supervisor insight, then optional auto actions.
3. The supervisor writes explainability and insight rows through `POST /api/sessions/:sessionId/transcript/upsert`, anchored to the file-change item/approval for inline UI grouping.
4. While `agent_instruction` jobs run, the API mirrors assistant output snapshots into supplemental transcript rows (`type: agent.jobOutput`, `messageId: agent-job-output::<jobId>`) for live queue observability in the source chat.
5. Worker turn completion for hidden agent chats is resolved from runtime notification streams (`turn/*`, `item/*`, agent-message deltas); `thread/read(includeTurns)` is kept as bounded fallback.
6. Queue terminal reconciliation is payload-driven: extension handlers provide `supplementalTargets` (message id/type/placeholder/fallback contract), and core reconciles these to explicit terminal transcript states when needed.
7. Turn completion emits `turn.completed` only when file-change approval activity occurred in that turn; supervisor handlers enqueue one turn-level `agent_instruction` review job.
8. This pipeline is best-effort eventual and must not block foreground user turn streaming.

---

## Deleting a Session (Harness Extension)

`codex app-server` does not expose a native `thread/delete` method, so hard-delete is implemented in the backend API layer.

1. UI calls `DELETE /api/sessions/:sessionId`
2. Backend interrupts any active turn for that thread (best effort)
3. Backend purges matching session artifacts from repo-local `CODEX_HOME` stores
4. Backend marks the session id as purged for process lifetime
5. Backend broadcasts `session_deleted` over WebSocket to all clients
6. Backend returns HTTP `410 Gone` for future operations against that session id
7. UI removes the deleted chat from the list; if active, the right pane is blocked until user selects or creates another chat

---

## Assigning a Session to a Project (Harness Metadata Extension)

Project associations are harness-owned metadata, not native app-server thread fields.

1. UI calls `POST /api/sessions/:sessionId/project` with `projectId` or `null`
2. Backend validates the target project (if provided) and verifies the session exists (persisted thread or currently loaded non-materialized thread)
3. Backend updates persisted harness metadata (`.data/session-metadata.json`) and maintains the supplemental transcript ledger (`.data/supplemental-transcript.json`) for non-native runtime audit rows.
4. Backend broadcasts `session_project_updated` (and related project events when relevant) to all clients
5. UI removes assigned chats from `Your chats` and renders them only under the corresponding project group

---

## Clearing or Deleting a Project (Harness Metadata Extension)

Projects are deleted only when empty.

1. UI can call `POST /api/projects/:projectId/chats/move-all` (`destination: "unassigned"` or `"archive"`) to clear assignments in bulk
2. UI can call `POST /api/projects/:projectId/chats/delete-all` to hard-delete all assigned chats in bulk
3. Backend persists metadata updates and emits `session_project_updated` / `session_deleted` events for cross-client sync
4. UI calls `DELETE /api/projects/:projectId` only after cleanup; backend returns `409 project_not_empty` if live assigned chats remain and prunes stale assignment metadata that no longer maps to any existing/loaded thread

---

## Resuming a Session

1. UI selects session
2. Backend calls `thread/resume`
3. UI subscribes to event stream

---

## Canceling a Turn

1. UI triggers cancel
2. Backend calls `turn/interrupt`
3. Codex emits `turn/completed` with `status: "interrupted"`

---

# Streaming Model

Streaming is event-driven.

The backend must:

- Immediately forward delta events
- Preserve order
- Not buffer until completion
- Treat `item/completed` as authoritative
- Canonicalize transcript reconstruction per turn so synthetic raw-events ids (`item-N`) do not duplicate canonical items after restart/reload
- Persist locally observed event timestamps for transcript rows when item payloads do not provide explicit timing fields

UI must:

- Append deltas in-order
- Replace provisional content on completion
- Treat `turn/completed` and `turn/failed` as terminal turn signals for clearing active-turn UI state

---

# Approval Flow

When Codex requires approval:

1. Codex sends server-initiated JSON-RPC request
2. Backend pauses UI state
3. UI renders approval prompt
4. User selects decision
5. Backend responds to Codex request
6. Codex continues or finalizes item

The backend must:

- Track approval request ids
- Ensure exactly one response
- Prevent duplicate submission

---

# Data Persistence

## What Persists

- Session metadata
- Thread id
- Local UI state (optional)
- MCP configuration

## What Does Not Persist

- Codex reasoning internals
- Tool execution state (Codex handles persistence)

Codex itself persists rollout files.

---

# Failure Handling

## Codex Process Crash

Backend must:

- Detect process exit
- Restart app-server
- Attempt reconnection
- Mark active sessions as unstable

## Overload

If backend receives `-32001`:

- Retry with backoff

## Broken STDIO Pipe

Backend must:

- Terminate child
- Restart
- Reinitialize handshake

---

# Concurrency Model

- One Codex process per backend instance.
- Multiple threads may exist.
- Only one active turn per thread.
- Multiple WebSocket clients may subscribe to same session (optional).

---

# State Management

Backend maintains:

- Active thread map
- Active turn map
- Pending approval map
- WebSocket subscriber registry

UI maintains:

- Current session id
- Message list
- Streaming buffer
- Approval state
- Connection state

---

# Security Model

- Backend binds to localhost by default.
- No direct network exposure of Codex.
- Sandbox policy enforced by Codex.
- Approval policy enforced by Codex.
- No secrets in frontend.

---

# Extensibility Points

The system supports future expansion:

- Multi-session tabs
- Multi-user support
- Server-hosted MCP tools
- Background execution dashboard
- Review mode visualization
- File diff viewer panel

The protocol surface already supports these features.

---

# Deployment Modes

## Development

- Vite dev server for UI
- Node backend in watch mode
- Local Codex process

## Production (Local Desktop App)

- Static UI build
- Node backend packaged
- Bundled Codex binary or system dependency

---

# Architectural Invariants

These must always remain true:

1. Backend never modifies Codex semantic output.
2. Backend never synthesizes assistant content.
3. UI never talks directly to Codex.
4. Codex App Server is the only agent runtime.
5. `item/completed` is authoritative state.
6. Handshake is performed exactly once per connection.
7. Experimental APIs require explicit opt-in.

---

# Why This Architecture Works

- Minimal logic in backend → fewer bugs.
- Full Codex protocol fidelity.
- Clear separation of concerns.
- UI remains simple and reactive.
- Future-proof against protocol evolution.
- Supports entire Codex feature surface without redesign.

---

This architecture treats Codex App Server as a black-box engine and builds a clean, chat-like control surface around it while preserving full protocol capability.
