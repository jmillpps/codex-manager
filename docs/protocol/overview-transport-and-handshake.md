# Protocol Deep Dive: Transport and Handshake

## Purpose

Deep reference for app-server transport framing and initialization behavior.

Use this with [`overview.md`](./overview.md) when implementing low-level clients or debugging transport-level failures.

## Supported Transports

- STDIO (default, supported)
- WebSocket (experimental/unsupported for production)

Codex Manager uses STDIO supervision.

## STDIO Framing Rules

- one JSON object per line (`\n` delimited)
- requests/responses/notifications may interleave
- request ids must be unique among in-flight requests per connection

Failure to respect one-line framing causes parser desync and protocol-level errors.

## JSON-RPC Wire Model (Practical)

Protocol is JSON-RPC-like in behavior.

Messages:

- request: `{ method, id, params? }`
- response: `{ id, result }` or `{ id, error }`
- notification: `{ method, params? }` (no id)

## Initialization Sequence

Required sequence:

1. client sends `initialize`
2. server responds to `initialize`
3. client sends `initialized` notification
4. only then call other methods

Invalid sequencing outcomes:

- non-handshake methods before init -> rejected
- duplicate initialize on same connection -> rejected

## Initialize Payload Expectations

`initialize.params` includes:

- `clientInfo` (required)
- optional `capabilities`

Key capability controls:

- `experimentalApi: true` to enable experimental method/field usage
- `optOutNotificationMethods: string[]` for exact-match notification suppression

## Backpressure/Overload Behavior

On saturated ingress, server may reject new requests with retryable overload error (`-32001`).

Client guidance:

- treat overload as retryable
- use exponential backoff + jitter
- do not flood-retry on same cadence

## Experimental API Gating

Runtime opt-in is separate from schema generation opt-in.

- runtime: `initialize.capabilities.experimentalApi=true`
- schema generation: `generate-ts`/`generate-json-schema` with `--experimental`

Use both when building clients that must consume experimental shapes safely.

## Related docs

- Protocol overview index: [`overview.md`](./overview.md)
- Core methods: [`methods-core.md`](./methods-core.md)
- Integrations methods: [`methods-integrations.md`](./methods-integrations.md)
