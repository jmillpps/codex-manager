# Product: Agent Platform Requirements

## Purpose

This document defines the extension runtime framework requirements that complement the core chat/product requirements in `docs/prd.md`.

Primary question:

- What release-blocking product requirements apply to extension dispatch, lifecycle, trust, and portability?

## Functional requirements

### FR-16 Deterministic fanout event runtime

- Runtime events are fanout to all subscribed extension handlers.
- Handler execution is deterministic by:
  - `priority` ascending
  - module name ascending
  - registration order ascending
- One failing/slow handler must not block remaining handlers.

Acceptance criteria:

- Fanout tests cover 0/1/N handler scenarios.
- Ordering tests verify deterministic tie-break behavior.
- Timeout-isolation tests verify continued dispatch after timeout.

### FR-17 Typed dispatch and reconciliation

- Emit results must use typed envelopes.
- State-changing races use first-successful-wins semantics.
- User-first actions remain authoritative; late agent actions reconcile cleanly.

Acceptance criteria:

- Runtime and consumers use typed selection helpers.
- Reconciled statuses (`already_resolved`, `not_eligible`, `conflict`) are non-fatal.
- Unknown-shape event scanning is absent from active runtime consumer paths.

### FR-18 Extension lifecycle controls

- API exposes extension inventory and reload endpoints.
- Reload operations are role-gated and auditable.
- Reload behavior is atomic snapshot-swap.

Acceptance criteria:

- `GET /api/agents/extensions` returns loaded module inventory with origin/compatibility/trust metadata.
- `POST /api/agents/extensions/reload` preserves prior snapshot on reload failure.
- Concurrent reload requests are rejected safely.

### FR-19 Trust and capability enforcement

- Runtime supports trust policy modes:
  - `disabled`
  - `warn`
  - `enforced`
- Extension capabilities constrain declared event/action behavior.

Acceptance criteria:

- Enforced mode can deny undeclared capability usage deterministically.
- Trust and capability outcomes are surfaced via inventory/reload diagnostics.

### FR-20 Portable extension conformance

- At least one extension package must run across at least two runtime profiles.
- Conformance output must be generated as a release artifact.

Acceptance criteria:

- `node scripts/run-agent-conformance.mjs` passes.
- `.data/agent-conformance-report.json` shows profile pass parity and `portableExtension: true`.

## Technical requirements

### TR-6 Runtime profile adapter boundary

- Provider-specific runtime behavior must be isolated behind runtime profile adapters.
- Core extension/runtime contracts remain provider-neutral.

### TR-7 Extension compatibility enforcement

- Loader enforces core API compatibility and runtime-profile compatibility before activation.

### TR-8 Extension source portability

- Discovery supports repo-local roots and external/package roots.
- Inventory reports source origin metadata for each loaded extension.

### TR-9 Lifecycle RBAC/trust controls

- Lifecycle mutation endpoints support configurable role resolution and trust modes.

### TR-10 Release conformance gate

- Release gate includes:
  - API/web typecheck and test suites
  - runtime smoke validation
  - portability conformance artifact generation

## Success metrics

- Deterministic dispatch/reconciliation tests remain green.
- Extension reload/list RBAC + audit paths remain green.
- Portable extension conformance remains green across at least two profiles.
- No no-ship condition is true at release gate.

## Related references

- `docs/prd.md`
- `docs/operations/agent-platform-verification-matrix.md`
- `docs/operations/release-gate-checklist.md`
- `docs/architecture/agent-extension-runtime.md`
