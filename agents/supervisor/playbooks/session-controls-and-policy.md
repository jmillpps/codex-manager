# Playbook: Session Controls and Approval Policy

## Purpose

Use this playbook for persisted control tuples (`model`, approval policy, network access, sandbox), default-vs-session scope behavior, and compatibility approval-policy route handling.

Primary API reference surface: `apps/api/src/index.ts`, `apps/api/src/env.ts`

## Endpoints Covered

- `GET /api/sessions/:sessionId/session-controls`
- `POST /api/sessions/:sessionId/session-controls`
- `POST /api/sessions/:sessionId/approval-policy`

Related call sites:

- `POST /api/sessions` (initial controls on create)
- `POST /api/sessions/:sessionId/messages` (applies controls on `turn/start`)

## Session Controls Tuple

```json
{
  "model": "string|null",
  "approvalPolicy": "untrusted|on-failure|on-request|never",
  "networkAccess": "restricted|enabled",
  "filesystemSandbox": "read-only|workspace-write|danger-full-access"
}
```

## Contracts and Semantics

### Read controls

- Route: `GET /api/sessions/:sessionId/session-controls`
- Behavior:
  - existence-gated session id
  - returns computed view of session + default controls
- Response: `{ status: "ok", ...sessionControlsResponse }`

### Apply controls

- Route: `POST /api/sessions/:sessionId/session-controls`
- Body:
  - `scope`: `session | default`
  - `controls`: full tuple (required)
  - optional audit metadata: `actor`, `source`
- Behavior:
  - validates and normalizes controls
  - if `scope=default` and `SESSION_DEFAULTS_LOCKED=true`, returns locked response
  - writes audit entry when changed
  - persists metadata
- Responses:
  - `200 { status: "ok" | "unchanged", scope, applied, summary, ... }`
  - `423 { status: "locked", ... }` for harness-locked defaults

### Legacy approval policy route

- Route: `POST /api/sessions/:sessionId/approval-policy`
- Body: `{ approvalPolicy }`
- Behavior:
  - compatibility route
  - updates session approval policy storage and returns resolved policy
- Response: `{ status: "ok", sessionId, approvalPolicy }`

## Execution Semantics

- On `POST /api/sessions/:sessionId/messages`, persisted controls are mapped into `turn/start`:
  - sandbox via `toTurnSandboxPolicy(...)`
  - approval policy via protocol enum mapping
  - model override if set
- If message send fails before acceptance, control persistence is not orphaned.

## Guardrails

- Controls routes are denied for system-owned sessions (`403`).
- Controls routes are existence-gated (`404` for unknown session id).
- Deleted sessions return `410` with deleted payload semantics.

## Repro Snippets

```bash
# Read controls
curl -sS http://127.0.0.1:3001/api/sessions/<sessionId>/session-controls

# Apply per-session controls
curl -sS -X POST http://127.0.0.1:3001/api/sessions/<sessionId>/session-controls \
  -H 'content-type: application/json' \
  -d '{
    "scope":"session",
    "controls":{
      "model":null,
      "approvalPolicy":"on-request",
      "networkAccess":"restricted",
      "filesystemSandbox":"workspace-write"
    },
    "actor":"supervisor",
    "source":"api"
  }'

# Legacy approval-policy update
curl -sS -X POST http://127.0.0.1:3001/api/sessions/<sessionId>/approval-policy \
  -H 'content-type: application/json' \
  -d '{"approvalPolicy":"never"}'
```

## Supervisor Notes

- Use this playbook to enforce control-tuple expectations and lock behavior at runtime.
- Verify message-turn execution reflects applied controls (`approvalPolicy`, `networkAccess`, `filesystemSandbox`, and `model`).
