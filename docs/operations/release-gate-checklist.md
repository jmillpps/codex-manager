# Operations: Agent Platform Release Gate Checklist

## Purpose

Release gate checklist for runtime/extension platform quality and doc-code parity.

Use this after generation/validation passes and before release or merge-to-main promotion.

## Required command gate

```bash
pnpm --filter @repo/api typecheck
pnpm --filter @repo/api test
pnpm --filter @repo/web typecheck
pnpm --filter @repo/web test
pnpm smoke:runtime
node scripts/run-agent-conformance.mjs
```

## Contract/doc parity gate

Verify all are true:

1. lifecycle/trust docs match runtime endpoint behavior
2. runtime event and queue contracts match current dispatch behavior
3. conformance artifact reflects current portability status
4. setup/env docs cover active runtime knobs
5. implementation status snapshot matches actual behavior

## Lock-in evidence categories

- runtime profile adapter boundary
- deterministic dispatch and reconciliation
- extension discovery/lifecycle/reload behavior
- trust and capability enforcement
- portability conformance gate output
- governance/parity guardrails

## Blocking rule

If any gate or parity check fails, release is blocked.

## Related references

- Generation and validation runbook: [`generation-and-validation.md`](./generation-and-validation.md)
- Validation gate playbook: [`validation-gate-playbook.md`](./validation-gate-playbook.md)
- Verification matrix: [`agent-platform-verification-matrix.md`](./agent-platform-verification-matrix.md)
- Lifecycle controls: [`agent-extension-lifecycle-and-conformance.md`](./agent-extension-lifecycle-and-conformance.md)
- Implementation snapshot: [`../implementation-status.md`](../implementation-status.md)
