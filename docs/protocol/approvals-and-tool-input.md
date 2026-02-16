# Codex App Server Approvals and Tool Input

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
