# Operations: Troubleshooting

## Purpose

This is the one-level troubleshooting index.

Use it for fast triage, then jump to focused deep playbooks by problem area.

## Fast triage first steps

1. check API health (`/api/health`)
2. verify websocket connection state
3. inspect API logs and `.data/logs/codex.log`
4. identify whether issue is API/auth/runtime, web/stream, or queue/extension

## Log and state locations

Runtime artifacts are under `.data/`.

Common files:

- `.data/logs/codex.log`
- `.data/session-metadata.json`
- `.data/supplemental-transcript.json`
- queue state artifacts under `.data/` when enabled

## Problem routing

## API/auth/runtime failures

Use:

- [`troubleshooting-api-auth-runtime.md`](./troubleshooting-api-auth-runtime.md)

## Websocket/UI state failures

Use:

- [`troubleshooting-web-stream-state.md`](./troubleshooting-web-stream-state.md)

## Queue/worker/extension failures

Use:

- [`agent-queue-troubleshooting.md`](./agent-queue-troubleshooting.md)
- [`agent-extension-lifecycle-and-conformance.md`](./agent-extension-lifecycle-and-conformance.md)

## Playwright/e2e environment issues

Use repo wrapper commands:

- `pnpm test:e2e:list`
- `pnpm test:e2e`

If browser dependencies are missing, rely on runtime smoke while resolving environment constraints.

## Related runbooks

- Setup and run baseline: [`setup-and-run.md`](./setup-and-run.md)
- CLI workflows: [`cli.md`](./cli.md)
- Queue runtime semantics: [`agent-queue-runtime-semantics.md`](./agent-queue-runtime-semantics.md)
- Implementation status: [`../implementation-status.md`](../implementation-status.md)
