# codex-mcp.md

## Purpose and scope

This document is the **complete surface reference** for the **Codex App Server** (`codex app-server`) and the bidirectional JSON-RPC protocol it speaks.

It is intentionally written as:

- A **protocol + API surface** reference (methods, notifications, request/response shapes, flows, and semantics).
- A **client-facing behavior** reference (what a rich UI must be prepared to render and how interactions progress).

This document **does not** discuss how to wire this into any particular application architecture. It only defines **what Codex exposes** and **how to interact with it** over the app-server protocol.

If anything here conflicts with the **generated schema for your installed Codex version**, the schema is authoritative.

## Mental model

Codex App Server exposes three primary primitives:

- **Thread**: a single conversation session.
- **Turn**: one user → agent exchange within a thread.
- **Item**: the atomic units of user input, agent output, tool activity, and side effects inside a turn (messages, plans, diffs, commands, MCP calls, etc.).

A rich client behaves like this:

- Start or resume a **thread**.
- Start a **turn** with user input.
- Render live progress from **notifications** (`turn/*`, `item/*`, delta streams).
- Handle **server-initiated requests** (approvals, dynamic tool calls, user prompts).
- Finish at `turn/completed`, with final authoritative items arriving via `item/completed`.

## Compatibility and the canonical schema

The app-server protocol is versioned implicitly by the Codex build you are running.

You MUST treat the following as canonical for your version:

- `codex app-server generate-ts --out <DIR>`
- `codex app-server generate-json-schema --out <DIR>`

These generated artifacts are guaranteed to match the exact server behavior for that Codex version.

If you opt into experimental APIs, you MUST generate schemas using `--experimental` as well (see “Experimental API opt-in”).

## Transports and framing

### Supported transports

`codex app-server` supports:

- **STDIO transport (default)**  
  Newline-delimited JSON (JSONL): **exactly one JSON object per line**.

- **WebSocket transport (experimental / unsupported)**  
  One JSON-RPC message per WebSocket text frame. Do not depend on this for production.

### Framing requirements

For STDIO:

- Client → server: write one JSON object followed by `\n`.
- Server → client: read line by line; each line is one complete JSON message.
- Messages may arrive in any order consistent with JSON-RPC semantics (responses can be interleaved with notifications).

### Backpressure and overload behavior

The server uses bounded queues between:

- transport ingress,
- request processing,
- outbound writes.

If request ingress is saturated:

- the server rejects new requests with JSON-RPC error code **`-32001`**
- message: **`"Server overloaded; retry later."`**

Clients MUST treat this as retryable and SHOULD use exponential backoff with jitter.

## JSON-RPC message model

The app-server protocol is **JSON-RPC 2.0** in behavior but omits the `"jsonrpc":"2.0"` header on the wire.

### Request (client → server, or server → client)

A request MUST include:

- `method` (string)
- `id` (string or number; MUST be unique among in-flight requests on that connection)
- `params` (object; may be omitted when method defines no params)

Example:

```json
{ "method": "thread/start", "id": 10, "params": { "cwd": "/Users/me/project" } }
```

### Response (to a request)

A response MUST include:

- `id` (matching the request)
- either `result` or `error`

Example:

```json
{ "id": 10, "result": { "thread": { "id": "thr_123" } } }
```

### Notification (one-way message)

A notification MUST include:

- `method`
- `params` (object; may be omitted)

Notifications have **no `id`** and do not receive responses.

Example:

```json
{ "method": "turn/started", "params": { "turn": { "id": "turn_456" } } }
```

## Connection lifecycle and initialization handshake

Each transport connection MUST perform an initialization handshake exactly once.

### Required handshake sequence

- Client sends `initialize` request with `clientInfo` (and optional `capabilities`)
- Server responds to `initialize`
- Client sends `initialized` notification
- Only after `initialized` may other methods be invoked successfully

If the client calls any other method before the handshake completes, it will be rejected with a “Not initialized” error.

If the client calls `initialize` more than once on the same connection, it will be rejected with an “Already initialized” error.

### Client identity requirements

The client MUST identify itself via `initialize.params.clientInfo`.

Important operational note:

- `clientInfo.name` is used to identify the client for compliance logging. Use a stable identifier string for your client.

### Notification opt-out

At initialization time, clients may suppress specific notifications for that connection by providing:

- `initialize.params.capabilities.optOutNotificationMethods: string[]`

Rules:

- Exact match only (no prefix/wildcards)
- Unknown method names are accepted and ignored
- Applies to both legacy (`codex/event/*`) and v2 notifications (`thread/*`, `turn/*`, `item/*`, etc.)

Example:

```json
{
  "method": "initialize",
  "id": 1,
  "params": {
    "clientInfo": { "name": "my_client", "title": "My Client", "version": "0.1.0" },
    "capabilities": {
      "experimentalApi": true,
      "optOutNotificationMethods": [
        "codex/event/session_configured",
        "item/agentMessage/delta"
      ]
    }
  }
}
```

## Experimental API opt-in

Some methods and fields are intentionally gated behind an experimental capability.

There are two separate but related controls:

- **Runtime opt-in**: `initialize.params.capabilities.experimentalApi = true`
- **Schema generation opt-in**: `codex app-server generate-ts|generate-json-schema --experimental`

### Runtime opt-in

If a client uses an experimental method or experimental field without opting in, the server rejects it with an error containing:

- `requires experimentalApi capability`

### Schema generation for experimental APIs

Stable-only output (default):

```bash
codex app-server generate-ts --out DIR
codex app-server generate-json-schema --out DIR
```

Include experimental surface:

```bash
codex app-server generate-ts --out DIR --experimental
codex app-server generate-json-schema --out DIR --experimental
```

## Core primitives

### Thread

A Thread represents a conversation session. It is persisted as a rollout (a JSONL log on disk).

Key behaviors:

- Threads can be created, resumed, forked, listed, read, archived/unarchived, compacted, and rolled back.
- As verified from generated stable and `--experimental` schemas on **February 15, 2026** (`codex-cli 0.101.0`), there is **no native `thread/delete` JSON-RPC method**.
- `thread/start` emits `thread/started` and auto-subscribes the connection to that thread’s streaming events.
- `thread/fork` creates a new thread id with copied history and emits `thread/started` for the new thread.
- `thread/resume` reopens a stored thread without creating a new id.

### Turn

A Turn represents one user submission and Codex’s work to respond.

Key behaviors:

- Turns stream via notifications:
  - `turn/started`
  - `item/*` (including deltas)
  - `turn/completed`
- A thread can have at most one in-flight (active) turn.
- `turn/steer` appends user input to an in-flight turn.
- `turn/interrupt` requests cancellation of an in-flight turn.

### Item

Items represent user and agent messages, plans, reasoning, commands, file changes, MCP tool calls, review markers, and more.

Items have a shared lifecycle:

- `item/started` emits the full initial item.
- `item/completed` emits the final authoritative item.
- Certain item types also stream incremental deltas.

Clients MUST treat `item/completed` as authoritative state for an item.

## Method surface reference

### Initialization

#### `initialize`

Purpose: handshake and capability negotiation.

Request:

- `params.clientInfo`: `{ name, title, version }`
- `params.capabilities` (optional):
  - `experimentalApi?: boolean`
  - `optOutNotificationMethods?: string[]`

Response:

- includes server metadata (including a user-agent string presented upstream); exact shape is schema-defined.

#### `initialized` (notification)

Purpose: completes the handshake. No response.

### Threads

#### `thread/start`

Purpose: create a new thread/session.

Semantics:

- Returns the created thread object.
- Emits `thread/started`.
- Auto-subscribes this connection to turn/item events for the thread.

Common params (stable surface; consult schema for full shape):

- `model?: string`
- `cwd?: string`
- `approvalPolicy?: string`
- `sandbox?: string`
- `personality?: "friendly" | "pragmatic" | "none"`

Experimental params (require `experimentalApi`):

- `dynamicTools?: DynamicTool[]`
- `persistExtendedHistory?: true`

`dynamicTools` defines client-implemented tools the agent can call (see “Dynamic tool calls”).

#### `thread/resume`

Purpose: reopen an existing thread so later turns append to it.

Semantics:

- Response shape matches `thread/start`.
- Does not emit additional notifications.

Params:

- `threadId: string`
- May include the same configuration overrides supported by `thread/start`.

#### `thread/fork`

Purpose: create a new thread id by copying history from an existing thread.

Semantics:

- Returns a new thread object.
- Emits `thread/started` for the new thread.

Params:

- `threadId: string`

#### `thread/list`

Purpose: list stored threads (for a session picker/history UI).

Semantics:

- Cursor-based pagination.
- Default sort: `createdAt` newest-first descending.

Params (common):

- `cursor?: string | null`
- `limit?: number`
- `sortKey?: "created_at" | "updated_at"`
- `modelProviders?: string[] | null`
- `sourceKinds?: string[]` (omit or `[]` for interactive sessions only, such as CLI/VS Code)
- `archived?: boolean | null` (true: archived only; false/null: non-archived)
- `cwd?: string` (exact match)

Response:

- `{ data: ThreadSummary[], nextCursor: string | null }`

#### `thread/loaded/list`

Purpose: list thread ids currently loaded in memory.

Response:

- `{ data: string[] }`

#### `thread/read`

Purpose: read a stored thread without resuming it.

Params:

- `threadId: string`
- `includeTurns?: boolean` (when true, populates `thread.turns`)

Response:

- `{ thread: Thread }`

#### `thread/archive`

Purpose: move a thread’s rollout file into the archived directory.

Params:

- `threadId: string`

Response:

- `{}`

Behavior:

- Archived threads do not appear in `thread/list` unless `archived: true` is used.

#### `thread/unarchive`

Purpose: restore an archived thread back into the sessions directory.

Params:

- `threadId: string`

Response:

- `{ thread: Thread }`

#### Hard-delete note

The app-server protocol does not currently expose a thread hard-delete primitive (`thread/delete` is not present in the verified method surface above). Integrations that require irreversible deletion must implement it as a product-level extension outside the native app-server contract (for example, controlled rollout/artifact purge at the harness layer).

#### `thread/name/set`

Purpose: set or update the thread’s user-facing name.

Semantics:

- Names are not required to be unique.
- Name lookups resolve to the most recently updated thread.

Params/response: schema-defined.

#### `thread/compact/start`

Purpose: trigger manual history compaction for a thread.

Request returns immediately:

- `{}`

Progress:

- streamed via standard `turn/*` and `item/*` notifications on the same thread.
- Clients should expect a compaction item lifecycle:
  - `item/started` with `type: "contextCompaction"`
  - `item/completed` with the same item id

#### `thread/rollback`

Purpose: drop the last N turns from the agent’s in-memory context and persist a rollback marker so future resumes see the pruned history.

Params/response: schema-defined; response includes updated `thread` (with turns populated).

#### `thread/backgroundTerminals/clean` (experimental)

Purpose: terminate all running background terminals associated with a thread.

Requires:

- `initialize.capabilities.experimentalApi = true`

Response:

- `{}`

### Turns

#### Turn input item types (for `turn/start` and `turn/steer`)

The `input` field is a list of discriminated unions.

Common inputs:

- Text:
  - `{ "type": "text", "text": "Run tests" }`
- Remote image:
  - `{ "type": "image", "url": "https://…/design.png" }`
- Local image path:
  - `{ "type": "localImage", "path": "/tmp/screenshot.png" }`

Invoking a skill or app:

- Skill (recommended companion item):
  - `{ "type": "skill", "name": "<skill-name>", "path": "/abs/path/to/SKILL.md" }`
- App mention (recommended companion item):
  - `{ "type": "mention", "name": "<App Name>", "path": "app://<app-id>" }`

#### Turn-level overrides

`turn/start` supports turn overrides that, when specified, become defaults for subsequent turns on the same thread:

- `model`
- `effort`
- `summary`
- `personality`
- `cwd`
- `sandboxPolicy`
- `approvalPolicy`

`outputSchema` applies only to the current turn.

Sandbox policy notes:

- If `sandboxPolicy.type = "externalSandbox"`, `networkAccess` MUST be `"restricted"` or `"enabled"`.
- Otherwise, `networkAccess` is typically boolean.

Collaboration mode note:

- For `turn/start.collaborationMode`, `settings.developer_instructions: null` means “use built-in instructions for the selected mode” rather than clearing.

#### `turn/start`

Purpose: append user input to a thread and begin Codex generation.

Params:

- `threadId: string`
- `input: InputItem[]`
- Optional: overrides described above

Response:

- `{ turn: { id, status: "inProgress", items: [], error: null } }`

Streaming:

- emits `turn/started`
- streams `item/started`, deltas, and `item/completed`
- finishes with `turn/completed`

#### `turn/steer`

Purpose: append additional user input to the currently active in-flight turn.

Rules:

- MUST include `expectedTurnId` matching the active in-flight turn id.
- Fails if there is no active turn.
- Does not emit a new `turn/started`.
- Does not accept turn-level overrides (`model`, `cwd`, `sandboxPolicy`, `outputSchema`, etc.).

Params:

- `threadId: string`
- `expectedTurnId: string`
- `input: InputItem[]`

Response:

- `{ turnId: string }`

#### `turn/interrupt`

Purpose: request cancellation of an in-flight turn.

Params:

- `threadId: string`
- `turnId: string`

Response:

- `{}`

Semantics:

- Server requests cancellations for running subprocesses.
- Server emits `turn/completed` with `status: "interrupted"` when cleanup is done.
- Clients MUST rely on `turn/completed` to know the interruption has fully settled.

### Review

#### `review/start`

Purpose: run Codex’s reviewer and stream review output.

Params:

- `threadId: string`
- `target` (one of):
  - `{ "type": "uncommittedChanges" }`
  - `{ "type": "baseBranch", "branch": "main" }`
  - `{ "type": "commit", "sha": "<sha>", "title": "Optional subject" }`
  - `{ "type": "custom", "instructions": "…" }`
- `delivery?: "inline" | "detached"` (default `"inline"`)

Response:

- `{ turn: Turn, reviewThreadId: string }`

Delivery semantics:

- `"inline"`: review runs on the same thread, `reviewThreadId === threadId`, and no new `thread/started` is emitted.
- `"detached"`: review forks a new thread and runs there; server emits `thread/started` for the new review thread before streaming items.

Review streaming markers:

- reviewer start: `item/started` with `type: "enteredReviewMode"`
- reviewer finish: `item/completed` with `type: "exitedReviewMode"` containing the final review text
- the review text is plain text intended to be rendered directly.

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

## Event stream surface reference

Events are notifications (no id) and server-initiated requests (with id) that stream progress.

After a thread is started/resumed, clients MUST continuously read events.

### Thread events

#### `thread/started`

Emitted when:

- a new thread is started
- a thread is forked
- a detached review thread is created

Payload contains the started thread.

### Turn events

#### `turn/started`

Payload:

- `{ turn }` where `turn.status === "inProgress"` and `items` is typically empty.

#### `turn/completed`

Payload:

- `{ turn }` where `turn.status` is one of:
  - `completed`
  - `interrupted`
  - `failed`

On failure:

- `turn.error` contains:
  - `{ message, codexErrorInfo?, additionalDetails? }`

#### `turn/diff/updated`

Payload:

- `{ threadId, turnId, diff }`

`diff` is the latest aggregated unified diff across file changes in the turn.

#### `turn/plan/updated`

Payload:

- `{ turnId, explanation?, plan }`

Each plan entry:

- `{ step, status }`
- `status` in `pending | inProgress | completed`

#### `thread/tokenUsage/updated`

Payload:

- usage updates for the active thread (exact shape schema-defined).

Note:

- `turn/diff/updated` and `turn/plan/updated` may include empty `items` arrays even while item events stream; treat `item/*` events as the source of truth for turn items.

### Item lifecycle events

All items emit:

- `item/started` with `{ item }`
- `item/completed` with `{ item }`

`item.id` matches the `itemId` used by delta notifications.

### Common item types

`ThreadItem` is a tagged union. Common types include:

- `userMessage` — `{ id, content }` where `content` is a list of inputs (`text`, `image`, `localImage`)
- `agentMessage` — `{ id, text }`
- `plan` — `{ id, text }` (final plan from `item/completed` is authoritative)
- `reasoning` — `{ id, summary, content }`
- `commandExecution` — `{ id, command, cwd, status, commandActions, aggregatedOutput?, exitCode?, durationMs? }`
- `fileChange` — `{ id, changes, status }`, `changes` entries `{ path, kind, diff }`
- `mcpToolCall` — `{ id, server, tool, status, arguments, result?, error? }`
- `collabToolCall` — `{ id, tool, status, senderThreadId, receiverThreadId?, newThreadId?, prompt?, agentStatus? }`
- `webSearch` — `{ id, query, action? }`
- `imageView` — `{ id, path }`
- `enteredReviewMode` — `{ id, review }`
- `exitedReviewMode` — `{ id, review }`
- `contextCompaction` — `{ id }`

Web search action subtypes:

- `search` (`query?`, `queries?`)
- `openPage` (`url?`)
- `findInPage` (`url?`, `pattern?`)

Legacy note:

- `thread/compacted` is deprecated; use `contextCompaction` item instead.

### Item delta events

#### agentMessage

- `item/agentMessage/delta` — `{ itemId, delta }` (append in-order)

#### plan (experimental)

- `item/plan/delta` — `{ itemId, delta }` (append in-order)
- Final plan item may not exactly equal concatenated deltas.

#### reasoning

- `item/reasoning/summaryTextDelta` — streams human-readable reasoning summaries
  - includes `summaryIndex` which increments per section
- `item/reasoning/summaryPartAdded` — boundary marker between summary sections
- `item/reasoning/textDelta` — raw reasoning text (mainly for open-source models)
  - group by `contentIndex`

#### commandExecution

- `item/commandExecution/outputDelta` — streams stdout/stderr deltas
  - append in order; final item includes aggregated output, status, exit code, duration

#### fileChange

- `item/fileChange/outputDelta` — tool response output from the underlying patch application

### Error notification

#### `error`

Emitted when the server hits an error mid-turn (may precede `turn/completed` with `status: "failed"`).

Payload matches the error shape in failed turns:

- `{ error: { message, codexErrorInfo?, additionalDetails? } }`

`codexErrorInfo` commonly includes values such as:

- `ContextWindowExceeded`
- `UsageLimitExceeded`
- `HttpConnectionFailed { httpStatusCode? }`
- `ResponseStreamConnectionFailed { httpStatusCode? }`
- `ResponseStreamDisconnected { httpStatusCode? }`
- `ResponseTooManyFailedAttempts { httpStatusCode? }`
- `BadRequest`
- `Unauthorized`
- `SandboxError`
- `InternalServerError`
- `Other`

### App list updates

#### `app/list/updated`

Emitted when app sources finish loading. Includes the latest merged list.

### MCP OAuth completion

#### `mcpServer/oauthLogin/completed`

Emitted when an OAuth login initiated by `mcpServer/oauth/login` completes.

### Account notifications

- `account/login/completed`
- `account/updated`
- `account/rateLimits/updated`

### Fuzzy file search notifications (experimental)

- `fuzzyFileSearch/sessionUpdated` — `{ sessionId, query, files }`
- `fuzzyFileSearch/sessionCompleted` — `{ sessionId, query }`

## Approval workflows

Certain actions require explicit user approval depending on configuration.

Approvals are implemented as **server-initiated JSON-RPC requests** that the client must answer.

General rules:

- Approval requests include `threadId` and `turnId`; clients MUST scope UI state accordingly.
- Client response MUST be exactly one response per approval request `id`.
- The server proceeds or declines and ends the item with `item/completed`.
- Clients MUST render approval prompts inline with the active turn so the user can review proposed actions.

### Command execution approvals

Sequence:

- `item/started` emits a `commandExecution` item describing the pending command.
- Server sends `item/commandExecution/requestApproval` as a JSON-RPC request:
  - includes `itemId`, `threadId`, `turnId`
  - may include `reason`
  - includes command metadata for display (`command`, `cwd`, `commandActions`, etc.)
- Client responds:
  - accept: `{ "decision": "accept", "acceptSettings": { "forSession": false } }`
  - decline: `{ "decision": "decline" }`
- `item/completed` emits final `commandExecution` item:
  - `status: "completed" | "failed" | "declined"`
  - output fields populated on completion

### File change approvals

Sequence:

- `item/started` emits a `fileChange` item with proposed changes and `status: "inProgress"`.
- Server sends `item/fileChange/requestApproval` as a JSON-RPC request:
  - includes `itemId`, `threadId`, `turnId`
  - may include `reason`
- Client responds:
  - accept: `{ "decision": "accept" }`
  - decline: `{ "decision": "decline" }`
- `item/completed` emits final `fileChange` item:
  - `status: "completed" | "failed" | "declined"`

### MCP/app tool-call approvals

App (connector) tool calls can require approval (notably when they advertise side effects).

In some cases, the server may use `tool/requestUserInput` to elicit a decision (Accept/Decline/Cancel). If the user declines or cancels, the related `mcpToolCall` item completes with an error instead of running.

## Dynamic tool calls (experimental)

Dynamic tools allow the client to define additional tools at `thread/start` time.

This surface is experimental and requires:

- `initialize.params.capabilities.experimentalApi = true`

### Defining dynamic tools

On `thread/start`, include:

- `dynamicTools: [{ name, description, inputSchema }]`

### Tool call request from server

When the agent invokes a dynamic tool, the server sends a JSON-RPC request:

```json
{
  "method": "item/tool/call",
  "id": 60,
  "params": {
    "threadId": "thr_123",
    "turnId": "turn_123",
    "callId": "call_123",
    "tool": "lookup_ticket",
    "arguments": { "id": "ABC-123" }
  }
}
```

### Tool call response from client

The client MUST respond with a tool result consisting of content items.

Use:

- `inputText` for text output
- `inputImage` for image URLs/data URLs

Example:

```json
{
  "id": 60,
  "result": {
    "contentItems": [
      { "type": "inputText", "text": "Ticket ABC-123 is open." },
      { "type": "inputImage", "imageUrl": "data:image/png;base64,AAA" }
    ],
    "success": true
  }
}
```

## MCP configuration surface (what Codex understands)

Codex supports MCP servers to provide tools and context.

Codex supports:

- STDIO MCP servers (local process launchers)
- Streamable HTTP MCP servers (remote addressable servers with bearer token or OAuth)

MCP server configuration is stored in `config.toml`:

- User scope: `~/.codex/config.toml`
- Project scope: `.codex/config.toml` (trusted projects only)

### MCP server configuration keys

Each server is configured under:

- `[mcp_servers.<server-name>]`

STDIO server keys:

- `command` (required)
- `args` (optional)
- `env` (optional)
- `env_vars` (optional allow/forward list)
- `cwd` (optional)

Streamable HTTP server keys:

- `url` (required)
- `bearer_token_env_var` (optional)
- `http_headers` (optional)
- `env_http_headers` (optional)

Common keys:

- `startup_timeout_sec` (optional; default 10)
- `startup_timeout_ms` (alias)
- `tool_timeout_sec` (optional; default 60)
- `enabled` (optional)
- `required` (optional; fail startup if enabled server cannot initialize)
- `enabled_tools` (allow list)
- `disabled_tools` (deny list; applied after allow list)

OAuth support settings:

- `mcp_oauth_callback_port` (optional fixed local callback port; otherwise ephemeral)
- `mcp_oauth_credentials_store` (`auto | file | keyring`)

### MCP constraints via requirements

Admin-enforced requirements can constrain MCP:

- allowlists can require both the server name and identity to match for enabling
- identity fields include:
  - `mcp_servers.<id>.identity.command`
  - `mcp_servers.<id>.identity.url`

## Security and permissions surface (what the server may require from the user)

Codex uses two layers of safety control:

- Sandbox mode/policy: what actions are technically permitted (filesystem + network)
- Approval policy: when the user must explicitly approve actions

### Sandbox policies (turn-level)

Sandbox policy is carried as `sandboxPolicy` in `turn/start` (and `command/exec`), with a `type` such as:

- `readOnly`
- `workspaceWrite`
- `dangerFullAccess`
- `externalSandbox`

Network access semantics differ:

- `externalSandbox`: `networkAccess` is `"restricted" | "enabled"`
- otherwise: `networkAccess` is typically boolean

### Approval policy

Approval policies are string enums; exact allowed values are schema-defined and may be constrained by `configRequirements/read`.

Clients MUST use:

- `configRequirements/read` allow lists (when present)
- plus the app-server schema enums

to decide what approval policies to offer in UI.

## UI surface checklist (what a rich client must be able to render)

A client that fully supports the app-server surface MUST be able to:

- Create, resume, fork, list, read, archive/unarchive threads.
- Render a thread transcript using items:
  - user messages, agent messages
  - plan and plan updates
  - reasoning summaries (when present)
  - diffs and file change summaries
  - command executions with live output
  - MCP tool calls and their results/errors
  - review markers and review text
  - compaction markers
- Stream agent responses via `item/agentMessage/delta`.
- Render progress and completion states using `item/started` + `item/completed`.
- Render turn-level plan/diff updates (`turn/plan/updated`, `turn/diff/updated`) while still treating items as authoritative.
- Handle server-initiated requests:
  - command approvals
  - file change approvals
  - dynamic tool calls (if experimental is enabled)
  - user prompts (`tool/requestUserInput`) when invoked
- Provide authentication flows:
  - API key
  - ChatGPT browser login
  - logout
  - rate limit display
- Provide MCP management visibility:
  - list MCP servers + status (`mcpServerStatus/list`)
  - initiate OAuth login (`mcpServer/oauth/login`) and react to completion notifications
- Provide settings/config surfaces:
  - read effective config (`config/read`)
  - write config (`config/value/write`, `config/batchWrite`)
  - read requirements constraints (`configRequirements/read`)
- Handle errors robustly:
  - `error` notifications mid-turn
  - failed turns at `turn/completed`
  - overload errors (`-32001`) with retry behavior
- Support opt-out notification lists for performance-sensitive UIs.

## Non-negotiable client rules

- Never send any method before completing initialize/initialized handshake.
- Always keep reading the event stream once a thread is active.
- Always treat `item/completed` as authoritative.
- Always scope approvals and tool calls by `threadId` + `turnId`.
- Never assume experimental methods or fields exist unless `experimentalApi` is enabled.
- Never assume enum values; use generated schema + `configRequirements/read`.
