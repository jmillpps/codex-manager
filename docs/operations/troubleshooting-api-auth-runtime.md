# Operations Deep Dive: API, Auth, and Runtime Troubleshooting

## Purpose

Focused troubleshooting playbook for API availability, authentication, runtime supervision, and MCP runtime issues.

Use with [`troubleshooting.md`](./troubleshooting.md).

## API not responding

Checks:

- API process running on expected host/port
- `GET /api/health` response
- API startup logs

## Auth failures (`likelyUnauthenticated` / 401 turns)

Checks:

- `OPENAI_API_KEY` in API process environment
- `CODEX_HOME/auth.json` presence when using Codex auth state
- restart API after env changes

## Runtime supervision failures

Checks:

- `codex` binary availability (`codex app-server --help`)
- `.data/logs/codex.log` for immediate exit/errors
- writable runtime paths (`CODEX_HOME`, `DATA_DIR`)

## MCP tools missing

Checks:

- MCP server entries in config
- project trust state for `.codex/config.toml`
- server command/url reachability
- reload MCP config or restart API

## Suggested-request queue errors

Common statuses:

- `503 job_conflict`
- `429 queue_full`
- `409 no_context`

Checks:

- queue enabled/configured in health
- per-project/global queue backlog
- source session context availability

## Related docs

- Troubleshooting index: [`troubleshooting.md`](./troubleshooting.md)
- Setup and environment: [`setup-and-run.md`](./setup-and-run.md)
- Environment variable catalog: [`environment-reference.md`](./environment-reference.md)
