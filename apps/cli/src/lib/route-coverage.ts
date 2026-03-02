export type CliRouteBinding = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  command: string;
  allowStatuses?: Array<number>;
};

export const CLI_ROUTE_BINDINGS: Array<CliRouteBinding> = [
  { method: "GET", path: "/api", command: "system info" },
  { method: "GET", path: "/api/account", command: "account get" },
  { method: "POST", path: "/api/account/login/cancel", command: "account login cancel" },
  { method: "POST", path: "/api/account/login/start", command: "account login start" },
  { method: "POST", path: "/api/account/logout", command: "account logout" },
  { method: "GET", path: "/api/account/rate-limits", command: "account rate-limits" },
  { method: "GET", path: "/api/agents/extensions", command: "agents extensions list" },
  { method: "POST", path: "/api/agents/extensions/reload", command: "agents extensions reload" },
  { method: "POST", path: "/api/approvals/:approvalId/decision", command: "approvals decide" },
  { method: "GET", path: "/api/apps", command: "apps list" },
  { method: "GET", path: "/api/capabilities", command: "system capabilities" },
  { method: "GET", path: "/api/collaboration/modes", command: "system collaboration-modes list" },
  { method: "POST", path: "/api/commands/exec", command: "runtime exec" },
  { method: "GET", path: "/api/config", command: "config get" },
  { method: "POST", path: "/api/config/batch", command: "config batch-set" },
  { method: "GET", path: "/api/config/requirements", command: "config requirements" },
  { method: "POST", path: "/api/config/value", command: "config set" },
  { method: "GET", path: "/api/features/experimental", command: "system features list" },
  { method: "POST", path: "/api/feedback", command: "feedback submit" },
  { method: "GET", path: "/api/health", command: "system health" },
  { method: "POST", path: "/api/mcp/reload", command: "mcp reload" },
  { method: "GET", path: "/api/mcp/servers", command: "mcp servers list" },
  { method: "POST", path: "/api/mcp/servers/:serverName/oauth/login", command: "mcp oauth login" },
  { method: "GET", path: "/api/models", command: "models list" },
  { method: "GET", path: "/api/orchestrator/jobs/:jobId", command: "orchestrator jobs get" },
  { method: "POST", path: "/api/orchestrator/jobs/:jobId/cancel", command: "orchestrator jobs cancel" },
  { method: "GET", path: "/api/projects", command: "projects list" },
  { method: "GET", path: "/api/projects/:projectId/agent-sessions", command: "projects agent-sessions list" },
  { method: "POST", path: "/api/projects", command: "projects create" },
  { method: "DELETE", path: "/api/projects/:projectId", command: "projects delete" },
  { method: "POST", path: "/api/projects/:projectId/chats/delete-all", command: "projects chats delete-all" },
  { method: "POST", path: "/api/projects/:projectId/chats/move-all", command: "projects chats move-all" },
  { method: "GET", path: "/api/projects/:projectId/orchestrator/jobs", command: "orchestrator jobs list" },
  { method: "POST", path: "/api/projects/:projectId/rename", command: "projects rename" },
  { method: "GET", path: "/api/sessions", command: "sessions list" },
  { method: "POST", path: "/api/sessions", command: "sessions create" },
  { method: "DELETE", path: "/api/sessions/:sessionId", command: "sessions delete" },
  { method: "GET", path: "/api/sessions/:sessionId", command: "sessions get" },
  {
    method: "POST",
    path: "/api/sessions/:sessionId/approval-policy",
    command: "sessions approval-policy set",
    allowStatuses: [200, 403, 404, 410]
  },
  {
    method: "GET",
    path: "/api/sessions/:sessionId/approvals",
    command: "sessions approvals list",
    allowStatuses: [200, 403, 410]
  },
  { method: "POST", path: "/api/sessions/:sessionId/archive", command: "sessions archive" },
  { method: "POST", path: "/api/sessions/:sessionId/background-terminals/clean", command: "sessions background-terminals clean" },
  { method: "POST", path: "/api/sessions/:sessionId/compact", command: "sessions compact" },
  { method: "POST", path: "/api/sessions/:sessionId/fork", command: "sessions fork" },
  {
    method: "POST",
    path: "/api/sessions/:sessionId/interrupt",
    command: "sessions interrupt",
    allowStatuses: [200, 403, 409, 410]
  },
  {
    method: "POST",
    path: "/api/sessions/:sessionId/messages",
    command: "sessions send",
    allowStatuses: [202, 400, 403, 404, 410]
  },
  { method: "POST", path: "/api/sessions/:sessionId/project", command: "sessions project set" },
  { method: "POST", path: "/api/sessions/:sessionId/rename", command: "sessions rename" },
  {
    method: "POST",
    path: "/api/sessions/:sessionId/resume",
    command: "sessions resume",
    allowStatuses: [200, 403, 410]
  },
  { method: "POST", path: "/api/sessions/:sessionId/review", command: "sessions review start" },
  { method: "POST", path: "/api/sessions/:sessionId/rollback", command: "sessions rollback" },
  {
    method: "GET",
    path: "/api/sessions/:sessionId/settings",
    command: "sessions settings get",
    allowStatuses: [200, 403, 404, 410]
  },
  {
    method: "POST",
    path: "/api/sessions/:sessionId/settings",
    command: "sessions settings set",
    allowStatuses: [200, 400, 403, 404, 410, 423]
  },
  {
    method: "DELETE",
    path: "/api/sessions/:sessionId/settings/:key",
    command: "sessions settings unset",
    allowStatuses: [200, 403, 404, 410, 423]
  },
  {
    method: "GET",
    path: "/api/sessions/:sessionId/session-controls",
    command: "sessions controls get",
    allowStatuses: [200, 403, 404, 410]
  },
  {
    method: "POST",
    path: "/api/sessions/:sessionId/session-controls",
    command: "sessions controls apply",
    allowStatuses: [200, 400, 403, 404, 410, 423]
  },
  {
    method: "POST",
    path: "/api/sessions/:sessionId/suggested-request",
    command: "sessions suggest-request run",
    allowStatuses: [200, 202, 400, 403, 404, 409, 410, 429]
  },
  {
    method: "POST",
    path: "/api/sessions/:sessionId/suggested-request/jobs",
    command: "sessions suggest-request enqueue",
    allowStatuses: [202, 400, 403, 404, 409, 410, 429]
  },
  {
    method: "POST",
    path: "/api/sessions/:sessionId/suggested-request/upsert",
    command: "sessions suggest-request upsert",
    allowStatuses: [200, 400, 403, 404, 410]
  },
  {
    method: "GET",
    path: "/api/sessions/:sessionId/tool-input",
    command: "sessions tool-input list",
    allowStatuses: [200, 403, 410]
  },
  {
    method: "GET",
    path: "/api/sessions/:sessionId/tool-calls",
    command: "sessions tool-calls list",
    allowStatuses: [200, 403, 410]
  },
  { method: "POST", path: "/api/sessions/:sessionId/transcript/upsert", command: "sessions transcript upsert" },
  { method: "POST", path: "/api/sessions/:sessionId/turns/:turnId/steer", command: "sessions steer" },
  { method: "POST", path: "/api/sessions/:sessionId/unarchive", command: "sessions unarchive" },
  { method: "GET", path: "/api/skills", command: "skills list" },
  { method: "POST", path: "/api/skills/config", command: "skills config set" },
  { method: "GET", path: "/api/skills/remote", command: "skills remote get" },
  { method: "POST", path: "/api/skills/remote", command: "skills remote set" },
  { method: "GET", path: "/api/stream", command: "stream events" },
  {
    method: "POST",
    path: "/api/tool-calls/:requestId/response",
    command: "tool-calls respond",
    allowStatuses: [200, 404, 409]
  },
  { method: "POST", path: "/api/tool-input/:requestId/decision", command: "tool-input decide" }
];

export const CLI_ROUTE_KEY_SET = new Set(CLI_ROUTE_BINDINGS.map((entry) => `${entry.method} ${entry.path}`));
