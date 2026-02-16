# Codex App Server Event Stream Reference

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
