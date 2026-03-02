# Operations Deep Dive: CLI Workflow Playbooks

## Purpose

Copy/paste CLI workflows for high-value operator tasks.

Use with [`cli.md`](./cli.md) for practical troubleshooting and run operations.

## Health and startup check

```bash
pnpm --filter @repo/cli dev system health
```

## Session lifecycle loop

```bash
pnpm --filter @repo/cli dev sessions create --title "CLI test"
pnpm --filter @repo/cli dev sessions send --session-id <sessionId> --text "Summarize this project."
pnpm --filter @repo/cli dev sessions get --session-id <sessionId>
```

## Turn and suggestion control loop

```bash
pnpm --filter @repo/cli dev sessions interrupt --session-id <sessionId>
pnpm --filter @repo/cli dev sessions approval-policy set --session-id <sessionId> --approval-policy on-request
pnpm --filter @repo/cli dev sessions suggest-request run --session-id <sessionId>
pnpm --filter @repo/cli dev sessions suggest-request enqueue --session-id <sessionId>
```

## Session controls and settings loop

```bash
pnpm --filter @repo/cli dev sessions controls get --session-id <sessionId>
pnpm --filter @repo/cli dev sessions controls apply --session-id <sessionId> --scope session --approval-policy on-request --network-access restricted --filesystem-sandbox workspace-write --inherit-model
pnpm --filter @repo/cli dev sessions settings set --session-id <sessionId> --scope session --key supervisor --value '{"diffExplainability":true}'
pnpm --filter @repo/cli dev sessions settings get --session-id <sessionId> --scope session --key supervisor
pnpm --filter @repo/cli dev sessions settings unset --session-id <sessionId> --scope session --key supervisor
```

## Queue and worker diagnosis

```bash
pnpm --filter @repo/cli dev sessions list --include-system-owned true
pnpm --filter @repo/cli dev orchestrator jobs list --project-id <projectId> --state running --limit 50
pnpm --filter @repo/cli dev orchestrator jobs get --job-id <jobId>
pnpm --filter @repo/cli dev projects agent-sessions list --project-id <projectId>
```

## Decision workflows

Approvals:

```bash
pnpm --filter @repo/cli dev sessions approvals list --session-id <sessionId>
pnpm --filter @repo/cli dev approvals decide --approval-id <approvalId> --decision approve
```

Tool input:

```bash
pnpm --filter @repo/cli dev sessions tool-input list --session-id <sessionId>
pnpm --filter @repo/cli dev tool-input decide --request-id <requestId> --decision decline
```

Tool calls:

```bash
pnpm --filter @repo/cli dev sessions tool-calls list --session-id <sessionId>
pnpm --filter @repo/cli dev tool-calls respond --request-id <requestId> --text "done" --success true
```

## Stream inspection

```bash
pnpm --filter @repo/cli dev stream events --session-id <sessionId>
```

## Raw fallback

```bash
pnpm --filter @repo/cli dev api request --method POST --path /api/sessions/<id>/interrupt --allow-status 200,403,409,410
```

## Related docs

- CLI runbook: [`cli.md`](./cli.md)
- CLI command reference: [`cli-command-reference.md`](./cli-command-reference.md)
- Troubleshooting runbook: [`troubleshooting.md`](./troubleshooting.md)
