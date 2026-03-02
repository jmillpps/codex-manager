# Python Typed Validation and Gates

## Purpose

Detailed reference for typed validation error behavior, generation commands, and quality gates.

Use with [`typed-models.md`](./typed-models.md).

## Error model

Typed parse/validation failures raise `TypedModelValidationError` with operation/boundary/model/error diagnostics.

Boundary types:

- request
- response

Strict-mode dict-domain validation targets are explicitly declared and test-backed.

## Parse helpers

- `cm.typed.parse(operation_key, payload)`
- `acm.typed.parse(operation_key, payload)`

These validate payloads against registered typed contracts.

## Generation workflow

```bash
pnpm openapi:gen
pnpm python:openapi:gen
pnpm python:openapi:check
```

## Quality gates

API side:

- route parity checks
- schema quality checks for typed-target operations

Python side:

- typed operation coverage tests
- typed/raw partition completeness tests

## Adding a typed operation safely

1. ensure stable OpenAPI `operationId`
2. ensure request/response schemas are present and non-loose
3. regenerate models
4. update typed contract mapping
5. run full typed gate checks

## Related docs

- Typed models index: [`typed-models.md`](./typed-models.md)
- Contract reference: [`typed-models-contract-reference.md`](./typed-models-contract-reference.md)
- Generation runbook: [`../operations/generation-and-validation.md`](../operations/generation-and-validation.md)
