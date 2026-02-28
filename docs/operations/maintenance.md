# Operations: Maintenance and Cleanup

## Safe reset procedures

### Reset backend state (recommended for dev)

This clears local API persistence and logs but does not necessarily delete Codex’s own history unless Codex home is repo-local.

Steps:

1. Stop `pnpm dev`
2. Delete API data directory:

```bash
rm -rf .data
```

3. Restart:

```bash
pnpm dev
```

### Reset Codex state (only when you explicitly want to)

Codex stores threads/rollouts under `CODEX_HOME` (or default Codex home if not set).

If `CODEX_HOME` is repo-local (recommended), you can reset Codex state by deleting it:

```bash
rm -rf .data/codex-home
```

If you did not set `CODEX_HOME`, do **not** delete anything under your home directory unless you intentionally want to wipe global Codex state.

---

## Git workflow rules

### Branch naming

- `feat/<short-name>`
- `fix/<short-name>`
- `chore/<short-name>`

### Creating and switching feature branches

Use this flow before starting work:

```bash
git fetch origin
git switch main
git pull --ff-only
```

Create and switch to a new branch:

```bash
git switch -c feat/<short-name>
```

Switch to an existing branch:

```bash
git switch feat/<short-name>
```

### Commit messages

Use Conventional Commits:

- `feat: ...`
- `fix: ...`
- `refactor: ...`
- `chore: ...`
- `test: ...`
- `docs: ...`

### Generated files policy

- Generated files are updated only via generation scripts.
- If repo policy requires committing generated output, commit it in the same PR that changes the source.

---

## CI expectations

GitHub Actions workflows are not configured in this repository yet.

Until CI is added, treat the local gate set as required before opening or merging PRs:

- `pnpm install`
- `pnpm gen` (and confirm generated artifacts are committed when changed)
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm smoke:runtime`
- `node scripts/run-agent-conformance.mjs`
- `pnpm test:e2e`

When CI is introduced, mirror this exact gate set in workflow configuration.

---

## Operational invariants

These must always remain true:

- The API is the only process that talks to Codex App Server in normal operation.
- Codex App Server is accessed over STDIO using newline-delimited JSON messages.
- A connection to Codex is considered invalid until `initialize` → `initialized` handshake completes.
- Streaming is event-driven; `item/completed` is authoritative.
- Secrets are never committed to the repo.
- The web app only uses `/api` as its base and never hardcodes backend hosts.

---

## When to update this document

Update `ops.md` in the same PR whenever you change:

- any required environment variables
- default ports, URLs, or proxy behavior
- locations of logs and data directories
- generation commands or output paths
- test commands or gating expectations
- Codex runtime supervision behavior

If a contributor following `ops.md` would get stuck, then `ops.md` is wrong and must be fixed.
