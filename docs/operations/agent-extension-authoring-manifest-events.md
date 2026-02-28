# Operations Deep Dive: Extension Manifest and Event Authoring

## Purpose

Detailed extension package and event registration guidance.

Use with [`agent-extension-authoring.md`](./agent-extension-authoring.md) for manifest correctness and deterministic event behavior.

## Package layout

Recommended:

```text
agents/<agent>/
  extension.manifest.json
  events.js|events.mjs|events.ts
  AGENTS.md
  agent.config.json
  playbooks/
```

## Manifest essentials

- identity: `name`, `version`, `agentId`, `displayName`
- runtime compatibility: core/profile version constraints
- `entrypoints.events`
- declared capabilities:
  - `capabilities.events[]`
  - `capabilities.actions[]`

## Event registration contract

Export `registerAgentEvents(registry)`.

Subscribe with:

- `registry.on(eventType, handler, { priority, timeoutMs })`

Dispatch order is deterministic by priority/module/registration index.

## Event naming families

- synthesized harness events (queue/workflow)
- `app_server.<normalized_method>`
- `app_server.request.<normalized_method>`

Normalization converts app-server method path segments into snake_case dot names.

## Handler output expectations

Handlers may return enqueue outputs, action requests, diagnostics, or no output.

Runtime normalizes all outputs into typed envelopes.

## Related docs

- Authoring runbook: [`agent-extension-authoring.md`](./agent-extension-authoring.md)
- Lifecycle and trust controls: [`agent-extension-lifecycle-and-conformance.md`](./agent-extension-lifecycle-and-conformance.md)
- Runtime SDK contract: [`../protocol/agent-runtime-sdk.md`](../protocol/agent-runtime-sdk.md)
