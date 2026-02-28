# codex-manager Python Client

`codex-manager-client` is a Python SDK for codex-manager's full control-plane surface.

- Talks to codex-manager REST APIs and websocket stream (`/api/stream`)
- Supports request hooks and stream event decorators
- Supports protocol-based injection for executors, header providers, retry policies, routers, and plugins
- Supports middleware objects via `use_middleware(...)`
- Includes session-scoped wrappers for concise automation
- Includes additive typed OpenAPI facade via `cm.typed` / `acm.typed` with generated Pydantic models
- Includes configurable boundary validation modes (`typed-only`, `off`, `strict`) for typed and selected dict-domain workflows
- Includes sync/async wait helpers for generic polling and request/reply synchronization
- Includes dynamic tool-call wrappers and session-scoped remote-skill bridge helpers
  - `remote_skills.send(...)` forwards registered skills as `dynamic_tools` automatically
  - `remote_skills.create_session(register=...)` creates sessions with remote tools attached at create-time for first-turn reliability
  - `remote_skills.sync_runtime()` pushes current tool catalog via session resume
  - `remote_skills.send_prepared(...)` runs catalog-prepare + send for existing sessions
  - `remote_skills.respond_to_signal(...)` and `remote_skills.drain_pending_calls(...)` include session-aware routing, idempotent duplicate handling, and bounded response-submit retries

See repository docs for full guides:

- `docs/python/introduction.md`
- `docs/python/quickstart.md`
- `docs/python/practical-recipes.md`
- `docs/python/team-mesh.md`
- `docs/python/streaming-and-handlers.md`
- `docs/python/api-surface.md`
- `docs/python/protocol-interfaces.md`
- `docs/python/typed-models.md`
- `docs/python/remote-skills.md`
