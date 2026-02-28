# Harness Deep Dive: Runtime Event Catalog

## Purpose

Detailed catalog for codex-manager harness event families and emitted payload envelopes.

Use with [`harness-runtime-events.md`](./harness-runtime-events.md) when building extension subscriptions or event normalization logic.

## Event Families

## Synthesized harness events

- `file_change.approval_requested`
- `turn.completed`
- `suggest_request.requested`

## App-server pass-through events

- notification family: `app_server.<normalized_method>`
- request family: `app_server.request.<normalized_method>`

Normalization:

- split method on `/`
- camel/pascal to `snake_case` per segment
- join segments with `.`

## Shared App-Server Signal Envelope

- `source: "app_server"`
- `signalType: "notification" | "request"`
- `eventType`
- `method`
- `receivedAt`
- `context.threadId`, `context.turnId`
- `params`
- `session` metadata when known
- `requestId` for request signals

## Repository-Significant Signal Methods

Examples commonly used by repository workflows:

- `item/started` -> `app_server.item.started`
- `item/tool/call` -> `app_server.request.item.tool.call`
- `item/fileChange/requestApproval` -> `app_server.request.item.file_change.request_approval`

## Core Harness Event Payload Highlights

## `file_change.approval_requested`

Includes routing context, summary/details, and source-event hints for approval/reconcile paths.

## `turn.completed`

Includes routing context, file-change gating state, and transcript snapshot payload.

## `suggest_request.requested`

Includes request key, routing ids, user request, transcript context, and optional model/effort hints.

## Related docs

- Harness event contract index: [`harness-runtime-events.md`](./harness-runtime-events.md)
- Harness runtime surfaces (ws/transcript/lifecycle): [`harness-runtime-websocket-and-transcript.md`](./harness-runtime-websocket-and-transcript.md)
- Agent SDK envelopes: [`agent-runtime-sdk.md`](./agent-runtime-sdk.md)
