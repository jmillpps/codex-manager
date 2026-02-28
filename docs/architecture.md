# Architecture

## Purpose

This is the one-level-deeper architecture guide for Codex Manager.

It starts where `README.md` stops: the README tells you what the platform is; this document explains how the platform is shaped, where responsibilities begin/end, and why specific runtime constraints exist.

Use this document to build the correct mental model before changing API, web, CLI, extension runtime, or Python SDK behavior.

## What You Should Understand After Reading

- Why `codex app-server` is the runtime authority and what Codex Manager is allowed to do around it.
- How control-plane interfaces (web, CLI, Python SDK) converge on one API contract.
- How stream events, queue workflows, and extension handlers fit together without blocking foreground turns.
- Where state is durable versus in-memory, and what restart behavior follows from that.
- Which docs contain protocol-level and operations-level deep detail.

## System Boundary

Codex Manager is a local-first control plane.

- **Inside Codex Manager**:
  - Fastify API, websocket fan-out, metadata/session settings persistence, queue workers, extension runtime dispatch.
  - Product-specific orchestration (for example suggest-request jobs, supervisor side effects) implemented as extension-driven workflows.
- **Outside Codex Manager**:
  - `codex app-server` runtime semantics (thread/turn/item lifecycle, approvals, tool-call behavior).
  - MCP server tool execution.

Core rule: Codex Manager does not replace runtime authority; it supervises and translates it.

## High-Level Topology

```text
Web UI / CLI / Python SDK
         |
         v
Fastify API (control plane)
  - session/project APIs
  - approvals/tool-input/tool-call routes
  - extension runtime dispatch + queue orchestration
         |
         v
codex app-server (supervised over STDIO)
         |
         +--> websocket event stream fan-out
         +--> durable local state under .data/
```

## Component Responsibilities

## 1) Interfaces (Web / CLI / Python SDK)

All client surfaces are control-plane clients over the same API contract.

- Web: primary operator workspace and transcript UX.
- CLI: route-complete operational automation and diagnostics.
- Python SDK: programmable automation, stream handlers, typed wrappers, remote skill bridges.

No interface talks to `codex app-server` directly.

## 2) API Control Plane (`apps/api`)

The API is stateful and protocol-aware.

It is responsible for:

- supervising `codex app-server` process lifecycle.
- protocol adaptation (`/`-method runtime events -> REST/websocket surfaces).
- session/project/session-settings metadata durability under `.data/`.
- queue lifecycle, worker session provisioning, retries, reconciliation.
- extension discovery/load/reload/trust enforcement.

It is not responsible for inventing new runtime semantics that conflict with app-server truth.

## 3) Runtime Authority (`codex app-server`)

`codex app-server` is authoritative for thread/turn/item semantics.

Codex Manager can add harness workflows around runtime events (queue jobs, transcript augmentation, governance controls), but runtime truth still comes from Codex lifecycle notifications and read methods.

## 4) Extension Runtime

Extensions are the feature-semantics layer for orchestrated workflows.

- API core exposes deterministic dispatch + execution primitives.
- Extensions subscribe to named events and enqueue jobs or request scoped actions.
- Trust/capability policy controls what undeclared modules may do.

This keeps API core generic and workflow logic replaceable.

## Data and Durability Model

Durable state is stored under `.data/` and includes:

- session metadata and project mappings.
- supplemental transcript/event ledger used for resilient transcript reconstruction.
- extension lifecycle audit data.
- queue persistence/snapshots and conformance artifacts.

In-memory state is used for active stream tracking, pending runtime requests, and currently running queue jobs.

Implication: first-turn/non-materialized chat windows and transient runtime request maps may not survive restart until materialized/persisted.

## Lifecycle Model

A typical foreground turn path:

1. Interface sends `POST /api/sessions/:sessionId/messages`.
2. API starts runtime turn through app-server.
3. Runtime notifications stream through API and fan out via websocket.
4. Interface renders progressive transcript and final completion state.

A background workflow path:

1. Runtime/system event is emitted into extension runtime.
2. Handler enqueues queue job (deduped by stable key).
3. Worker session executes one instruction turn.
4. Side effects update transcript/approval/steer/suggest routes.
5. Queue terminal reconciliation ensures explicit terminal state.

Foreground and background paths are intentionally decoupled.

## Security, Trust, and Governance

Security model is local-first with explicit governance controls:

- session controls tuple (`model`, approval policy, network, sandbox).
- generic per-session settings store used by UI/CLI/extensions.
- extension lifecycle RBAC (`disabled|header|jwt`) and trust policy (`disabled|warn|enforced`).
- system-owned worker session isolation from default user session lists.

The goal is deterministic operation under explicit operator policy, not hidden automation.

## Failure and Recovery Principles

- API supervision restarts app-server process when needed.
- Queue jobs always end in explicit terminal states.
- retries are bounded and classification-driven.
- stale worker mappings are reprovisioned once before hard failure.
- websocket traffic is not the only source of truth; read-path reconciliation exists for recovery windows.

## Design Invariants

1. App-server runtime semantics remain authoritative.
2. Interface/API contracts remain consistent across web/CLI/Python.
3. Extensions own workflow semantics; API core owns execution guarantees.
4. Background workflows never block foreground turn streaming.
5. Durable state is written to ignored runtime paths (primarily `.data/`).

## Read Next (Level 2)

- Extension runtime architecture: [`architecture/agent-extension-runtime.md`](./architecture/agent-extension-runtime.md)
- Runtime event contracts: [`protocol/harness-runtime-events.md`](./protocol/harness-runtime-events.md)
- Agent SDK contract: [`protocol/agent-runtime-sdk.md`](./protocol/agent-runtime-sdk.md)
- Setup/run operations: [`operations/setup-and-run.md`](./operations/setup-and-run.md)
- Current implementation coverage: [`implementation-status.md`](./implementation-status.md)
