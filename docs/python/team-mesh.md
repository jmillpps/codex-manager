# Python Team Mesh Example

## Purpose

Show a minimal but practical multi-agent workflow where team members coordinate through remote skills and shared Python state, without codex-manager orchestrator queue jobs.

## What this demonstrates

- one session per team member (`developer`, `docs`, `reviewer`)
- session creation through `remote_skills.create_session(...)` so dynamic tools are attached at create time
- explicit session policy overrides for smoother automation loops (`approval_policy="never"`, `filesystem_sandbox="workspace-write"`)
- shared in-process team board (task queues + artifacts + completion state)
- session-scoped remote skills for cross-member handoff and status sharing
- websocket tool-call routing back to the correct member session
- sync point via `acm.wait.assistant_reply(...)` for deterministic round progression

## Run it

From repository root:

```bash
PYTHONPATH=packages/python-client/src python3 packages/python-client/examples/team_mesh.py
```

Optional: set `CODEX_MANAGER_API_BASE=http://host:port` to target a non-default codex-manager endpoint.

## Core remote skills in this example

- `team_pull_work()`
- `team_queue_work(owner, task)`
- `team_publish_artifact(kind, summary)`
- `team_read_board(limit=8)`
- `team_mark_done(note="")`

Each session has the same skill names, but handlers are bound to that member's identity and the shared team board.

## How coordination works

1. Python creates three sessions through `remote_skills.create_session(...)` and registers member-bound skills.
2. Python starts one websocket stream listener.
3. When `app_server.request.item.tool.call` arrives, Python routes the signal by `signal.session.id` to that member's skill registry and responds via `tool_calls.respond`.
4. The initial task is queued only for the developer.
5. Team members hand off work with `queue_work(...)`, publish outputs with `publish_artifact(...)`, and close with `mark_done(...)`.

This gives you a local-first team pipeline with real tool-call collaboration and no server-side orchestrator dependency.

The example also uses `drain_pending_calls()` while waiting for each turn so tool-call execution remains reliable even when websocket delivery is delayed.

The example prints `[tool-call] <member>: <tool>` lines whenever pending-call polling resolves tool calls, so you can verify live tool usage directly from stdout.

If a turn times out, the example also prints pending approval/tool-call counts for that member so you can distinguish tool-registration issues from approval-gated stalls.

## Adapting this pattern

- replace in-memory `TeamBoard` with durable storage for crash recovery
- add per-member policies (allowed handoffs, approval gates, timeout rules)
- make review completion criteria explicit (`required artifact kinds`, quality checks)
- federate by running the same pattern against multiple codex-manager destinations and bridging task APIs

## Related docs

- Remote skill lifecycle and API routes: [`remote-skills.md`](./remote-skills.md)
- Stream decorators and handler registration: [`streaming-and-handlers.md`](./streaming-and-handlers.md)
- Copy/paste workflow snippets: [`practical-recipes.md`](./practical-recipes.md)
