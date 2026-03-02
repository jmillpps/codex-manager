# Python Typed Models and Facade

## Purpose

This guide summarizes generated model architecture, typed facade behavior, and validation-mode strategy.

## What is implemented

- generated OpenAPI-based Pydantic models
- additive typed facade on sync/async clients (`cm.typed`, `acm.typed`)
- typed validation error diagnostics
- explicit typed vs raw operation coverage declaration

## Behavior summary

- existing dict-domain APIs stay unchanged
- typed facade is opt-in per call path
- validation behavior can be tuned by mode and per-call override

## Validation mode summary

- `typed-only` (default)
- `off`
- `strict`

Strict mode extends validation to selected dict-domain operations while preserving dict return shapes.

## Practical usage summary

Use typed facade when you need stronger request/response guarantees for:

- session lifecycle operations
- settings writes/reads
- suggest-request flows
- approval/tool-input decisions

## Next References

- Typed contract reference: [`typed-models-contract-reference.md`](./typed-models-contract-reference.md)
- Validation errors and quality gates: [`typed-models-validation-and-gates.md`](./typed-models-validation-and-gates.md)

## Related docs

- Python API surface: [`api-surface.md`](./api-surface.md)
- Protocol interfaces: [`protocol-interfaces.md`](./protocol-interfaces.md)
- Development and packaging: [`development-and-packaging.md`](./development-and-packaging.md)
