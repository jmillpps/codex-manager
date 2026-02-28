# Operations Manual Index

## Purpose

This is the operations entrypoint for L1->L2->L3 progression.

- L1: this index
- L2: foundational runbooks
- L3: focused deep references and playbooks

## L2 Foundations

- Setup and run: [`operations/setup-and-run.md`](./operations/setup-and-run.md)
- Environment reference: [`operations/environment-reference.md`](./operations/environment-reference.md)
- CLI runbook: [`operations/cli.md`](./operations/cli.md)
- Troubleshooting index: [`operations/troubleshooting.md`](./operations/troubleshooting.md)
- Generation/validation runbook: [`operations/generation-and-validation.md`](./operations/generation-and-validation.md)
- Release gate checklist: [`operations/release-gate-checklist.md`](./operations/release-gate-checklist.md)
- API always-on supervision: [`operations/api-service-supervision.md`](./operations/api-service-supervision.md)
- Extension authoring: [`operations/agent-extension-authoring.md`](./operations/agent-extension-authoring.md)
- Extension lifecycle/conformance: [`operations/agent-extension-lifecycle-and-conformance.md`](./operations/agent-extension-lifecycle-and-conformance.md)
- Queue framework: [`operations/agent-queue-framework.md`](./operations/agent-queue-framework.md)
- Queue troubleshooting: [`operations/agent-queue-troubleshooting.md`](./operations/agent-queue-troubleshooting.md)
- Queue-runner guide: [`queue-runner.md`](./queue-runner.md)
- Maintenance: [`operations/maintenance.md`](./operations/maintenance.md)

## L3 Deep References

CLI:

- [`operations/cli-command-reference.md`](./operations/cli-command-reference.md)
- [`operations/cli-workflow-playbooks.md`](./operations/cli-workflow-playbooks.md)

Validation:

- [`operations/generation-command-reference.md`](./operations/generation-command-reference.md)
- [`operations/validation-gate-playbook.md`](./operations/validation-gate-playbook.md)

Troubleshooting:

- [`operations/troubleshooting-api-auth-runtime.md`](./operations/troubleshooting-api-auth-runtime.md)
- [`operations/troubleshooting-web-stream-state.md`](./operations/troubleshooting-web-stream-state.md)

Extensions:

- [`operations/agent-extension-authoring-manifest-events.md`](./operations/agent-extension-authoring-manifest-events.md)
- [`operations/agent-extension-authoring-worker-jobs.md`](./operations/agent-extension-authoring-worker-jobs.md)
- [`operations/agent-extension-lifecycle-rbac-trust.md`](./operations/agent-extension-lifecycle-rbac-trust.md)
- [`operations/agent-extension-conformance-audit.md`](./operations/agent-extension-conformance-audit.md)

Queue:

- [`operations/agent-queue-event-and-job-contracts.md`](./operations/agent-queue-event-and-job-contracts.md)
- [`operations/agent-queue-runtime-semantics.md`](./operations/agent-queue-runtime-semantics.md)
- [`queue-runner-capability-reference.md`](./queue-runner-capability-reference.md)

## Fast Path Commands

- `pnpm dev`
- `pnpm gen`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm smoke:runtime`
- `node scripts/run-agent-conformance.mjs`

## Related docs

- Product scope: [`prd.md`](./prd.md)
- Architecture: [`architecture.md`](./architecture.md)
- Protocol index: [`codex-app-server.md`](./codex-app-server.md)
- Implementation snapshot: [`implementation-status.md`](./implementation-status.md)
