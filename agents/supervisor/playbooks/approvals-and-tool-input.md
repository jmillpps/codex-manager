# Playbook: Approvals and Tool User Input

## Purpose

Use this playbook for approval-request and tool-input decision flows that originate from server-initiated app-server requests.

Primary API reference surface: `apps/api/src/index.ts`

## Endpoints Covered

- `GET /api/sessions/:sessionId/approvals`
- `POST /api/approvals/:approvalId/decision`
- `GET /api/sessions/:sessionId/tool-input`
- `POST /api/tool-input/:requestId/decision`

## Runtime Model

- Pending approvals are captured from server requests and stored in-memory (`pendingApprovals`).
- Pending tool-input requests are captured similarly (`pendingToolUserInputs`).
- Both are mirrored into supplemental transcript entries for durable UX reconstruction.
- User-driven decisions and supervisor-driven decisions can race; server state is authoritative.

## Contracts and Semantics

### List approvals

- Route: `GET /api/sessions/:sessionId/approvals`
- Response: `{ data: PendingApproval[] }`
- Side effect:
  - reconciles explainability enqueue for pending file-change approvals.
- Guards:
  - `403` system session
  - `410` deleted session

### Decide approval

- Route: `POST /api/approvals/:approvalId/decision`
- Body:
  - `decision`: `accept | decline | cancel`
  - `scope?`: `turn | session` (default `turn`)
- Behavior:
  - maps decision payload per approval method
  - calls `supervisor.respond(rpcId, payload)`
  - writes `approval.resolved` transcript entry
  - broadcasts `approval_resolved`
- Responses:
  - `200 { status: "ok", approvalId, threadId }`
  - `404 { status: "not_found" }` when approval id no longer pending

Race handling:

- `404 not_found` after an automated supervisor attempt means the approval was already resolved (commonly by user action).
- Treat this as terminal reconciliation, not as an error to retry.

### List tool-input requests

- Route: `GET /api/sessions/:sessionId/tool-input`
- Response: `{ data: PendingToolInput[] }`
- Guards: `403`, `410`

### Decide tool-input request

- Route: `POST /api/tool-input/:requestId/decision`
- Body:
  - `decision`: `accept | decline | cancel`
  - optional `answers` map
  - optional raw `response` object override
- Behavior:
  - calls `supervisor.respond(rpcId, payload)`
  - writes `tool_input.resolved` transcript entry
  - broadcasts `tool_user_input_resolved`
- Responses:
  - `200 { status: "ok", requestId, threadId }`
  - `404 { status: "not_found" }`

Race handling:

- `404 not_found` indicates the request already resolved and should be handled as reconciliation success.

## Expiration Semantics

When a thread/turn ends or is cleaned up, stale pending items are expired and broadcast as resolved-with-status:

- approval -> `approval_resolved` with `status: "expired"`
- tool input -> `tool_user_input_resolved` with `status: "expired"`

## Event Pairing (WebSocket)

- request events:
  - `approval`
  - `tool_user_input_requested`
- terminal events:
  - `approval_resolved`
  - `tool_user_input_resolved`

Clients should render request and terminal state from websocket authoritatively and use REST list routes as reconciliation fallback.

## Authority Rule

- User actions are authoritative for approval/tool-input outcomes.
- Supervisor automation must defer when requests are already resolved.

## Repro Snippets

```bash
# List pending approvals
curl -sS http://127.0.0.1:3001/api/sessions/<sessionId>/approvals

# Approve one pending approval for this turn
curl -sS -X POST http://127.0.0.1:3001/api/approvals/<approvalId>/decision \
  -H 'content-type: application/json' \
  -d '{"decision":"accept","scope":"turn"}'

# Submit tool input decision
curl -sS -X POST http://127.0.0.1:3001/api/tool-input/<requestId>/decision \
  -H 'content-type: application/json' \
  -d '{"decision":"accept","answers":{"q1":{"answers":["yes"]}}}'
```

## Supervisor Notes

- Use this playbook to drive approval/tool-input decision operations and interpret terminal lifecycle events.
- For expired/resolved/race cases, reconcile using both websocket events and the pending-list endpoints.
