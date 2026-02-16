# Codex App Server Methods: Core Lifecycle

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
