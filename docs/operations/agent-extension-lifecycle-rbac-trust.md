# Operations Deep Dive: Extension Lifecycle RBAC and Trust

## Purpose

Detailed policy reference for extension lifecycle authorization and trust enforcement.

Use with [`agent-extension-lifecycle-and-conformance.md`](./agent-extension-lifecycle-and-conformance.md).

## Lifecycle endpoint access model

Endpoints:

- `GET /api/agents/extensions`
- `POST /api/agents/extensions/reload`

Role resolution mode:

- `AGENT_EXTENSION_RBAC_MODE=disabled|header|jwt`

## Disabled mode

- loopback-only permissive behavior for local development
- non-loopback requests rejected

## Header mode

- requires shared token header and role header
- optional actor header
- loopback safety constraints unless explicitly relaxed

## JWT mode

- bearer token verification required
- role/actor claims mapped via configurable claim names

## Trust mode

`AGENT_EXTENSION_TRUST_MODE=disabled|warn|enforced`

Effect:

- controls how undeclared capability usage is handled at load/runtime

## Error contract patterns

Typical lifecycle auth/policy outcomes:

- unauthorized/missing token
- invalid role
- insufficient role
- undeclared capability (enforced trust)

## Related docs

- Lifecycle runbook: [`agent-extension-lifecycle-and-conformance.md`](./agent-extension-lifecycle-and-conformance.md)
- Extension authoring: [`agent-extension-authoring.md`](./agent-extension-authoring.md)
- Runtime event contracts: [`../protocol/harness-runtime-events.md`](../protocol/harness-runtime-events.md)
