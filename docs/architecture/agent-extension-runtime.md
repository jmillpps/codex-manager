# Architecture: Agent Extension Runtime

## Purpose

This document describes the extension runtime architecture hosted by `apps/api`.

Primary questions:

- How are extensions discovered and loaded?
- How does fanout event dispatch behave?
- How are lifecycle and trust controls enforced?
- Where does provider-specific runtime behavior live?

## Source discovery model

The runtime discovers extension modules from deterministic roots:

1. repo-local root: `agents/`
2. installed package roots: `AGENT_EXTENSION_PACKAGE_ROOTS`
3. configured roots: `AGENT_EXTENSION_CONFIGURED_ROOTS`

Source precedence is deterministic:

1. `repo_local`
2. `installed_package`
3. `configured_root`

Within each source type, roots are sorted lexicographically.

If the same physical extension root is discovered through multiple source types, runtime keeps the highest-precedence origin and ignores lower-precedence duplicates.

A directory is treated as an extension root when it contains at least one of:

- `extension.manifest.json`
- `events.js`
- `events.mjs`
- `events.ts`

Repo-local discovery ignores:

- `agents/runtime`
- `agents/lib`
- dot-prefixed directories

## Manifest and compatibility model

When present, `extension.manifest.json` is parsed for:

- identity: `name`, `version`, `agentId`, `displayName`
- runtime compatibility:
  - `runtime.coreApiVersion`
  - `runtime.coreApiVersionRange`
  - `runtime.profiles[]` (`name`, `version`, `versionRange`)
- entrypoints (`events`, `orientation`, `instructions`, `config`)
- capability declarations (`events[]`, `actions[]`)

Compatibility is enforced against active runtime values:

- core runtime version
- runtime profile id/version
- semver-compatible `coreApiVersionRange` and `runtime.profiles[].versionRange` matching

Incompatible modules are rejected before registration.

## Event runtime contract

The runtime hosts deterministic fanout dispatch:

- all handlers for an event are invoked
- order key:
  - `priority` ascending
  - module name ascending
  - registration index ascending
- each handler has timeout isolation
- handler failures/timeouts are normalized to `handler_error`
- handler invocation is always fanout; action execution inside one emit is first-wins reconciled

Emit results are typed envelopes:

- `enqueue_result`
- `action_result`
- `handler_result`
- `handler_error`

Action reconciliation semantics:

- first successful state-changing action (`status: performed`) is authoritative
- once a winner exists, later action requests in that same emit pass are reconciled as `not_eligible` and not executed
- loser-path statuses (`already_resolved`, `not_eligible`, `conflict`) are reconciled non-fatal outcomes

## Worker session model

Worker sessions are system-owned and owner-scoped:

- key: `${ownerId}::${agent}`
- `ownerId` is project id or `session:<sessionId>` for unassigned-chat workflows
- hidden from default user session list APIs (`GET /api/sessions`), with operator opt-in listing via `GET /api/sessions?includeSystemOwned=true` and owner mapping discovery via `GET /api/projects/:projectId/agent-sessions`
- readable through `GET /api/sessions/:sessionId`; mutating user-chat operations remain denied (`403 system_session`)

Worker provisioning behavior:

- session created lazily when the first `agent_instruction` enqueue path resolves the worker
- mandatory one-time core system orientation turn (queue-runner posture + CLI-surface guidance) during startup preflight
- optional one-time extension bootstrap instruction supplied by queue payload (`bootstrapInstruction`) during startup preflight
- worker turn policy can be read from extension `agent.config.json`

## Lifecycle control surfaces

### Extension inventory

`GET /api/agents/extensions`

Returns snapshot metadata and per-module inventory including:

- source origin (`repo_local` | `installed_package` | `configured_root`)
- compatibility summary and reasons
- capability declarations
- trust evaluation summary

### Atomic reload

`POST /api/agents/extensions/reload`

Reload semantics:

- candidate snapshot is built and validated
- active snapshot swaps only on success
- failed reload preserves prior active snapshot
- concurrent reload attempts return `reload_in_progress`

## RBAC, trust, and audit

RBAC mode:

- `AGENT_EXTENSION_RBAC_MODE=disabled|header|jwt`

Mode behavior:

- `disabled`: loopback-only bypass for development (`admin` role); non-loopback callers are rejected with `403 rbac_disabled_remote_forbidden`
- `header`: role resolved from `x-codex-role` and optional actor from `x-codex-actor`, gated by shared token `x-codex-rbac-token`
- `jwt`: role/actor resolved from verified bearer token claims

Header mode safety guard:

- unless `AGENT_EXTENSION_ALLOW_INSECURE_HEADER_MODE=true`, header mode requires loopback host binding (`127.0.0.1`, `::1`, or `localhost`) and `AGENT_EXTENSION_RBAC_HEADER_SECRET`

Header mode config:

- `AGENT_EXTENSION_RBAC_HEADER_SECRET`
- request header `x-codex-rbac-token: <AGENT_EXTENSION_RBAC_HEADER_SECRET>`

JWT mode config:

- `AGENT_EXTENSION_RBAC_JWT_SECRET` (required)
- optional: `AGENT_EXTENSION_RBAC_JWT_ISSUER`, `AGENT_EXTENSION_RBAC_JWT_AUDIENCE`
- claim mapping: `AGENT_EXTENSION_RBAC_JWT_ROLE_CLAIM` (default `role`), `AGENT_EXTENSION_RBAC_JWT_ACTOR_CLAIM` (default `sub`)

Trust mode:

- `AGENT_EXTENSION_TRUST_MODE=disabled|warn|enforced`

Trust/capability enforcement:

- undeclared events/actions are allowed, warned, or denied depending on mode
- enforced mode can deny extension activation and action execution

Audit log:

- all reload attempts (success/failed/forbidden) are persisted to:
  - `.data/agent-extension-audit.json`

## Runtime profile adapter boundary

Provider-specific operations are isolated behind the runtime profile adapter contract:

- turn start/read/interrupt
- approval decision
- turn steer
- transcript capability side effects

This keeps extension/runtime core contracts provider-neutral while allowing concrete profile implementations.

## Related references

- Runtime SDK contract: [`../protocol/agent-runtime-sdk.md`](../protocol/agent-runtime-sdk.md)
- Dispatch and reconciliation rules: [`../protocol/agent-dispatch-and-reconciliation.md`](../protocol/agent-dispatch-and-reconciliation.md)
- Packaging and compatibility model: [`../protocol/agent-extension-packaging.md`](../protocol/agent-extension-packaging.md)
- Lifecycle and conformance operations: [`../operations/agent-extension-lifecycle-and-conformance.md`](../operations/agent-extension-lifecycle-and-conformance.md)
- Queue framework foundation: [`../operations/agent-queue-framework.md`](../operations/agent-queue-framework.md)
