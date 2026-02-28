# Operations: Agent Extension Lifecycle and Conformance

## Purpose

This is the one-level lifecycle/conformance guide for extension operations.

It explains source discovery, lifecycle endpoints, governance controls, and release conformance posture.

## Source model summary

Runtime discovers extensions from:

1. repo-local `agents/`
2. `AGENT_EXTENSION_PACKAGE_ROOTS`
3. `AGENT_EXTENSION_CONFIGURED_ROOTS`

Loader precedence is deterministic by source type and path ordering.

## Lifecycle endpoint summary

- `GET /api/agents/extensions`
- `POST /api/agents/extensions/reload`

Reload semantics:

- snapshot-swap on success
- prior snapshot preserved on failure
- concurrent reload guarded

## Governance summary

RBAC controls lifecycle access (`disabled|header|jwt`).

Trust mode controls undeclared capability behavior (`disabled|warn|enforced`).

## Audit and conformance summary

- reload attempts are audit-logged under `.data/`
- portability conformance gate verifies cross-profile extension behavior

## Operational quick commands

```bash
curl -sS http://127.0.0.1:3001/api/agents/extensions
curl -sS -X POST http://127.0.0.1:3001/api/agents/extensions/reload
node scripts/run-agent-conformance.mjs
```

## Read Next (Level 3)

- RBAC/trust policy deep dive: [`agent-extension-lifecycle-rbac-trust.md`](./agent-extension-lifecycle-rbac-trust.md)
- Conformance/audit deep dive: [`agent-extension-conformance-audit.md`](./agent-extension-conformance-audit.md)

## Related references

- Extension authoring: [`agent-extension-authoring.md`](./agent-extension-authoring.md)
- Generation/validation: [`generation-and-validation.md`](./generation-and-validation.md)
- Runtime event contracts: [`../protocol/harness-runtime-events.md`](../protocol/harness-runtime-events.md)
