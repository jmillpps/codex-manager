# Operations: Troubleshooting

## Debugging and logs

Queue-worker specific playbooks are documented in:

- `docs/operations/agent-queue-troubleshooting.md`

### Where logs live

The canonical local data/log directory is `DATA_DIR` (default `.data`).

Expected structure:

```txt
.data/
  session-metadata.json
  supplemental-transcript.json
  logs/
    codex.log
```

API logs are emitted to the terminal/stdout in the current scaffold.

### Tail logs

Codex log:

```bash
tail -n 200 -f .data/logs/codex.log
```

### Common failure modes and fixes

#### Web loads but chat actions fail immediately

Symptoms:

- UI renders, but creating a session or sending a message errors instantly.

Checklist:

- Confirm API is running on `http://localhost:3001`
- Confirm web proxy is configured to forward `/api`
- Confirm API health endpoint succeeds
- Check API logs for startup errors

#### API is up but Codex features fail

Symptoms:

- API health passes, but session creation fails (Codex unavailable).

Checklist:

- Confirm `codex` is on PATH or `CODEX_BIN` is set
- Confirm `codex app-server --help` works
- Check `.data/logs/codex.log` for immediate process exit
- Verify `CODEX_HOME` is writable (if set)

#### Streaming stalls mid-response

Symptoms:

- Assistant starts replying, then freezes.

Checklist:

- Inspect API logs for dropped STDIO pipe or JSON parse errors
- Confirm the Codex process is still running
- Restart the API if the Codex process crashed
- Ensure your terminal/OS isn’t buffering STDIO unexpectedly (rare, but possible with wrappers)

#### Approvals appear but cannot be accepted/denied

Symptoms:

- UI displays an approval prompt, but clicking buttons does nothing.

Checklist:

- Ensure WebSocket is connected
- Ensure API is mapping server-initiated requests correctly
- Ensure the backend responds exactly once per approval request `id`
- Inspect logs for “unknown approval id” or “already responded” errors

#### Approval action appears stuck in `Approving...`/`Denying...`

Symptoms:

- Clicking an approval action disables buttons and shows a submitting label, but the row does not resolve.
- This is intermittent and usually appears after websocket instability/reconnect churn.

Checklist:

- Confirm websocket status in the UI is `connected`.
- Verify `/api/stream` is still open in browser devtools (Network -> WS).
- Switch chats and return (forces pending approvals reload for the selected session).
- Click sidebar `Refresh` to force session/approval state resync.
- If still stuck, reload the page to rehydrate state from API and websocket.

Root-cause note:

- Approval decision transitions are websocket-authoritative in the UI: local click enters submitting state, and final pending/resolved state is applied from runtime events. The UI now includes a bounded reconcile fallback (delayed approvals reload) to auto-heal missed `approval_resolved` delivery, but temporary stale submitting labels can still appear briefly during reconnect churn.

#### Chat no longer follows bottom during approval churn

Symptoms:

- During/after approval request or approval decision, transcript view occasionally drifts from tail.
- `Jump to bottom` appears even though the user was reading the tail moments before.

Checklist:

- Confirm the affected chat is active when the approval request arrives.
- Confirm the UI still shows websocket connected.
- Use `Jump to bottom` once; follow mode should re-engage immediately.
- Reproduce while watching scroll distance behavior in devtools if needed:
  - follow-mode hysteresis: disengage around `96px`, re-engage around `24px`.
  - approve-click arming near-bottom threshold: `128px`.
  - snap-back release threshold: `>420px` from bottom (intentional user scroll-away).
- If behavior regresses after edits, verify `Jump to bottom` remains absolute overlay (not inside scroll-content flow), otherwise geometry churn can reintroduce drift.

#### Turns fail with 401 Unauthorized

Symptoms:

- Session creation works, but turns fail quickly.
- UI shows an auth-related error.
- `.data/logs/codex.log` contains `401 Unauthorized` / `Missing bearer or basic authentication`.

Checklist:

- Configure valid OpenAI credentials for the API process environment.
- If using API key auth, set `OPENAI_API_KEY` before starting `pnpm dev`.
- Confirm credentials are visible to the API process (not only your shell profile).
- Restart the API after changing credentials.

#### Suggested request returns 409 `no_context`

Symptoms:

- `POST /api/sessions/:sessionId/suggested-request` returns HTTP `409` with `status: "no_context"`.
- This usually happens for non-materialized chats with no prior turns and no draft text.

Checklist:

- Send the first user message in that chat so transcript context exists.
- Or provide draft text in the suggest-request request payload so fallback suggestion can be returned.
- Confirm the target session id is not deleted (deleted sessions return HTTP `410`).

#### Suggest-request or orchestrator job APIs return 503 `job_conflict`

Symptoms:

- `POST /api/sessions/:sessionId/suggested-request/jobs` returns `503` with `code: "job_conflict"`.
- `GET /api/orchestrator/jobs/:jobId` / `GET /api/projects/:projectId/orchestrator/jobs` / `POST /api/orchestrator/jobs/:jobId/cancel` return `503`.

Checklist:

- Check `GET /api/health` and confirm `orchestratorQueue.enabled`.
- Verify `ORCHESTRATOR_QUEUE_ENABLED=true` in API runtime environment.
- Restart API after env changes.
- If intentionally running degraded mode (`ORCHESTRATOR_QUEUE_ENABLED=false`), treat these responses as expected.

#### Orchestrator queue returns 429 `queue_full`

Symptoms:

- Suggest/enqueue requests fail with `429` and `code: "queue_full"`.

Checklist:

- Inspect queue depth with:
  - `GET /api/health` for global queue counters.
  - `GET /api/projects/:projectId/orchestrator/jobs?state=queued` for per-project backlog.
- Reduce event volume temporarily (for example by pausing bulk-trigger workflows).
- Increase queue caps only after validating memory/throughput headroom:
  - `ORCHESTRATOR_QUEUE_MAX_PER_PROJECT`
  - `ORCHESTRATOR_QUEUE_MAX_GLOBAL`

#### Project delete returns 409 `project_not_empty`

Symptoms:

- `DELETE /api/projects/:projectId` returns HTTP `409` + `status: "project_not_empty"`.

Checklist:

- Move project chats out first (`POST /api/projects/:projectId/chats/move-all` to `unassigned` or `archive`).
- Or delete project chats (`POST /api/projects/:projectId/chats/delete-all`).
- If moving to archive fails with `status: "not_materialized_sessions"`, send a first message in those chats before archiving, or move to `unassigned` instead.

#### Extension reload fails with `reload_failed`

Symptoms:

- `POST /api/agents/extensions/reload` returns `status: "error"` with `code: "reload_failed"`.

Checklist:

- Inspect `errors[]` in reload response for deterministic failure category:
  - `invalid_manifest`
  - `missing_entrypoint`
  - `incompatible_runtime`
  - `missing_register`
  - `registration_failed`
  - `trust_denied`
  - `agent_id_conflict`
- Verify `extension.manifest.json` core/profile compatibility declarations match active runtime values.
- Verify events entrypoint path exists and exports `registerAgentEvents`.
- Check for duplicate `agentId` collisions across loaded modules.
- Confirm trust mode (`AGENT_EXTENSION_TRUST_MODE`) aligns with extension capability declarations.
- Verify prior snapshot remains active by comparing `snapshotVersion` before/after failed reload.

#### Extension lifecycle endpoints return auth errors

Symptoms:

- `GET /api/agents/extensions` or `POST /api/agents/extensions/reload` returns:
  - `403 rbac_disabled_remote_forbidden`
  - `401 missing_header_token`
  - `401 invalid_header_token`
  - `401 missing_role`
  - `400 invalid_role`
  - `401 missing_bearer_token`
  - `401 invalid_bearer_token`
  - `403 invalid_role_claim`
  - `403 insufficient_role`

Checklist:

- Verify `AGENT_EXTENSION_RBAC_MODE` (`disabled`, `header`, or `jwt`).
- In `disabled` mode, lifecycle endpoints are loopback-only. Remote callers receive `403 rbac_disabled_remote_forbidden`.
- In `header` mode, provide `x-codex-role` with one of:
  - `member`, `admin`, `owner`, `system`
- In `header` mode, provide `x-codex-rbac-token` matching `AGENT_EXTENSION_RBAC_HEADER_SECRET` (unless `AGENT_EXTENSION_ALLOW_INSECURE_HEADER_MODE=true`).
- In `jwt` mode:
  - ensure `Authorization: Bearer <token>` is present
  - verify token signature with `AGENT_EXTENSION_RBAC_JWT_SECRET`
  - verify issuer/audience constraints if configured
  - verify role claim key/value (`AGENT_EXTENSION_RBAC_JWT_ROLE_CLAIM`)
- In `header` mode on non-loopback host, set `AGENT_EXTENSION_ALLOW_INSECURE_HEADER_MODE=true` only when a trusted identity proxy is enforcing caller authentication.
- For reload, role must be:
  - `admin`, `owner`, or `system`
- Optionally include `x-codex-actor` for audit identity tracing.

#### Extension actions fail with `undeclared_capability`

Symptoms:

- Event dispatch produces `forbidden` action results with `code: "undeclared_capability"`.

Checklist:

- Check `AGENT_EXTENSION_TRUST_MODE` (especially `enforced` mode).
- Verify extension manifest declares required action capability names under `capabilities.actions[]`.
- Verify declared event capability names under `capabilities.events[]` include subscribed events.
- Inspect `/api/agents/extensions` trust/capability diagnostics for the affected module.

#### Conformance gate fails (`portableExtension: false`)

Symptoms:

- `node scripts/run-agent-conformance.mjs` exits non-zero or reports `portableExtension: false`.

Checklist:

- Inspect `.data/agent-conformance-report.json` profile runs for failing profile and errors.
- Verify fixture extension manifest declares compatibility for both active profiles.
- Verify extension event handler emits expected queue enqueue result in each profile.
- Re-run API tests for profile compatibility coverage:
  - `pnpm --filter @repo/api test`

#### MCP server not available inside Codex

Symptoms:

- Tools expected from MCP servers never appear.

Checklist:

- Verify `.codex/config.toml` or `~/.codex/config.toml` includes the server
- Confirm the project is trusted (for `.codex/config.toml`)
- If STDIO MCP server:
  - confirm command exists and runs standalone
  - confirm required env vars are forwarded
- If HTTP MCP server:
  - confirm URL reachable
  - confirm token environment variables are set
- Reload MCP configuration or restart the API

#### Playwright browser smoke fails to launch

Symptoms:

- Playwright exits immediately with missing shared library errors (for example `libnspr4.so`).
- Direct browser launch fails in environments without root package install.

Checklist:

1. Use repo commands (not direct Playwright invocation):
   - `pnpm test:e2e:list`
   - `pnpm test:e2e`
2. Confirm wrapper bootstrap output:
   - root commands run through `scripts/run-playwright.mjs`
   - on Linux, missing libs are downloaded/extracted into `.data/playwright-libs`
3. If bootstrap still fails:
   - verify `apt-get` and `dpkg-deb` are available on PATH
   - verify outbound apt access is allowed from the environment
4. If environment blocks bootstrap (no apt, no network):
   - run browser smoke in an environment with preinstalled Playwright Linux deps
   - continue using `pnpm smoke:runtime` for API/WebSocket runtime confidence on this machine

---
