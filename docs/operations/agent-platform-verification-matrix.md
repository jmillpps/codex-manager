# Operations: Agent Platform Verification Matrix

## Purpose

This matrix maps runtime requirements to concrete test and release-gate evidence.

Use this as the implementation-facing verification index for the extension framework.

## Status legend

- `Required`: release-blocking requirement
- `Implemented`: test/evidence exists
- `Passing`: latest gate run is green

## Matrix

| ID | Requirement | Primary Evidence | Status |
|---|---|---|---|
| AV-001 | Fanout dispatch supports 0/1/N handlers | `apps/api/src/agent-events-runtime.test.ts` | Required / Implemented / Passing |
| AV-002 | Deterministic ordering by priority/module/registration index | `apps/api/src/agent-events-runtime.test.ts` | Required / Implemented / Passing |
| AV-003 | First successful state-changing action wins | `apps/api/src/agent-event-reconciliation.test.ts` | Required / Implemented / Passing |
| AV-004 | User-authoritative race reconciles agent-late outcomes | `apps/api/src/agent-event-reconciliation.test.ts` | Required / Implemented / Passing |
| AV-005 | Typed emit-result envelopes | `packages/agent-runtime-sdk/src/index.ts`, `apps/api/src/agent-event-selection.test.ts` | Required / Implemented / Passing |
| AV-006 | Suggest-request single-flight dedupe | `apps/api/src/orchestrator-queue.test.ts`, `scripts/test-api-contracts.mjs`, `tests/e2e/suggested-request-race.spec.ts` | Required / Implemented / Passing |
| AV-007 | File-change explainability then insight sequencing | `apps/api/src/supervisor-extension-workflow.test.ts` | Required / Implemented / Passing |
| AV-008 | Auto-action reconciliation semantics encoded deterministically | `apps/api/src/supervisor-extension-workflow.test.ts` | Required / Implemented / Passing |
| AV-009 | Turn-completed review enqueue is file-change gated | `apps/api/src/supervisor-extension-workflow.test.ts` | Required / Implemented / Passing |
| AV-010 | Queue jobs reach explicit terminal states | `apps/api/src/orchestrator-queue.test.ts` | Required / Implemented / Passing |
| AV-011 | Recovery mismatch does not silently lose queued work | `apps/api/src/orchestrator-queue.test.ts` | Required / Implemented / Passing |
| AV-012 | Loader failure isolation for malformed modules | `apps/api/src/agent-events-runtime.test.ts` | Required / Implemented / Passing |
| AV-013 | Extension inventory endpoint returns expected shape | `apps/api/src/agent-extension-endpoints.test.ts` | Required / Implemented / Passing |
| AV-014 | Reload is atomic and preserves prior snapshot on failure | `apps/api/src/agent-events-reload.test.ts` | Required / Implemented / Passing |
| AV-015 | Reload/list actions are role-gated | `apps/api/src/agent-extension-rbac.test.ts`, `apps/api/src/agent-extension-endpoints.test.ts` | Required / Implemented / Passing |
| AV-016 | Reload/list actions are auditable | `apps/api/src/agent-extension-endpoints.test.ts`, `apps/api/src/agent-extension-audit-store.ts` | Required / Implemented / Passing |
| AV-017 | Shareable extension compatibility checks | `apps/api/src/agent-extension-inventory.test.ts`, `apps/api/src/runtime-profile-compatibility.test.ts` | Required / Implemented / Passing |
| AV-018 | Websocket transcript delta convergence | `apps/web/tests/transcript-delta-convergence.test.tsx` | Required / Implemented / Passing |
| AV-019 | Foreground chat remains non-blocking with background workflows | `scripts/smoke-runtime.mjs`, `scripts/test-api-contracts.mjs` | Required / Implemented / Passing |
| AV-020 | Docs and implementation parity | `docs/operations/release-gate-checklist.md` parity checks | Required / Implemented / Passing |
| AV-021 | Core/profile compatibility enforcement | `apps/api/src/runtime-profile-compatibility.test.ts` | Required / Implemented / Passing |
| AV-022 | Portable extension conformance across two profiles | `apps/api/src/agent-conformance.test.ts`, `.data/agent-conformance-report.json` | Required / Implemented / Passing |
| AV-023 | Runtime profile adapter boundary enforced | `apps/api/src/runtime-profile-adapter.contract.test.ts` | Required / Implemented / Passing |
| AV-024 | External extension source loading beyond repo-local roots | `apps/api/src/agent-extension-inventory.test.ts` | Required / Implemented / Passing |
| AV-025 | Handler timeout isolation | `apps/api/src/agent-events-timeout-isolation.test.ts` | Required / Implemented / Passing |
| AV-026 | Typed event consumer parsing only | `apps/api/src/typed-event-consumer-guard.test.ts` | Required / Implemented / Passing |
| AV-027 | Trust policy mode enforcement | `apps/api/src/agent-extension-trust.test.ts` | Required / Implemented / Passing |
| AV-028 | Lifecycle inventory includes origin and compatibility | `apps/api/src/agent-extension-endpoints.test.ts` | Required / Implemented / Passing |
| AV-029 | Conformance artifacts are generated at release gate | `scripts/run-agent-conformance.mjs`, `apps/api/src/agent-conformance-artifact.test.ts` | Required / Implemented / Passing |
| AV-030 | Lock-in closure parity remains test-backed | `docs/operations/release-gate-checklist.md` evidence map | Required / Implemented / Passing |

## Required gate commands

```bash
pnpm --filter @repo/api typecheck
pnpm --filter @repo/api test
pnpm --filter @repo/web typecheck
pnpm --filter @repo/web test
pnpm smoke:runtime
node scripts/run-agent-conformance.mjs
```

## Related references

- `docs/operations/release-gate-checklist.md`
- `docs/operations/generation-and-validation.md`
- `docs/implementation-status.md`
