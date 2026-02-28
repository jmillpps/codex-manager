# Playbook: Discovery, Config, and Integrations Surface

## Purpose

Use this playbook for non-chat operational API surfaces: capabilities, models, apps/skills, MCP, account auth, config APIs, command execution, and feedback upload.

Primary API reference surface: `apps/api/src/index.ts`

## Endpoints Covered

- `GET /api`
- `GET /api/health`
- `GET /api/capabilities`
- `GET /api/features/experimental`
- `GET /api/collaboration/modes`
- `GET /api/models`
- `GET /api/apps`
- `GET /api/skills`
- `POST /api/skills/config`
- `GET /api/skills/remote`
- `POST /api/skills/remote`
- `POST /api/mcp/reload`
- `GET /api/mcp/servers`
- `POST /api/mcp/servers/:serverName/oauth/login`
- `GET /api/account`
- `POST /api/account/login/start`
- `POST /api/account/login/cancel`
- `POST /api/account/logout`
- `GET /api/account/rate-limits`
- `GET /api/config`
- `GET /api/config/requirements`
- `POST /api/config/value`
- `POST /api/config/batch`
- `POST /api/commands/exec`
- `POST /api/feedback`

## Contracts and Semantics

### Service/meta discovery

- `GET /api` -> `{ name, version }`
- `GET /api/health` -> includes:
  - codex process status
  - orchestrator queue stats (`enabled`, counts)
  - auth status
  - timestamp
- `GET /api/capabilities?refresh=true|false`
  - returns method availability map and features

### Enumerations and feature discovery

- `GET /api/features/experimental`
- `GET /api/collaboration/modes`
- `GET /api/models`
- pagination query pattern: `cursor`, `limit`

### Apps and skills

- `GET /api/apps`
  - query: `cursor`, `limit`, `threadId`, `forceRefetch`
- `GET /api/skills`
  - query: `forceReload`, `cwd`
- `POST /api/skills/config`
  - body: `{ path, enabled }`
- `GET /api/skills/remote`
- `POST /api/skills/remote`
  - body: `{ hazelnutId, isPreload }`

### MCP operations

- `POST /api/mcp/reload`
- `GET /api/mcp/servers`
- `POST /api/mcp/servers/:serverName/oauth/login`
  - body: `{ scopes?, timeoutSecs? }`

### Account/auth operations

- `GET /api/account`
- `POST /api/account/login/start`
  - body is discriminated union by `type`:
    - `{ type: "apiKey", apiKey }`
    - `{ type: "chatgpt" }`
    - `{ type: "chatgptAuthTokens", accessToken, chatgptAccountId, chatgptPlanType? }`
- `POST /api/account/login/cancel`
  - `{ loginId }`
- `POST /api/account/logout`
- `GET /api/account/rate-limits`

### Config read/write

- `GET /api/config`
  - query: `cwd?`, `includeLayers=true|false`
- `GET /api/config/requirements`
- `POST /api/config/value`
  - `{ keyPath, mergeStrategy, value, expectedVersion?, filePath? }`
- `POST /api/config/batch`
  - `{ edits: [{ keyPath, mergeStrategy, value }...], expectedVersion?, filePath? }`

### Command and feedback utility routes

- `POST /api/commands/exec`
  - body: `{ command: string[], cwd?, timeoutMs? }`
  - currently uses `sandboxPolicy: null` (inherits runtime/default policy semantics)
- `POST /api/feedback`
  - `{ classification, includeLogs, reason?, threadId? }`

## Error Model Notes

Most integration routes delegate to app-server and use shared RPC error mapping. Expect standardized error payloads for unsupported methods/capability gaps, invalid params, auth-required, timeout, and fallback cases.

## Repro Snippets

```bash
# Capabilities snapshot
curl -sS 'http://127.0.0.1:3001/api/capabilities?refresh=true'

# List models
curl -sS 'http://127.0.0.1:3001/api/models?limit=50'

# Read effective config for cwd
curl -sS 'http://127.0.0.1:3001/api/config?cwd=/path/to/workspace&includeLayers=true'

# Run one command
curl -sS -X POST http://127.0.0.1:3001/api/commands/exec \
  -H 'content-type: application/json' \
  -d '{"command":["bash","-lc","pwd"]}'
```

## Supervisor Notes

- Use this playbook for runtime discovery and integration health checks across capabilities, account, skills, apps, MCP, and config APIs.
- Escalate unexpected capability/regression signals using concrete endpoint evidence and payloads.
