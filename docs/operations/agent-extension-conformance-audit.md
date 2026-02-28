# Operations Deep Dive: Extension Conformance and Audit

## Purpose

Detailed reference for extension reload audit behavior and portability conformance gates.

Use with [`agent-extension-lifecycle-and-conformance.md`](./agent-extension-lifecycle-and-conformance.md).

## Reload audit

Audit artifact:

- `.data/agent-extension-audit.json`

Expected record traits:

- reload id/time
- actor role/id
- request origin metadata
- result (`success|failed|forbidden`)
- snapshot before/after metadata
- failure summary where applicable

## Conformance gate

Command:

```bash
node scripts/run-agent-conformance.mjs
```

Output artifact:

- `.data/agent-conformance-report.json`

Expected release posture:

- multiple runtime profiles exercised
- portable extension fixture passes across required profiles
- report indicates portability success

## Operational cadence

For extension-platform changes:

1. run API/web tests and runtime smoke
2. run conformance harness
3. verify audit/logging behavior on lifecycle mutations
4. update docs when lifecycle/trust behavior changes

## Related docs

- Lifecycle runbook: [`agent-extension-lifecycle-and-conformance.md`](./agent-extension-lifecycle-and-conformance.md)
- Release gate checklist: [`release-gate-checklist.md`](./release-gate-checklist.md)
- Verification matrix: [`agent-platform-verification-matrix.md`](./agent-platform-verification-matrix.md)
