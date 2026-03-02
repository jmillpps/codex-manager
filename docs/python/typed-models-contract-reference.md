# Python Typed Models Contract Reference

## Purpose

Detailed contract reference for generated typed request/response models and typed operation coverage.

Use with [`typed-models.md`](./typed-models.md).

## Implemented typed components

- generated models under `generated/openapi_models.py`
- typed client facade modules
- typed validation error model
- client integration exposing `.typed` on sync/async clients

## Typed behavior model

- dict API remains unchanged
- typed facade is additive
- typed calls accept model instances or equivalent keyword payloads
- typed calls return typed models/unions for covered operations

## Validation modes

- `typed-only`
- `off`
- `strict`

Per-call `validate=True/False` overrides mode behavior.

## Coverage posture

- typed operation set explicitly declared
- unwrapped operation ids explicitly tracked as raw
- coverage completeness enforced by typed coverage tests

## Related docs

- Typed models index: [`typed-models.md`](./typed-models.md)
- Validation and quality gates: [`typed-models-validation-and-gates.md`](./typed-models-validation-and-gates.md)
- API surface guide: [`api-surface.md`](./api-surface.md)
