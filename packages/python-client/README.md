# codex-manager Python Client

`codex-manager-client` is a Python SDK for codex-manager's full control-plane surface.

- Talks to codex-manager REST APIs and websocket stream (`/api/stream`)
- Supports request hooks and stream event decorators
- Supports protocol-based injection for executors, header providers, retry policies, routers, and plugins
- Supports middleware objects via `use_middleware(...)`
- Includes session-scoped wrappers for concise automation
- Includes additive typed OpenAPI facade via `cm.typed` / `acm.typed` with generated Pydantic models
- Includes configurable boundary validation modes (`typed-only`, `off`, `strict`) for typed and selected dict-domain workflows
- Includes dynamic tool-call wrappers and session-scoped remote-skill bridge helpers

See repository docs for full guides:

- `docs/python/introduction.md`
- `docs/python/quickstart.md`
- `docs/python/practical-recipes.md`
- `docs/python/streaming-and-handlers.md`
- `docs/python/api-surface.md`
- `docs/python/protocol-interfaces.md`
- `docs/python/typed-models.md`
- `docs/python/remote-skills.md`
