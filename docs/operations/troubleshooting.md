# Operations: Troubleshooting

## Debugging and logs

### Where logs live

The canonical local data/log directory is `DATA_DIR` (default `.data`).

Expected structure:

```txt
.data/
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
