# Operations Deep Dive: Generation Command Reference

## Purpose

Command reference for generated artifact workflows.

Use with [`generation-and-validation.md`](./generation-and-validation.md).

## OpenAPI and API client

Generate OpenAPI:

```bash
pnpm openapi:gen
```

Generate API client:

```bash
pnpm client:gen
```

Generate all (ordered):

```bash
pnpm gen
```

## Python typed model generation

Generate:

```bash
pnpm python:openapi:gen
```

Determinism check:

```bash
pnpm python:openapi:check
```

## Protocol schema generation

Example canonical command:

```bash
pnpm codex:schema
```

Use `--experimental` variants only when deliberately targeting experimental surfaces.

## Artifact policy rules

- generated artifacts are never hand-edited
- if generation changes committed artifacts, include them in same change
- run checks after generation before opening PR

## Related docs

- Generation/validation runbook: [`generation-and-validation.md`](./generation-and-validation.md)
- Validation gate playbook: [`validation-gate-playbook.md`](./validation-gate-playbook.md)
