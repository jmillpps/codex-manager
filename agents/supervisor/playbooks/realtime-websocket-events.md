# Playbook: Realtime WebSocket Events

## Purpose

Use this playbook for websocket protocol integration, event-driven UI updates, and reconciliation behavior.

Primary API reference surface: `apps/api/src/index.ts` (`/api/stream` + `publishToSockets(...)`).

## Endpoint Covered

- `GET /api/stream` (websocket)

## Wire Protocol

### Client -> server commands

- `{"type":"subscribe","threadId":"<sessionId>"}`
- `{"type":"unsubscribe"}`
- `{"type":"ping"}`

### Server immediate control messages

- `{"type":"ready","threadId":<initialThreadId|null>}` on connect
- `{"type":"pong"}` in response to ping
- `{"type":"error","message":"invalid websocket command"}` for malformed commands

## Event Filtering Model

- Connection has a thread filter (`threadId | null`).
- Events with a thread id are delivered only to matching subscribers unless flagged broadcast.
- Some events are broadcast to all sockets (project/account/app-level metadata updates).

## Event Catalog

### Transcript/runtime events

- `notification`
- `turn_plan_updated`
- `turn_diff_updated`
- `thread_token_usage_updated`

### Approval/tool-input lifecycle events

- `approval`
- `approval_resolved`
- `tool_user_input_requested`
- `tool_user_input_resolved`

### Orchestrator queue lifecycle events

- `orchestrator_job_queued`
- `orchestrator_job_started`
- `orchestrator_job_progress`
- `orchestrator_job_completed`
- `orchestrator_job_failed`
- `orchestrator_job_canceled`

### Session/project/account/integration events

- `session_deleted`
- `session_project_updated`
- `project_upserted`
- `project_deleted`
- `app_list_updated`
- `mcp_oauth_completed`
- `account_updated`
- `account_login_completed`
- `account_rate_limits_updated`

### Fallback passthrough event

- `server_request` (only when request is unsupported by current handler paths)

## Client Reconciliation Strategy

- Treat websocket events as first-class incremental state updates.
- Use REST snapshots as bounded fallback reconciliation when terminal events are missed.
- For queue-driven transcript rows (explainability/supervisor/turn review), refresh active transcript on orchestrator job lifecycle events.
- Do not assume ordering across unrelated event families; scope by thread id + item ids.

## Known UX-Critical Flows

- Approval cards:
   - request enters from `approval`
   - resolves via `approval_resolved`
- Tool input cards:
   - request enters from `tool_user_input_requested`
   - resolves via `tool_user_input_resolved`
- Queue-backed rendering:
   - orchestrator lifecycle events should trigger transcript/queue state refresh for active chat

## Repro Snippet

```javascript
const ws = new WebSocket("ws://127.0.0.1:3001/api/stream?threadId=<sessionId>");
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  console.log(msg.type, msg.payload ?? msg);
};

// later
ws.send(JSON.stringify({ type: "ping" }));
ws.send(JSON.stringify({ type: "subscribe", threadId: "<otherSessionId>" }));
```

## Supervisor Notes

- Use this playbook to verify websocket subscriptions, thread filtering, and event reconciliation behavior.
- Treat websocket state as primary and use REST reads for bounded reconciliation when events are missed.
