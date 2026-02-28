# Codex App Server Protocol Overview

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
{ "method": "thread/start", "id": 10, "params": { "cwd": "/path/to/project" } }
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
