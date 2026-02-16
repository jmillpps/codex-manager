# Codex App Server Methods: Integrations and Configuration

### One-off command execution

#### `command/exec`

Purpose: run a single command (argv array) under the server sandbox without creating a thread or turn.

Params:

- `command: string[]` (MUST be non-empty)
- `cwd?: string` (defaults to server cwd)
- `sandboxPolicy?: SandboxPolicy` (defaults to user config)
- `timeoutMs?: number` (defaults to server timeout)

Response:

- `{ exitCode: number, stdout: string, stderr: string }`

External sandbox mode:

- Use `sandboxPolicy.type = "externalSandbox"` when the server process is already sandboxed externally.
- In external sandbox mode, `networkAccess` is `"restricted"` or `"enabled"`.

### Models and feature discovery

#### `model/list`

Purpose: discover available models and their capabilities.

Params:

- `limit?: number`
- Optional fields per schema (including `includeHidden`)

Response:

- `{ data: ModelEntry[], nextCursor: string | null }`

Model entries can include:

- `reasoningEffort` options
- `defaultReasoningEffort`
- `upgrade` model id
- `inputModalities` (if missing, treat as `["text","image"]` for backward compatibility)
- `supportsPersonality`
- `isDefault`

#### `experimentalFeature/list`

Purpose: list feature flags with lifecycle stage metadata.

Response includes:

- stage metadata (`beta`, `underDevelopment`, `stable`, etc.)
- enabled/default-enabled state
- cursor pagination

### Collaboration modes (experimental)

#### `collaborationMode/list`

Purpose: list collaboration mode presets.

Notes:

- Experimental.
- No pagination.

Response shape is schema-defined.

### Skills

#### `skills/list`

Purpose: list available skills for one or more working directories.

Params:

- `cwds?: string[]`
- `forceReload?: boolean`
- `perCwdExtraUserRoots?: Array<{ cwd: string, extraUserRoots: string[] }>`

Semantics:

- The server may cache skill discovery per cwd; `forceReload: true` refreshes from disk.
- `perCwdExtraUserRoots` only applies to entries whose `cwd` appears in `cwds`.

Response:

- `{ data: Array<{ cwd: string, skills: Skill[], errors: any[] }> }`

Skill entries commonly include:

- `name`, `description`, `enabled`
- `interface` (UI metadata), such as:
  - `displayName`
  - `shortDescription`
  - icons
  - `brandColor`
  - `defaultPrompt`

#### `skills/config/write`

Purpose: enable or disable a skill by path.

Params:

- `path: string` (absolute path to `SKILL.md`)
- `enabled: boolean`

Response shape is schema-defined.

#### `skills/remote/read` (under development)

Purpose: list public remote skills.

Status:

- Under development; do not call from production clients.

#### `skills/remote/write` (under development)

Purpose: download a public remote skill by `hazelnutId`.

Status:

- Under development; do not call from production clients.

### Apps (connectors)

#### `app/list`

Purpose: list available apps/connectors.

Params:

- `cursor?: string | null`
- `limit?: number`
- `threadId?: string` (when present, gating evaluated using that thread’s config snapshot)
- `forceRefetch?: boolean`

Response:

- `{ data: AppEntry[], nextCursor: string | null }`

App entries commonly include:

- `id`, `name`, `description`
- `logoUrl`, `logoUrlDark`
- `distributionChannel`
- `installUrl`
- `isAccessible`, `isEnabled`

Additional behaviors:

- The server emits `app/list/updated` notifications whenever app sources finish loading, each including the latest merged app list.

#### Invoking an app from a turn

To invoke an app in the user input:

- Include `$<app-slug>` in the text input.
- The slug is derived from the app name by lowercasing and replacing non-alphanumeric characters with `-`.

Recommended:

- Add a `mention` input item so the server uses the exact `app://` path instead of guessing by name:
  - `{ "type": "mention", "name": "<App Name>", "path": "app://<app-id>" }`

### MCP management (Codex ↔ MCP servers)

#### `mcpServerStatus/list`

Purpose: enumerate configured MCP servers and their status.

Semantics:

- Cursor + limit pagination.
- Returns servers with tools, resources, resource templates, and auth status.

Response shape is schema-defined.

#### `config/mcpServer/reload`

Purpose: reload MCP server configuration from disk and queue refresh for loaded threads.

Semantics:

- Applied on each thread’s next active turn.
- Useful after editing `config.toml` without restarting the server.

Response:

- `{}`

#### `mcpServer/oauth/login`

Purpose: start an OAuth login for a configured MCP server.

Semantics:

- Returns an authorization URL.
- Emits `mcpServer/oauthLogin/completed` when the OAuth flow finishes.

Response/notification payload shapes are schema-defined.

### Client prompting (experimental)

#### `tool/requestUserInput`

Purpose: prompt the user with 1–3 short questions for a tool call and return their answers.

Notes:

- Experimental.
- Used in some approval-like flows for MCP/app tool calls with side effects.
- Questions can set `isOther` for a free-form option.

This is a bidirectional request pattern; exact params/result shape is schema-defined.

### Configuration management

#### `config/read`

Purpose: fetch the effective configuration after resolving layered config precedence on disk.

Response shape: schema-defined.

#### `config/value/write`

Purpose: write a single configuration key/value to the user’s `config.toml` on disk.

Response shape: schema-defined.

#### `config/batchWrite`

Purpose: apply multiple configuration edits atomically to the user’s `config.toml` on disk.

Response shape: schema-defined.

#### `configRequirements/read`

Purpose: fetch loaded requirements constraints from `requirements.toml` and/or MDM.

Semantics:

- Returns requirements constraints including allow-lists and network/residency constraints.
- Returns `null` if no requirements are configured.

Response shape: schema-defined (includes items like `allowedApprovalPolicies`, `allowedSandboxModes`, `allowedWebSearchModes`, `enforceResidency`, and network constraints).

### Feedback

#### `feedback/upload`

Purpose: submit a feedback report.

Semantics:

- Includes classification + optional reason/logs + conversation/thread id.
- Returns a tracking thread id.

Payload shapes: schema-defined.

### Account and authentication

#### `account/read`

Purpose: check current auth state.

Params:

- `refreshToken?: boolean` (true forces refresh)

Response:

- `{ account: null | {…}, requiresOpenaiAuth: boolean }`

`requiresOpenaiAuth` reflects whether the active provider requires OpenAI credentials.

#### `account/login/start`

Purpose: start a login flow.

Modes:

- API key login:
  - params: `{ type: "apiKey", apiKey: "sk-…" }`
  - response: `{ type: "apiKey" }`
  - notifications:
    - `account/login/completed` (success true/false)
    - `account/updated` (authMode updates)

- ChatGPT login (browser flow):
  - params: `{ type: "chatgpt" }`
  - response includes `loginId` and `authUrl`
  - client opens `authUrl` in a browser
  - server hosts the local callback
  - notifications:
    - `account/login/completed`
    - `account/updated`

#### `account/login/cancel`

Purpose: cancel an in-progress ChatGPT login.

Params:

- `loginId: string`

Emits:

- `account/login/completed` with success false and an error string.

#### `account/logout`

Purpose: logout.

Response:

- `{}`

Emits:

- `account/updated` with `authMode: null`

#### `account/rateLimits/read`

Purpose: read rate limits (notably for ChatGPT auth mode).

Response:

- `{ rateLimits: { primary: { usedPercent, windowDurationMins, resetsAt }, secondary: … } }`

Emits:

- `account/rateLimits/updated`
