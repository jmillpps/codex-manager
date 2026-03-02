# Python Protocol Interface Contracts

## Purpose

Detailed contract reference for protocol-oriented extension points in the Python client.

Use with [`protocol-interfaces.md`](./protocol-interfaces.md).

## Protocol families

- request executors (sync/async)
- header providers (sync/async)
- retry policy
- hook middleware contracts
- stream matcher/handler/router
- plugin contracts and lifecycle

## Compatibility invariants

- public client/domain names remain stable
- extension points are additive, not breaking
- existing decorator and raw request surfaces stay available

## Runtime semantics expectations

- middleware ordering deterministic
- retries disabled unless explicit policy provided
- stream handler failures isolated by router implementation
- plugin lifecycle start/stop ordering deterministic

## Safety expectations

- no implicit remote plugin loading
- header providers must avoid leaking sensitive tokens
- retry defaults should not replay mutating operations without explicit opt-in

## Related docs

- Protocol interface index: [`protocol-interfaces.md`](./protocol-interfaces.md)
- Packaging/development details: [`development-and-packaging.md`](./development-and-packaging.md)
- Typed model behavior: [`typed-models.md`](./typed-models.md)
