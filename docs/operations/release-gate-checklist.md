# Operations: Agent Platform Release Gate Checklist

## Purpose

This checklist defines the required release gate for the agent platform runtime surfaces.

Use it to prevent contract drift between implementation, tests, and operational documentation.

## Required command gate

Run from repository root:

```bash
pnpm --filter @repo/api typecheck
pnpm --filter @repo/api test
pnpm --filter @repo/web typecheck
pnpm --filter @repo/web test
pnpm smoke:runtime
node scripts/run-agent-conformance.mjs
```

Release gate status is green only when all commands pass.

## Contract/doc parity gate

Before release, verify all are true:

1. Extension lifecycle API docs match runtime behavior:
   - `docs/operations/agent-extension-lifecycle-and-conformance.md`
   - `docs/protocol/harness-runtime-events.md`
2. Runtime event contract docs match typed envelope behavior and dispatch ordering:
   - `docs/protocol/harness-runtime-events.md`
   - `docs/operations/agent-queue-framework.md`
3. Runtime profile portability docs match conformance output artifact:
   - `node scripts/run-agent-conformance.mjs`
   - `.data/agent-conformance-report.json`
4. Operational env docs include active extension RBAC/trust/source-root settings:
   - `docs/operations/setup-and-run.md`
5. Implementation scope docs match API/web behavior:
   - `docs/implementation-status.md`

If any item fails, release is blocked.

## Lock-in closure checklist

### IC-001 Runtime profile adapter boundary

Required evidence:

- `apps/api/src/runtime-profile-adapter.ts`
- `apps/api/src/runtime-profile-adapter.contract.test.ts`

### IC-002 External extension discovery/source inventory

Required evidence:

- `apps/api/src/agent-events-runtime.ts`
- `apps/api/src/agent-extension-inventory.ts`
- `apps/api/src/agent-extension-inventory.test.ts`

### IC-003 Typed deterministic dispatch

Required evidence:

- `packages/agent-runtime-sdk/src/index.ts`
- `apps/api/src/agent-events-runtime.ts`
- `apps/api/src/agent-events-runtime.test.ts`
- `apps/api/src/agent-events-timeout-isolation.test.ts`

### IC-004 Capability/action semantics

Required evidence:

- `packages/agent-runtime-sdk/src/index.ts`
- `apps/api/src/runtime-profile-adapter.ts`
- `apps/api/src/agent-event-reconciliation.test.ts`
- `apps/api/src/supervisor-extension-workflow.test.ts`

### IC-005 Trust and capability enforcement

Required evidence:

- `apps/api/src/agent-extension-trust.ts`
- `apps/api/src/agent-extension-trust.test.ts`
- `apps/api/src/agent-events-runtime.ts`

### IC-006 Lifecycle controls, RBAC, atomic reload

Required evidence:

- `apps/api/src/index.ts` (`/api/agents/extensions`, `/api/agents/extensions/reload`)
- `apps/api/src/agent-events-reload.test.ts`
- `apps/api/src/agent-extension-rbac.test.ts`
- `apps/api/src/agent-extension-endpoints.test.ts`

### IC-007 Portability conformance harness

Required evidence:

- `apps/api/src/agent-conformance.ts`
- `apps/api/src/agent-conformance.test.ts`
- `apps/api/src/runtime-profile-compatibility.test.ts`
- `scripts/run-agent-conformance.mjs`

### IC-008 Governance and parity guardrail

Required evidence:

- this checklist file
- `docs/operations/generation-and-validation.md`
- `docs/implementation-status.md`

## Related references

- `docs/ops.md`
- `docs/operations/generation-and-validation.md`
- `docs/operations/agent-platform-verification-matrix.md`
- `docs/operations/agent-extension-lifecycle-and-conformance.md`
- `docs/implementation-status.md`
