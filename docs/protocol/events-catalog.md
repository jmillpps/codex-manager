# Protocol Deep Dive: Event and Request Catalog

## Purpose

Comprehensive catalog view for app-server notifications and server-initiated request method names.

Use with [`events.md`](./events.md) when building event routers/subscribers.

## Stable Notification Methods

- `account/login/completed`
- `account/rateLimits/updated`
- `account/updated`
- `app/list/updated`
- `authStatusChange`
- `configWarning`
- `deprecationNotice`
- `error`
- `item/agentMessage/delta`
- `item/commandExecution/outputDelta`
- `item/commandExecution/terminalInteraction`
- `item/completed`
- `item/fileChange/outputDelta`
- `item/mcpToolCall/progress`
- `item/plan/delta`
- `item/reasoning/summaryPartAdded`
- `item/reasoning/summaryTextDelta`
- `item/reasoning/textDelta`
- `item/started`
- `loginChatGptComplete`
- `mcpServer/oauthLogin/completed`
- `rawResponseItem/completed`
- `sessionConfigured`
- `thread/compacted`
- `thread/name/updated`
- `thread/started`
- `thread/tokenUsage/updated`
- `turn/completed`
- `turn/diff/updated`
- `turn/plan/updated`
- `turn/started`
- `windows/worldWritableWarning`

## Stable Server-Initiated Request Methods

- `account/chatgptAuthTokens/refresh`
- `applyPatchApproval`
- `execCommandApproval`
- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/tool/call`
- `item/tool/requestUserInput`

## Event Router Guidance

- route by `method` first, then parse payload shape.
- keep method-name matching exact and case-sensitive.
- treat unknown methods as forward-compatible signals (log + ignore unless explicitly supported).

## Related docs

- Event stream reference: [`events.md`](./events.md)
- Item types and delta semantics: [`events-item-types-and-deltas.md`](./events-item-types-and-deltas.md)
- Approval/tool-input deep dive: [`approvals-and-tool-input.md`](./approvals-and-tool-input.md)
