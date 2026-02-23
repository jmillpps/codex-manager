# Operations: Agent Extension Lifecycle and Conformance

## Purpose

This runbook defines how to operate extension lifecycle controls, trust/capability policy, extension source roots, and release conformance checks.

Primary questions:

- How are extensions discovered and reloaded safely?
- How is lifecycle mutation access role-gated?
- How do we validate portable extension behavior across runtime profiles?

## Runtime source model

The runtime loads extension modules from deterministic source roots:

1. repo-local root: `agents/` (always included)
2. installed package roots: `AGENT_EXTENSION_PACKAGE_ROOTS`
3. configured roots: `AGENT_EXTENSION_CONFIGURED_ROOTS`

Each root can contain either:

- one extension directory directly, or
- multiple extension subdirectories.

An extension root is recognized when it contains at least one of:

- `extension.manifest.json`
- `events.js`
- `events.mjs`
- `events.ts`

Source precedence is deterministic:

1. `repo_local`
2. `installed_package`
3. `configured_root`

Within a source type, paths are sorted lexicographically.

If one extension root is discovered from multiple source types, runtime keeps the highest-precedence source and suppresses lower-precedence duplicates.

## Extension manifest contract

For portable behavior, each extension should ship `extension.manifest.json` with:

- identity: `name`, `version`, `agentId`, `displayName`
- runtime compatibility: `runtime.coreApiVersion` and/or `runtime.coreApiVersionRange`
- runtime profiles: `runtime.profiles[]` (`name`, `version` or `versionRange`)
- entrypoint path: `entrypoints.events`
- capability declaration: `capabilities.events[]`, `capabilities.actions[]`

Compatibility is enforced at load/reload time. Incompatible modules are rejected with structured diagnostics.
Range matching uses full semver checks for `coreApiVersionRange` and profile `versionRange`.

## Lifecycle API

### List loaded extensions

`GET /api/agents/extensions`

Access:

- `member`, `admin`, `owner`, `system`

Response includes:

- snapshot metadata: `snapshotVersion`, `loadedAt`
- module inventory:
  - identity and paths (`name`, `version`, `agentId`, `manifestPath`, `entrypointPath`)
  - `origin` (`repo_local`, `installed_package`, `configured_root` + path)
  - declared `events`
  - compatibility summary (`core/profile`, reasons)
  - declared capabilities and trust evaluation

### Reload extensions

`POST /api/agents/extensions/reload`

Access:

- `admin`, `owner`, `system`

Reload semantics:

- atomic snapshot-swap
- in-flight emits continue on prior snapshot
- failed reload keeps prior active snapshot
- concurrent reload attempts return `reload_in_progress`

Success payload includes:

- `status: "ok"`
- `reloadId`
- `loadedCount`
- `snapshotVersion`
- loaded module summaries

Failure payload includes:

- `status: "error"`
- `code: "reload_failed" | "reload_in_progress"`
- structured `errors[]`

### Response examples

Reload success:

```json
{
  "status": "ok",
  "reloadId": "a8f7...",
  "loadedCount": 3,
  "failedCount": 0,
  "snapshotVersion": "8b53...",
  "loadedAt": "2026-02-23T00:00:00.000Z",
  "modules": [
    {
      "name": "@acme/supervisor-agent",
      "version": "1.0.0",
      "agentId": "supervisor",
      "events": [
        "file_change.approval_requested",
        "turn.completed",
        "suggest_request.requested"
      ]
    }
  ]
}
```

Reload failure:

```json
{
  "status": "error",
  "code": "reload_failed",
  "reloadId": "d14e...",
  "message": "extension reload failed; prior snapshot preserved",
  "snapshotVersion": "8b53...",
  "errors": [
    {
      "extension": "@acme/supervisor-agent",
      "code": "incompatible_runtime",
      "message": "requires coreApiVersionRange >=2 <3; runtime=1"
    }
  ]
}
```

## RBAC model

Configure role resolution with:

- `AGENT_EXTENSION_RBAC_MODE=disabled|header|jwt`

Behavior:

- `disabled` (default): loopback requests are treated as admin for local development; non-loopback callers are rejected (`403 rbac_disabled_remote_forbidden`)
- `header`: role resolved from `x-codex-role` after shared-token validation via `x-codex-rbac-token`
- `jwt`: role and actor resolved from verified bearer token claims

Allowed role values:

- `member`
- `admin`
- `owner`
- `system`

Optional actor id header:

- `x-codex-actor`

Header-mode shared token configuration:

- `AGENT_EXTENSION_RBAC_HEADER_SECRET` (required unless `AGENT_EXTENSION_ALLOW_INSECURE_HEADER_MODE=true`)
- request header: `x-codex-rbac-token: <AGENT_EXTENSION_RBAC_HEADER_SECRET>`

JWT configuration:

- required: `AGENT_EXTENSION_RBAC_JWT_SECRET`
- optional: `AGENT_EXTENSION_RBAC_JWT_ISSUER`, `AGENT_EXTENSION_RBAC_JWT_AUDIENCE`
- claim mapping: `AGENT_EXTENSION_RBAC_JWT_ROLE_CLAIM` (default `role`), `AGENT_EXTENSION_RBAC_JWT_ACTOR_CLAIM` (default `sub`)

Header safety guard:

- unless `AGENT_EXTENSION_ALLOW_INSECURE_HEADER_MODE=true`, header mode requires loopback host binding (`127.0.0.1`, `::1`, or `localhost`) and `AGENT_EXTENSION_RBAC_HEADER_SECRET`

Structured auth errors:

- disabled mode remote caller: `403 { status: "forbidden", code: "rbac_disabled_remote_forbidden" }`
- missing header token: `401 { status: "unauthorized", code: "missing_header_token" }`
- invalid header token: `401 { status: "unauthorized", code: "invalid_header_token" }`
- missing role: `401 { status: "unauthorized", code: "missing_role" }`
- invalid role: `400 { status: "error", code: "invalid_role" }`
- missing bearer token: `401 { status: "unauthorized", code: "missing_bearer_token" }`
- invalid bearer token: `401 { status: "unauthorized", code: "invalid_bearer_token" }`
- invalid role claim: `403 { status: "forbidden", code: "invalid_role_claim" }`
- insufficient role: `403 { status: "forbidden", code: "insufficient_role", ... }`

## Trust and capability enforcement

Configure trust policy with:

- `AGENT_EXTENSION_TRUST_MODE=disabled|warn|enforced`

Mode behavior:

- `disabled`: trust/capability checks do not block activation
- `warn`: runtime allows activation and logs warnings for undeclared capabilities
- `enforced`: undeclared capabilities can deny module load or action execution

At load time, runtime compares registered event subscriptions against declared `capabilities.events`.

At emit time, runtime validates `action_request.actionType` against declared `capabilities.actions`:

- in `enforced` mode, undeclared actions are denied with `status: "forbidden"` and `code: "undeclared_capability"`

## Lifecycle audit log

Every reload attempt writes `.data/agent-extension-audit.json`.

Record fields include:

- `reloadId`, timestamp
- actor role/id
- request origin (ip/user-agent when available)
- result: `success` | `failed` | `forbidden`
- snapshot before/after
- trust mode
- failure summary and impacted extensions

Record shape also includes request origin fields (`ip`, `userAgent`) when available, plus snapshot before/after versions for mutation traceability.

Use this file for incident review and role-access auditing.
Audit appends are serialized in-process so concurrent reload attempts do not drop records.

## Operational commands

List inventory:

```bash
curl -sS http://127.0.0.1:3001/api/agents/extensions
```

Reload in local mode (`AGENT_EXTENSION_RBAC_MODE=disabled`):

```bash
# request must originate from loopback (for example 127.0.0.1 / ::1)
curl -sS -X POST http://127.0.0.1:3001/api/agents/extensions/reload
```

Reload in header mode:

```bash
curl -sS -X POST http://127.0.0.1:3001/api/agents/extensions/reload \
  -H 'x-codex-rbac-token: <AGENT_EXTENSION_RBAC_HEADER_SECRET>' \
  -H 'x-codex-role: admin' \
  -H 'x-codex-actor: ops-user'
```

Reload in JWT mode:

```bash
curl -sS -X POST http://127.0.0.1:3001/api/agents/extensions/reload \
  -H "Authorization: Bearer <jwt>"
```

## Conformance release gate

Run the portability conformance gate:

```bash
node scripts/run-agent-conformance.mjs
```

Output artifact:

- `.data/agent-conformance-report.json`

Current conformance requirements:

- report includes at least two runtime profile runs
- one portable extension fixture passes under both profiles
- report marks `portableExtension: true`

## Related references

- `docs/operations/agent-extension-authoring.md`
- `docs/operations/generation-and-validation.md`
- `docs/protocol/harness-runtime-events.md`
- `docs/implementation-status.md`
