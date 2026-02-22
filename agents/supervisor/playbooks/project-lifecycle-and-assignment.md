# Playbook: Project Lifecycle and Session Assignment

## Purpose

Use this playbook for project CRUD, bulk project chat operations, and mapping sessions into/out of projects.

Primary API reference surface: `apps/api/src/index.ts`

## Endpoints Covered

- `GET /api/projects`
- `POST /api/projects`
- `POST /api/projects/:projectId/rename`
- `DELETE /api/projects/:projectId`
- `POST /api/projects/:projectId/chats/move-all`
- `POST /api/projects/:projectId/chats/delete-all`
- `POST /api/sessions/:sessionId/project`

## Contracts and Semantics

### List projects

- Route: `GET /api/projects`
- Behavior:
  - returns project metadata only
- Response: `{ data: ProjectSummary[] }`

### Create project

- Route: `POST /api/projects`
- Body: `{ name, workingDirectory? }`
- Behavior:
  - rejects duplicate names with `409 duplicate_name`
  - creates project metadata only
  - system-owned agent sessions are provisioned lazily on first queued job
  - publishes `project_upserted`
- Response: `{ status: "ok", project, orchestrationSession: null }`

### Rename project / update working directory

- Route: `POST /api/projects/:projectId/rename`
- Body: `{ name, workingDirectory? }`
- Behavior:
  - supports name change and/or workingDirectory change
  - if workingDirectory changes, existing project agent sessions are deleted and remapped lazily on future jobs
- Errors:
  - `404 not_found` for unknown project id
  - `409 duplicate_name` for name collisions
- Response: `{ status: "ok", project }`

### Delete project

- Route: `DELETE /api/projects/:projectId`
- Behavior:
  - rejects deletion if non-system-owned sessions are still assigned
  - returns `409 project_not_empty`
  - deletes hidden system-owned agent sessions mapped to the project
  - removes project metadata and broadcasts `project_deleted`
- Response: `{ status: "ok", projectId, unassignedSessionCount }`

### Move all project chats

- Route: `POST /api/projects/:projectId/chats/move-all`
- Body: `{ destination: "unassigned" | "archive" }`
- Behavior:
  - unassigns all project sessions from project metadata
  - when destination=`archive`, archives each session first
  - fails with `409 not_materialized_sessions` if archive target includes non-materialized sessions
  - broadcasts `session_project_updated` for changed sessions
- Response:
  - `{ status: "ok", movedSessionCount, archivedSessionCount, alreadyArchivedSessionCount, ... }`

### Delete all project chats

- Route: `POST /api/projects/:projectId/chats/delete-all`
- Body: `{}`
- Behavior:
  - hard-deletes sessions assigned to project
  - stale metadata references are detached
- Response:
  - `{ status: "ok", deletedSessionCount, skippedSessionCount, ... }`

### Assign or unassign a session from project

- Route: `POST /api/sessions/:sessionId/project`
- Body: `{ projectId: string | null }`
- Behavior:
  - existence-gated for session id
  - validates target project id
  - updates assignment metadata only (does not recreate thread or change cwd)
  - broadcasts `session_project_updated` on changes
- Errors:
  - `404 project_not_found`
  - `404 not_found` (session missing)
  - `410` deleted session
  - `403` system-owned session
- Response: `{ status: "ok", sessionId, projectId, previousProjectId }`

## Working Directory Invariant

- User chat cwd remains the thread's original cwd from `thread/start`.
- Project assignment is metadata-only and does not mutate an existing chat thread cwd.
- Hidden project agent sessions use `project.workingDirectory ?? env.WORKSPACE_ROOT` at creation.

## Repro Snippets

```bash
# Create a project
curl -sS -X POST http://127.0.0.1:3001/api/projects \
  -H 'content-type: application/json' \
  -d '{"name":"Test Project","workingDirectory":"/home/jmiller/projects/codex_manager"}'

# Assign a session
curl -sS -X POST http://127.0.0.1:3001/api/sessions/<sessionId>/project \
  -H 'content-type: application/json' \
  -d '{"projectId":"<projectId>"}'

# Move all chats back to unassigned
curl -sS -X POST http://127.0.0.1:3001/api/projects/<projectId>/chats/move-all \
  -H 'content-type: application/json' \
  -d '{"destination":"unassigned"}'
```

## Supervisor Notes

- Use this playbook to validate project assignment behavior and working-directory invariants through API responses.
- Confirm `session_project_updated` and `project_*` websocket events match expected project operations.
