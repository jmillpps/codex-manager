# Operations: Environment Reference

## Purpose

This is the deeper environment catalog for Codex Manager operators.

Use it when `setup-and-run.md` is not enough and you need exact variable behavior, defaults, and tuning guidance for API supervision, queue runtime, and extension governance.

## Scope

This reference covers variables read by the API process (`apps/api`) and its supervised runtime behavior.

For web env variables, see `apps/web/.env.example` and keep browser-exposed values limited to `VITE_*` keys.

## Baseline API Runtime Variables

From `apps/api/.env.example`:

- `HOST` (default `127.0.0.1`)
- `PORT` (default `3001`)
- `LOG_LEVEL` (default `info`)
- `DATA_DIR` (default `.data`)

Operational guidance:

- Keep `HOST` loopback by default for local-first posture.
- Keep runtime artifacts under `.data/` (or another ignored runtime path).

## Codex Supervision Variables

- `CODEX_BIN`
  - Binary path/name for launching app-server (default uses `codex` on `PATH`).
- `CODEX_HOME`
  - Codex home directory used by supervised runtime.
  - Repo-local value (for example `.data/codex-home`) keeps local dev deterministic.
- `OPENAI_API_KEY`
  - API-key auth path when Codex auth state is not already present in `CODEX_HOME`/default home.

Health/auth signal:

- `GET /api/health` exposes `auth.hasOpenAiApiKey`, `auth.codexHomeAuthFile`, and `auth.likelyUnauthenticated`.

## Default Session Policy Variables

Baseline session defaults applied on thread lifecycle calls:

- `DEFAULT_APPROVAL_POLICY`
  - `untrusted | on-failure | on-request | never`
- `DEFAULT_SANDBOX_MODE`
  - `read-only | workspace-write | danger-full-access`
- `DEFAULT_NETWORK_ACCESS`
  - `restricted | enabled`
- `SESSION_DEFAULTS_LOCKED`
  - `true|false`
  - when `true`, default scope is harness-controlled and read-only from UI default-edit flows.

## Queue Runtime Controls

Queue enablement and capacity:

- `ORCHESTRATOR_QUEUE_ENABLED`
- `ORCHESTRATOR_QUEUE_GLOBAL_CONCURRENCY`
- `ORCHESTRATOR_QUEUE_MAX_PER_PROJECT`
- `ORCHESTRATOR_QUEUE_MAX_GLOBAL`

Retry/timeout controls:

- `ORCHESTRATOR_QUEUE_MAX_ATTEMPTS`
- `ORCHESTRATOR_QUEUE_DEFAULT_TIMEOUT_MS`
- `ORCHESTRATOR_QUEUE_BACKGROUND_AGING_MS`
- `ORCHESTRATOR_QUEUE_MAX_INTERACTIVE_BURST`

Suggest-request controls:

- `ORCHESTRATOR_SUGGEST_REQUEST_ENABLED`
- `ORCHESTRATOR_SUGGEST_REQUEST_WAIT_MS`

Worker turn settlement controls:

- `ORCHESTRATOR_AGENT_TURN_TIMEOUT_MS`
- `ORCHESTRATOR_AGENT_POLL_INTERVAL_MS`
- `ORCHESTRATOR_AGENT_INCLUDE_TURNS_GRACE_MS`
- `ORCHESTRATOR_AGENT_UNTRUSTED_TERMINAL_GRACE_MS`
- `ORCHESTRATOR_AGENT_EMPTY_TURN_GRACE_MS`

Practical guidance:

- Increase capacity only after validating memory/latency headroom.
- Keep timeout/grace values balanced to avoid both premature failures and multi-minute phantom stalls.
- Validate changes with `pnpm smoke:runtime` plus queue-focused scenarios.

## Extension Lifecycle Governance Variables

RBAC mode and credentials:

- `AGENT_EXTENSION_RBAC_MODE=disabled|header|jwt`
- `AGENT_EXTENSION_RBAC_HEADER_SECRET`
- `AGENT_EXTENSION_ALLOW_INSECURE_HEADER_MODE=true|false`
- `AGENT_EXTENSION_RBAC_JWT_SECRET`
- `AGENT_EXTENSION_RBAC_JWT_ISSUER`
- `AGENT_EXTENSION_RBAC_JWT_AUDIENCE`
- `AGENT_EXTENSION_RBAC_JWT_ROLE_CLAIM`
- `AGENT_EXTENSION_RBAC_JWT_ACTOR_CLAIM`

Trust mode:

- `AGENT_EXTENSION_TRUST_MODE=disabled|warn|enforced`

Extension roots:

- `AGENT_EXTENSION_PACKAGE_ROOTS`
- `AGENT_EXTENSION_CONFIGURED_ROOTS`

Guidance:

- For local dev, `disabled` RBAC + loopback host is acceptable.
- For shared operator environments, use `jwt` or secured `header` mode.
- Use `enforced` trust mode only when capability declarations are complete.

## Common Profiles

Local guarded profile (recommended default):

- approval: `untrusted`
- sandbox: `read-only`
- network: `restricted`
- queue enabled, moderate concurrency.

Automation-heavy local profile:

- approval: `never` for dedicated automation sessions only.
- sandbox/network relaxed for trusted runs.
- explicit extension trust/RBAC controls enabled.

## Change Management Rules

When changing env-driven behavior:

1. Update the relevant operations doc in the same commit.
2. Re-run type/test/smoke/conformance commands.
3. Verify `GET /api/health` and queue/extension endpoints reflect expected state.

## Related docs

- Setup and first run: [`setup-and-run.md`](./setup-and-run.md)
- Queue runtime deep dive: [`agent-queue-runtime-semantics.md`](./agent-queue-runtime-semantics.md)
- Queue event/payload contracts: [`agent-queue-event-and-job-contracts.md`](./agent-queue-event-and-job-contracts.md)
- Extension lifecycle governance: [`agent-extension-lifecycle-and-conformance.md`](./agent-extension-lifecycle-and-conformance.md)
- Troubleshooting: [`troubleshooting.md`](./troubleshooting.md)
