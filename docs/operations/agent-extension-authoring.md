# Operations: Agent Extension Authoring

## Purpose

This is the one-level extension authoring guide.

It describes how to build extension modules that subscribe to runtime events and enqueue queue work without adding workflow logic to API core.

## Authoring surface summary

Runtime contracts are provided by `@codex-manager/agent-runtime-sdk`.

Typical extension folder includes:

- `extension.manifest.json`
- `events.js|events.mjs|events.ts`
- optional `agent.config.json`
- optional playbooks/docs

## Core authoring rules

- export `registerAgentEvents(registry)`
- declare compatibility and capabilities in manifest
- subscribe to deterministic event names
- emit enqueue/action requests through runtime tools (not direct side effects in API core)
- use deterministic dedupe keys and stable transcript ids for idempotent workflows

## Event families to know

- synthesized workflow events
- `app_server.<normalized_method>`
- `app_server.request.<normalized_method>`

Scope behavior:

- pass-through app-server events are user-session scoped
- system-owned and purged/deleted sessions do not emit normal pass-through events into extension handlers

## Queue and worker model summary

- handlers enqueue jobs (`agent_instruction` common)
- worker sessions are system-owned and owner-scoped
- startup preflight includes orientation and optional bootstrap

## Validation expectations

Before merging extension changes, verify:

- manifest/capabilities compatibility
- dedupe and idempotency correctness
- retry/terminal behavior under failure windows
- trust-mode behavior for target deployment mode

## Read Next (Level 3)

- Manifest/events deep dive: [`agent-extension-authoring-manifest-events.md`](./agent-extension-authoring-manifest-events.md)
- Worker/job pattern deep dive: [`agent-extension-authoring-worker-jobs.md`](./agent-extension-authoring-worker-jobs.md)

## Related references

- Lifecycle and conformance: [`agent-extension-lifecycle-and-conformance.md`](./agent-extension-lifecycle-and-conformance.md)
- Queue framework: [`agent-queue-framework.md`](./agent-queue-framework.md)
- Runtime event contracts: [`../protocol/harness-runtime-events.md`](../protocol/harness-runtime-events.md)
