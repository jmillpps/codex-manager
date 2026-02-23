<p align="center">
  <img src="./docs/assets/codex-manager-logo.svg" alt="Codex Manager" width="640" />
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache%202.0-2563eb" /></a>
  <img alt="Node &gt;=24" src="https://img.shields.io/badge/node-%3E%3D24-16a34a?logo=node.js&amp;logoColor=white" />
  <img alt="pnpm 10.29.3" src="https://img.shields.io/badge/pnpm-10.29.3-f97316?logo=pnpm&amp;logoColor=white" />
  <img alt="CI not configured yet" src="https://img.shields.io/badge/ci-not%20configured%20yet-6b7280" />
  <img alt="Transport: STDIO + WebSocket" src="https://img.shields.io/badge/transport-STDIO%20%2B%20WebSocket-0f172a" />
</p>

<p align="center"><strong>Codex Manager</strong> is a local-first Codex workspace for running, organizing, and supervising Codex chat threads through a browser UI.</p>
<p align="center">It pairs a React/Vite frontend with a Fastify API that supervises <code>codex app-server</code> over STDIO, streams protocol events over WebSocket, and keeps materialized session/project state durable under <code>.data/</code>.</p>

<p align="center"><code>pnpm install && cp apps/api/.env.example apps/api/.env && cp apps/web/.env.example apps/web/.env && pnpm dev</code></p>
<p align="center">Before sending your first turn, set <code>OPENAI_API_KEY</code> in <code>apps/api/.env</code> or ensure <code>~/.codex/auth.json</code> exists for bootstrap.</p>

<p align="center"><a href="https://github.com/jmillpps/codex-manager/issues">Issues</a> · <a href="https://github.com/jmillpps/codex-manager/issues/new">Report a Bug</a> · <a href="https://github.com/jmillpps/codex-manager/discussions">Discussions</a> · <a href="./CONTRIBUTING.md">Contributing</a></p>

<p align="center">
  <img src="./docs/assets/ui-overview.png" alt="Codex Manager UI overview" width="92%" />
</p>

---

## Table of Contents

- [Quickstart](#quickstart)
- [Why This Project Exists](#why-this-project-exists)
- [Feature Highlights](#feature-highlights)
- [Agent Extension Runtime](#agent-extension-runtime)
- [Build a 5-Minute Event Pipeline Extension](#build-a-5-minute-event-pipeline-extension)
- [Package and Load Extensions](#package-and-load-extensions)
- [Extension Lifecycle Security (RBAC + Trust)](#extension-lifecycle-security-rbac--trust)
- [Extension Validation and Conformance](#extension-validation-and-conformance)
- [Backstory](#backstory)
- [Getting Started (Detailed)](#getting-started-detailed)
- [Repository Layout](#repository-layout)
- [Documentation Map](#documentation-map)
- [Contributing](#contributing)
- [Support](#support)
- [License](#license)

---

## Quickstart

Install prerequisites and verify your environment:

```bash
node --version
pnpm --version
codex --version
codex app-server --help
```

This README assumes a Unix-like shell environment (`bash`, `zsh`, or `sh`).

From the repository root:

```bash
pnpm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env

# Choose one auth path before sending turns.
# Option A (recommended): set OPENAI_API_KEY in apps/api/.env
# edit apps/api/.env and set:
# OPENAI_API_KEY=your_key_here

# Option B: ensure ~/.codex/auth.json exists for startup bootstrap into CODEX_HOME

pnpm dev
```

Open:

- `http://127.0.0.1:5173` (web)
- `http://127.0.0.1:3001/api/health` (api health)

Then verify auth readiness:

```bash
curl -s http://127.0.0.1:3001/api/health | grep -Eq '"likelyUnauthenticated"\\s*:\\s*false' \
  && echo "Auth ready" || echo "Auth missing or not loaded"
```

<details>
<summary>Alternative auth modes (API key vs Codex home state)</summary>

The API supports either auth path:

- set `OPENAI_API_KEY` in `apps/api/.env`, or
- use existing Codex auth state in `CODEX_HOME/auth.json` (startup can bootstrap from `~/.codex/auth.json` when available).

If auth is missing, health may still return `ok`, but turns can fail with `401` when model calls begin.

</details>

---

## Why This Project Exists

Codex app-server exposes a rich runtime/protocol surface, but teams still need a practical local workspace that combines:

- consistent session lifecycle control
- project-level organization
- approval and tool-input workflows
- stream-aware UI behavior
- reproducible operations and troubleshooting runbooks

Codex Manager focuses on that layer while keeping Codex as the execution authority.

---

## Feature Highlights

- Local-first architecture with API + web stack and repo-local state under `.data/`
- Session and project workflows:
  - create/rename/archive/unarchive/delete chats
  - assign/move chats across projects and unassigned views
  - bulk project chat move/delete operations
- Materialization-aware behavior:
  - loaded non-materialized chats are visible and movable
  - archive constraints enforced when rollout is not yet materialized
- Live streaming transcript with category filters (`All`, `Chat`, `Tools`, `Approvals`)
- Turn-group transcript UX: one user request card plus one consolidated response bubble per turn, with a top thought area (`Working...` / `Worked for …`) and bottom final assistant response text
- Approval and tool input actions surfaced inline in response thought details
- Session transcript reload path merges streamed runtime tool/approval events so thought auditing remains visible even when `thread/read` omits raw tool items
- Thread control surface:
  - `fork`, `steer`, `interrupt`, `compact`, `rollback`, `review/start`, `backgroundTerminals/clean`
- Extension runtime:
  - event-driven pipelines as loadable extensions (`agents/*`, package roots, configured roots)
  - deterministic fanout dispatch + timeout isolation + atomic reload
  - lifecycle inventory/reload APIs with RBAC and trust/capability enforcement
- Capability/integration settings:
  - combined `Model -> Reasoning` selection (model-aware effort options), account state, MCP status/oauth, skills, config, collaboration modes, experimental features
- Cross-client sidebar synchronization via websocket events
- Right-pane blocking modal when an active session is deleted

---

## Agent Extension Runtime

Codex Manager includes a generic event runtime for building workflow logic as extensions instead of hard-coding behavior in API core.

What you get out of the box:

- deterministic fanout dispatch by `priority`, then module name, then registration order
- per-handler timeout isolation (a slow/failing handler does not block the rest)
- typed handler envelopes (`enqueue_result`, `action_result`, `handler_result`, `handler_error`)
- worker-side structured action intents (`kind: "action_intents"`) executed inside API core with scope + capability + idempotency enforcement
- atomic extension reload with snapshot preservation on failure
- extension inventory endpoint with compatibility, trust, and origin metadata

Core event names emitted by API today:

- `file_change.approval_requested`
- `turn.completed`
- `suggest_request.requested`

Reference docs:

- [`docs/operations/agent-extension-authoring.md`](docs/operations/agent-extension-authoring.md)
- [`docs/operations/agent-extension-lifecycle-and-conformance.md`](docs/operations/agent-extension-lifecycle-and-conformance.md)
- [`docs/protocol/agent-runtime-sdk.md`](docs/protocol/agent-runtime-sdk.md)
- [`docs/protocol/agent-extension-packaging.md`](docs/protocol/agent-extension-packaging.md)

---

## Build a 5-Minute Event Pipeline Extension

Create a repo-local extension:

```text
agents/
  demo-suggest-agent/
    extension.manifest.json
    events.mjs
```

`agents/demo-suggest-agent/extension.manifest.json`:

```json
{
  "name": "@acme/demo-suggest-agent",
  "version": "1.0.0",
  "agentId": "demo-suggest",
  "displayName": "Demo Suggest Agent",
  "runtime": {
    "coreApiVersionRange": ">=1 <2",
    "profiles": [{ "name": "codex-manager", "versionRange": ">=1 <2" }]
  },
  "entrypoints": {
    "events": "./events.mjs"
  },
  "capabilities": {
    "events": ["suggest_request.requested"],
    "actions": ["queue.enqueue"]
  }
}
```

`agents/demo-suggest-agent/events.mjs`:

```js
export function registerAgentEvents(registry) {
  registry.on("suggest_request.requested", async (event, tools) => {
    const payload = event && typeof event.payload === "object" && event.payload ? event.payload : {};
    const projectId = typeof payload.projectId === "string" && payload.projectId.length > 0 ? payload.projectId : "demo-project";
    const sessionId = typeof payload.sessionId === "string" && payload.sessionId.length > 0 ? payload.sessionId : "demo-session";
    const requestKey =
      typeof payload.requestKey === "string" && payload.requestKey.length > 0 ? payload.requestKey : "demo-request";

    return tools.enqueueJob({
      type: "suggest_request",
      projectId,
      sourceSessionId: sessionId,
      payload: {
        requestKey,
        sessionId,
        projectId,
        sourceThreadId: sessionId,
        sourceTurnId: "demo-turn",
        instructionText: "Generate one concrete next user request."
      }
    });
  });
}
```

Reload and verify:

```bash
curl -sS -X POST http://127.0.0.1:3001/api/agents/extensions/reload
curl -sS http://127.0.0.1:3001/api/agents/extensions
```

---

## Package and Load Extensions

Supported load sources:

- repo-local extensions under `agents/*` (`origin.type = repo_local`)
- installed package roots via `AGENT_EXTENSION_PACKAGE_ROOTS` (`origin.type = installed_package`)
- configured roots via `AGENT_EXTENSION_CONFIGURED_ROOTS` (`origin.type = configured_root`)

If the same extension root is discoverable from multiple sources, loader keeps the highest-precedence origin (`repo_local` > `installed_package` > `configured_root`).

External/package layout:

```text
<extension-root>/
  extension.manifest.json
  events.js|events.mjs|events.ts
  AGENTS.md
  orientation.md
  agent.config.json
```

Example env wiring:

```bash
# Linux/macOS path delimiter is :
AGENT_EXTENSION_PACKAGE_ROOTS=/opt/codex/extensions:/home/user/my-extension-packages
AGENT_EXTENSION_CONFIGURED_ROOTS=/etc/codex/extensions
```

```powershell
# Windows path delimiter is ;
$env:AGENT_EXTENSION_PACKAGE_ROOTS="C:\codex\extensions;D:\team\extensions"
$env:AGENT_EXTENSION_CONFIGURED_ROOTS="C:\codex\configured-extensions"
```

Manifest compatibility is enforced at load time (including semver ranges for `coreApiVersionRange` and profile `versionRange`).

---

## Extension Lifecycle Security (RBAC + Trust)

Lifecycle endpoints:

- `GET /api/agents/extensions`
- `POST /api/agents/extensions/reload`

RBAC modes (`AGENT_EXTENSION_RBAC_MODE`):

- `disabled` (loopback-only local admin access; remote callers are rejected)
- `header` (trusted proxy/header asserted roles)
- `jwt` (bearer-token verified role claims)

Header mode:

- validates `x-codex-rbac-token` against `AGENT_EXTENSION_RBAC_HEADER_SECRET`
- reads `x-codex-role` and optional `x-codex-actor`
- unless `AGENT_EXTENSION_ALLOW_INSECURE_HEADER_MODE=true`, header mode requires loopback host binding and `AGENT_EXTENSION_RBAC_HEADER_SECRET`

JWT mode:

- verifies `Authorization: Bearer <token>`
- requires `AGENT_EXTENSION_RBAC_JWT_SECRET`
- optional issuer/audience constraints:
  - `AGENT_EXTENSION_RBAC_JWT_ISSUER`
  - `AGENT_EXTENSION_RBAC_JWT_AUDIENCE`
- configurable claims:
  - role claim: `AGENT_EXTENSION_RBAC_JWT_ROLE_CLAIM` (default `role`)
  - actor claim: `AGENT_EXTENSION_RBAC_JWT_ACTOR_CLAIM` (default `sub`)

Trust/capability mode (`AGENT_EXTENSION_TRUST_MODE`):

- `disabled`: allow undeclared capabilities
- `warn`: allow + warn
- `enforced`: block undeclared event/action capabilities

---

## Extension Validation and Conformance

Run full release-gate validation:

```bash
pnpm --filter @repo/api typecheck
pnpm --filter @repo/api test
pnpm --filter @repo/web typecheck
pnpm --filter @repo/web test
pnpm smoke:runtime
node scripts/run-agent-conformance.mjs
```

Conformance output artifact:

- `.data/agent-conformance-report.json`

Portable extension expectation:

- one extension passes under at least two runtime profiles (`codex-manager` and `fixture-profile` in the bundled conformance harness).

---

## Backstory

This repository started as a docs-first effort to lock down product scope, protocol semantics, lifecycle guarantees, and operations before broad implementation.

That foundation now drives an active codebase with runtime verification harnesses, browser-level smoke tests, and a split documentation tree designed for maintainability as the protocol and UI evolve.

---

## Getting Started (Detailed)

### 1) Requirements

- Node.js `>=24`
- pnpm `10.29.3`
- Codex CLI available on `PATH`

If you need to set pnpm via Corepack:

```bash
corepack enable
corepack prepare pnpm@10.29.3 --activate
```

### 2) Environment configuration

`apps/api/.env` default local baseline:

```env
HOST=127.0.0.1
PORT=3001
LOG_LEVEL=info
CODEX_BIN=codex
CODEX_HOME=.data/codex-home
DATA_DIR=.data
OPENAI_API_KEY=
DEFAULT_APPROVAL_POLICY=untrusted
DEFAULT_SANDBOX_MODE=read-only
```

`apps/web/.env` baseline:

```env
VITE_API_BASE=/api
VITE_API_PROXY_TARGET=http://127.0.0.1:3001
```

### 3) Development commands

```bash
pnpm dev               # api + web
pnpm dev:api           # api only
pnpm dev:web           # web only
pnpm gen               # openapi + api client generation
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:runtime
pnpm test:e2e:list   # list browser suites
pnpm test:e2e        # run browser smoke (requires runtime auth + browser deps)
```

Optional: install an always-on user service for the API (auto-restart + boot persistence on systemd hosts):

```bash
./scripts/install-api-user-service.sh
systemctl --user status codex-manager-api.service
```

Runbook: [`docs/operations/api-service-supervision.md`](docs/operations/api-service-supervision.md)

### 4) Data and artifact locations

This repository keeps default runs clean by writing runtime artifacts to ignored paths:

- runtime state: `.data/`
- codex home (recommended local): `.data/codex-home`
- playwright output: `.data/playwright-test-results`
- playwright linux dependency bootstrap cache: `.data/playwright-libs`

Ignored report/state directories:

- `test-results/`
- `playwright-report/`
- `blob-report/`
- `coverage/`

---

## Repository Layout

```text
apps/
  api/        Fastify API + Codex app-server supervisor
  cli/        Operator CLI for endpoint-complete API/websocket workflows
  web/        React/Vite frontend
packages/
  agent-runtime-sdk/ Provider-neutral extension event/runtime contracts
  api-client/ Generated TypeScript API client
  codex-protocol/ Generated protocol schema/types
scripts/      Generation + runtime verification utilities
tests/e2e/    Playwright browser smoke coverage
docs/         Product, architecture, protocol, and operations knowledge tree
```

---

## Documentation Map

- Product requirements: [`docs/prd.md`](docs/prd.md)
- Architecture and invariants: [`docs/architecture.md`](docs/architecture.md)
- Codex protocol index: [`docs/codex-app-server.md`](docs/codex-app-server.md)
- Protocol deep dives: [`docs/protocol/`](docs/protocol/)
- Operations index: [`docs/ops.md`](docs/ops.md)
- CLI operations runbook: [`docs/operations/cli.md`](docs/operations/cli.md)
- Setup/validation/troubleshooting/maintenance runbooks: [`docs/operations/`](docs/operations/)
- Always-on API supervision runbook: [`docs/operations/api-service-supervision.md`](docs/operations/api-service-supervision.md)
- Current implementation and verification status: [`docs/implementation-status.md`](docs/implementation-status.md)

---

## Contributing

Contributions are welcome.

Before opening a PR, read:

- [`CONTRIBUTING.md`](CONTRIBUTING.md)
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)

Highlights:

- use focused branches and explicit staging (`git add <file1> <file2>`)
- include validation results with your PR
- update documentation in the same change when behavior/workflow/config changes

---

## Support

For help, issue reports, and feature requests:

- Start with [`SUPPORT.md`](SUPPORT.md).
- Use [`Issues`](https://github.com/jmillpps/codex-manager/issues) for bugs and feature requests.
- Open a new ticket from [`New issue`](https://github.com/jmillpps/codex-manager/issues/new).
- Use [`Discussions`](https://github.com/jmillpps/codex-manager/discussions) for implementation questions.

If you suspect a security issue, do not post sensitive details publicly. Use a private reporting path if configured, or open a minimal issue requesting one.

---

## License

This project is licensed under the Apache 2.0 License.

See [`LICENSE`](LICENSE) for details.
