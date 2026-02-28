# Playbook: Session and Turn Controls (Supervisor Scope)

## Purpose

Use this playbook only for turn-control actions that are directly requested by supervisor jobs. This playbook is intentionally narrow. The supervisor is not responsible for general chat/session lifecycle operations such as creating chats, sending user messages, archiving chats, or deleting chats. Default-title rename handling is a separate workflow documented in `playbooks/orchestrator-jobs-and-suggested-request.md` (`jobKind: session_initial_rename`).

Primary API reference surface: `apps/api/src/index.ts`

## Endpoints Covered for Supervisor Jobs

- `POST /api/sessions/:sessionId/turns/:turnId/steer`

## Supervisor-Allowed Control Flow

For auto-steer and similar supervisor-driven actions:

- use `sessionId = sourceSessionId` from the job payload
- use `turnId` from the same job payload
- include concise risk context, what changed, and what adaptation is required
- keep steer guidance action-oriented and scoped to the active turn

Steer should only be attempted when policy enables it and steer threshold conditions are met.

## Turn Steer Contract

Route: `POST /api/sessions/:sessionId/turns/:turnId/steer`

Body:

- `input` (non-empty text)

Behavior:

- forwards to protocol `turn/steer`
- expected target is an active turn for the given session

Responses:

- `200 { status: "ok", ... }` when steer accepted
- `404 { status: "not_found" }` when session/turn is unavailable
- `409` class outcomes when active-turn expectations no longer hold

## Reconciliation Semantics

- `404 not_found` or `409` on steer means the turn is no longer steerable for this request window.
- Treat those responses as terminal reconciliation for the steer attempt.
- Do not retry steer indefinitely.

## Out of Scope for Supervisor

The following route families are outside supervisor duties in normal queue job execution:

- session creation and user message sending
- session rename/archive/unarchive/delete/fork/rollback/compact
- broad session browsing not required for a queued supervisory job

## Repro Snippet

```bash
curl -sS -X POST http://127.0.0.1:3001/api/sessions/<sessionId>/turns/<turnId>/steer \
  -H 'content-type: application/json' \
  -d '{"input":"High-risk change detected. Revise approach to avoid destructive edits and verify with a safe read command first."}'
```

## Supervisor Notes

- Use this playbook only when a queued supervisor policy requires steer behavior.
- Keep steer content specific to the triggering job context and risk signal.
