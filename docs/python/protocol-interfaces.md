# Python Protocol Interfaces

## Purpose

This guide explains how transport, hooks, stream routing, retry/header providers, and plugins can be customized without changing public domain APIs.

## Implemented architecture summary

Protocol-oriented extension points are implemented in `protocols.py` and wired through client constructors and runtime subsystems.

Implemented boundaries include:

- request execution
- header provision
- retry policy
- hook registry/middleware
- stream router injection
- plugin lifecycle orchestration

## Stability rules

- keep public client names/domains stable
- keep decorator surfaces stable
- keep raw-request escape hatch available
- keep extension-point additions backward compatible

## Runtime behavior summary

- hook ordering deterministic
- retry disabled unless policy provided
- stream handler exceptions isolated
- plugin lifecycle ordering deterministic

## Validation summary

Expected checks:

- compile checks for package and tests
- protocol-boundary unit tests
- route parity checks

## Next References

- Contract reference: [`protocol-interfaces-contracts.md`](./protocol-interfaces-contracts.md)
- Example customizations: [`protocol-interfaces-examples.md`](./protocol-interfaces-examples.md)

## Related docs

- API surface: [`api-surface.md`](./api-surface.md)
- Development and packaging: [`development-and-packaging.md`](./development-and-packaging.md)
- Typed models: [`typed-models.md`](./typed-models.md)
