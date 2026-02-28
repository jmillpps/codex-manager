# Protocol: Agent Extension Packaging and Compatibility

## Purpose

This document defines extension package layout, manifest fields, and loader compatibility behavior.

Primary question:

- What must an extension package contain to load and run portably?

## Extension identity

Each package should declare:

- `name`
- `version`
- `agentId`
- `displayName`

These fields are required for manifest-based identity and inventory reporting.

## Package layout

Recommended package shape:

```text
<extension-root>/
  extension.manifest.json
  events.js|events.mjs|events.ts
  AGENTS.md
  agent.config.json
  playbooks/
```

Runtime entrypoint requirement:

- extension is loadable only when an events entrypoint exists (`events.js|events.mjs|events.ts`)

## Manifest fields supported by runtime

`extension.manifest.json` currently supports:

- identity:
  - `name`
  - `version`
  - `agentId`
  - `displayName`
- runtime compatibility:
  - `runtime.coreApiVersion`
  - `runtime.coreApiVersionRange`
  - `runtime.profiles[]` with `name`, optional `version`, optional `versionRange`
- entrypoints:
  - `entrypoints.events`
  - `entrypoints.config`
  - optional metadata keys (`entrypoints.orientation`, `entrypoints.instructions`) may be present for extension tooling but are not required for runtime execution
- capabilities:
  - `capabilities.events[]`
  - `capabilities.actions[]`

Unknown fields are ignored by runtime parser.

## Source roots and origin types

Extensions can load from:

- repo-local `agents/` (`origin.type = repo_local`)
- `AGENT_EXTENSION_PACKAGE_ROOTS` (`origin.type = installed_package`)
- `AGENT_EXTENSION_CONFIGURED_ROOTS` (`origin.type = configured_root`)

Inventory reports origin path and type per loaded module.

When one extension root is reachable from multiple source types, loader de-duplicates by root path and keeps the highest-precedence origin (`repo_local` > `installed_package` > `configured_root`).

## Compatibility checks

At load/reload, runtime enforces:

- manifest shape validity (when manifest exists)
- events entrypoint presence
- core API compatibility (`coreApiVersion`, `coreApiVersionRange`)
- runtime profile compatibility (`runtime.profiles[]`)
- `agentId` uniqueness across loaded modules

Range evaluation uses full semver compatibility checks (major/minor/patch), not major-only matching.

Incompatibilities are rejected with structured diagnostics.

## Trust and capability checks

Trust behavior is controlled by `AGENT_EXTENSION_TRUST_MODE`:

- `disabled`
- `warn`
- `enforced`

In enforced mode:

- undeclared event capability registration can deny extension activation
- undeclared action attempts are rejected during dispatch

## Lifecycle API and inventory contract

`GET /api/agents/extensions` returns per-module details including:

- identity and entrypoint paths
- event subscriptions
- origin metadata
- compatibility summary and reasons
- capability declaration
- trust evaluation and diagnostics

`POST /api/agents/extensions/reload` performs atomic reload and returns structured success/failure payloads.

## Portability conformance

Release conformance is verified by:

- `node scripts/run-agent-conformance.mjs`

Expected artifact:

- `.data/agent-conformance-report.json`

Portable extension success requires equivalent pass behavior across at least two runtime profiles.

## Related references

- Runtime SDK contract: [`agent-runtime-sdk.md`](./agent-runtime-sdk.md)
- Dispatch/reconciliation rules: [`agent-dispatch-and-reconciliation.md`](./agent-dispatch-and-reconciliation.md)
- Lifecycle and conformance operations: [`../operations/agent-extension-lifecycle-and-conformance.md`](../operations/agent-extension-lifecycle-and-conformance.md)
- Extension authoring runbook: [`../operations/agent-extension-authoring.md`](../operations/agent-extension-authoring.md)
