import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outputPath = path.join(root, "apps", "api", "openapi", "openapi.json");

const pathParam = (name, description) => ({
  in: "path",
  name,
  required: true,
  schema: { type: "string" },
  ...(description ? { description } : {})
});

const queryParam = (name, schema, description) => ({
  in: "query",
  name,
  required: false,
  schema,
  ...(description ? { description } : {})
});

const requestBody = (schema, required = true) => ({
  required,
  content: {
    "application/json": {
      schema
    }
  }
});

const responses = (entries) =>
  Object.fromEntries(
    entries.map(([status, value]) => {
      if (typeof value === "string") {
        return [String(status), { description: value }];
      }
      return [String(status), value];
    })
  );

const jsonResponse = (description, schema) => ({
  description,
  content: {
    "application/json": {
      schema
    }
  }
});

const schemaRef = (name) => ({
  $ref: `#/components/schemas/${name}`
});

const paginationParams = [
  queryParam("cursor", { type: "string" }, "Pagination cursor from a previous response."),
  queryParam("limit", { type: "integer", minimum: 1, maximum: 200 }, "Maximum rows to return.")
];

const reasoningEffortValues = ["none", "minimal", "low", "medium", "high", "xhigh"];
const reasoningEffortSchema = {
  type: "string",
  enum: reasoningEffortValues
};

const approvalPolicyValues = ["untrusted", "on-failure", "on-request", "never"];
const approvalPolicySchema = {
  type: "string",
  enum: approvalPolicyValues
};

const networkAccessValues = ["restricted", "enabled"];
const networkAccessSchema = {
  type: "string",
  enum: networkAccessValues
};

const filesystemSandboxValues = ["read-only", "workspace-write", "danger-full-access"];
const filesystemSandboxSchema = {
  type: "string",
  enum: filesystemSandboxValues
};

const settingsScopeValues = ["session", "default"];
const settingsScopeSchema = {
  type: "string",
  enum: settingsScopeValues
};

const suggestionStatusValues = ["streaming", "complete", "error", "canceled"];
const suggestionStatusSchema = {
  type: "string",
  enum: suggestionStatusValues
};

const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Codex Manager API",
    version: "1.0.0"
  },
  paths: {
    "/api/health": {
      get: {
        summary: "Health check",
        operationId: "getHealth",
        responses: {
          "200": {
            description: "Service health",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["status", "service", "timestamp", "codex", "auth"],
                  properties: {
                    status: { type: "string" },
                    service: { type: "string" },
                    timestamp: { type: "string", format: "date-time" },
                    codex: {
                      type: "object",
                      required: ["running", "pid", "initialized"],
                      properties: {
                        running: { type: "boolean" },
                        pid: { type: ["integer", "null"] },
                        initialized: { type: "boolean" }
                      }
                    },
                    auth: {
                      type: "object",
                      required: ["hasOpenAiApiKey", "codexHomeAuthFile", "likelyUnauthenticated"],
                      properties: {
                        hasOpenAiApiKey: { type: "boolean" },
                        codexHomeAuthFile: { type: "boolean" },
                        likelyUnauthenticated: { type: "boolean" }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api": {
      get: {
        summary: "API entry metadata",
        operationId: "getApiInfo",
        responses: responses([
          [200, "API metadata"]
        ])
      }
    },
    "/api/stream": {
      get: {
        summary: "Websocket stream endpoint",
        operationId: "connectEventStream",
        parameters: [
          queryParam("threadId", { type: "string" }, "Optional initial thread filter for websocket subscribe.")
        ],
        responses: responses([
          [101, "Switching protocols"],
          [400, "Invalid websocket upgrade request"]
        ])
      }
    },
    "/api/agents/extensions": {
      get: {
        summary: "List loaded agent extensions and runtime snapshot info",
        operationId: "listAgentExtensions",
        responses: responses([
          [200, "Extension runtime snapshot"],
          [401, "Authentication required"],
          [403, "Forbidden"]
        ])
      }
    },
    "/api/agents/extensions/reload": {
      post: {
        summary: "Reload agent extensions",
        operationId: "reloadAgentExtensions",
        requestBody: requestBody({ type: "object", additionalProperties: true }, false),
        responses: responses([
          [200, "Reload completed"],
          [400, "Reload failed"],
          [401, "Authentication required"],
          [403, "Forbidden"],
          [409, "Reload already in progress"]
        ])
      }
    },
    "/api/capabilities": {
      get: {
        summary: "Read probed Codex capabilities",
        operationId: "getCapabilities",
        parameters: [queryParam("refresh", { type: "boolean" }, "When true, refresh capability probes before returning.")],
        responses: responses([
          [200, "Capabilities state"]
        ])
      }
    },
    "/api/features/experimental": {
      get: {
        summary: "List experimental features",
        operationId: "listExperimentalFeatures",
        parameters: paginationParams,
        responses: responses([
          [200, "Feature list"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/collaboration/modes": {
      get: {
        summary: "List collaboration modes",
        operationId: "listCollaborationModes",
        parameters: paginationParams,
        responses: responses([
          [200, "Collaboration mode list"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/apps": {
      get: {
        summary: "List configured apps/connectors",
        operationId: "listApps",
        parameters: [
          ...paginationParams,
          queryParam("threadId", { type: "string" }, "Optional thread id for capability-scoped listing."),
          queryParam("forceRefetch", { type: "boolean" }, "When true, force refresh from Codex.")
        ],
        responses: responses([
          [200, "App list"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/skills": {
      get: {
        summary: "List local skills",
        operationId: "listSkills",
        parameters: [
          queryParam("forceReload", { type: "boolean" }, "When true, force reload from disk."),
          queryParam("cwd", { type: "string" }, "Optional workspace to scope skill discovery.")
        ],
        responses: responses([
          [200, "Skill list"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/skills/config": {
      post: {
        summary: "Write local skill config",
        operationId: "writeSkillConfig",
        requestBody: requestBody({
          type: "object",
          required: ["path", "enabled"],
          properties: {
            path: { type: "string" },
            enabled: { type: "boolean" }
          }
        }),
        responses: responses([
          [200, "Skill config written"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/skills/remote": {
      get: {
        summary: "Read remote skill settings",
        operationId: "readRemoteSkills",
        responses: responses([
          [200, "Remote skill settings"],
          [500, "Upstream service error"],
          [501, "Method unavailable"]
        ])
      },
      post: {
        summary: "Write remote skill settings",
        operationId: "writeRemoteSkills",
        requestBody: requestBody({
          type: "object",
          required: ["hazelnutId", "isPreload"],
          properties: {
            hazelnutId: { type: "string" },
            isPreload: { type: "boolean" }
          }
        }),
        responses: responses([
          [200, "Remote settings written"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/mcp/reload": {
      post: {
        summary: "Reload MCP configuration",
        operationId: "reloadMcpConfig",
        requestBody: requestBody({ type: "object", additionalProperties: true }, false),
        responses: responses([
          [200, "Reload triggered"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/mcp/servers/{serverName}/oauth/login": {
      post: {
        summary: "Start MCP OAuth login",
        operationId: "startMcpOauthLogin",
        parameters: [pathParam("serverName", "MCP server name")],
        requestBody: requestBody(
          {
            type: "object",
            properties: {
              scopes: { type: "array", items: { type: "string" } },
              timeoutSecs: { type: "integer", minimum: 1 }
            }
          },
          false
        ),
        responses: responses([
          [200, "OAuth login started"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/account": {
      get: {
        summary: "Read account state",
        operationId: "readAccount",
        responses: responses([
          [200, "Account details"],
          [401, "Authentication required"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/account/login/start": {
      post: {
        summary: "Start account login",
        operationId: "startAccountLogin",
        requestBody: requestBody({
          oneOf: [
            {
              type: "object",
              required: ["type", "apiKey"],
              properties: {
                type: { type: "string", enum: ["apiKey"] },
                apiKey: { type: "string" }
              }
            },
            {
              type: "object",
              required: ["type"],
              properties: {
                type: { type: "string", enum: ["chatgpt"] }
              }
            },
            {
              type: "object",
              required: ["type", "accessToken", "chatgptAccountId"],
              properties: {
                type: { type: "string", enum: ["chatgptAuthTokens"] },
                accessToken: { type: "string" },
                chatgptAccountId: { type: "string" },
                chatgptPlanType: { type: "string" }
              }
            }
          ]
        }),
        responses: responses([
          [200, "Login started"],
          [400, "Invalid login payload"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/account/login/cancel": {
      post: {
        summary: "Cancel account login",
        operationId: "cancelAccountLogin",
        requestBody: requestBody({
          type: "object",
          required: ["loginId"],
          properties: {
            loginId: { type: "string" }
          }
        }),
        responses: responses([
          [200, "Login canceled"],
          [404, "Login id not found"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/account/logout": {
      post: {
        summary: "Logout account",
        operationId: "logoutAccount",
        requestBody: requestBody({ type: "object", additionalProperties: true }, false),
        responses: responses([
          [200, "Logged out"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/account/rate-limits": {
      get: {
        summary: "Read account rate limits",
        operationId: "readAccountRateLimits",
        responses: responses([
          [200, "Rate limits"],
          [401, "Authentication required"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/config": {
      get: {
        summary: "Read Codex config",
        operationId: "readConfig",
        parameters: [
          queryParam("cwd", { type: "string" }, "Workspace root for config resolution."),
          queryParam("includeLayers", { type: "boolean" }, "Include layered config metadata.")
        ],
        responses: responses([
          [200, "Config payload"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/config/requirements": {
      get: {
        summary: "Read config requirements",
        operationId: "readConfigRequirements",
        responses: responses([
          [200, "Config requirement payload"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/config/value": {
      post: {
        summary: "Write single config value",
        operationId: "writeConfigValue",
        requestBody: requestBody({
          type: "object",
          required: ["keyPath", "mergeStrategy", "value"],
          properties: {
            keyPath: { type: "array", items: { type: "string" }, minItems: 1 },
            mergeStrategy: { type: "string", enum: ["replace", "upsert"] },
            value: {},
            expectedVersion: { type: "integer", minimum: 0 },
            filePath: { type: "string" }
          }
        }),
        responses: responses([
          [200, "Config value written"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/config/batch": {
      post: {
        summary: "Write config batch edits",
        operationId: "writeConfigBatch",
        requestBody: requestBody({
          type: "object",
          required: ["edits"],
          properties: {
            edits: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["keyPath", "mergeStrategy", "value"],
                properties: {
                  keyPath: { type: "array", items: { type: "string" }, minItems: 1 },
                  mergeStrategy: { type: "string", enum: ["replace", "upsert"] },
                  value: {}
                }
              }
            },
            expectedVersion: { type: "integer", minimum: 0 },
            filePath: { type: "string" }
          }
        }),
        responses: responses([
          [200, "Config edits written"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/commands/exec": {
      post: {
        summary: "Execute one-off command",
        operationId: "executeCommand",
        requestBody: requestBody({
          type: "object",
          required: ["command"],
          properties: {
            command: { type: "array", minItems: 1, items: { type: "string" } },
            cwd: { type: "string" },
            timeoutMs: { type: "integer", minimum: 1 }
          }
        }),
        responses: responses([
          [200, "Command result"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/feedback": {
      post: {
        summary: "Upload feedback to Codex",
        operationId: "uploadFeedback",
        requestBody: requestBody({
          type: "object",
          required: ["classification", "includeLogs"],
          properties: {
            classification: { type: "string" },
            includeLogs: { type: "boolean" },
            reason: { type: "string" },
            threadId: { type: "string" }
          }
        }),
        responses: responses([
          [200, "Feedback accepted"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/models": {
      get: {
        summary: "List available models",
        operationId: "listModels",
        parameters: paginationParams,
        responses: responses([
          [200, "Model list"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/mcp/servers": {
      get: {
        summary: "List MCP server statuses",
        operationId: "listMcpServers",
        parameters: paginationParams,
        responses: responses([
          [200, "MCP server statuses"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/orchestrator/jobs/{jobId}": {
      get: {
        summary: "Read one orchestrator queue job",
        operationId: "getOrchestratorJob",
        parameters: [pathParam("jobId", "Queue job id")],
        responses: responses([
          [200, "Queue job"],
          [404, "Job not found"],
          [503, "Queue unavailable"]
        ])
      }
    },
    "/api/projects/{projectId}/orchestrator/jobs": {
      get: {
        summary: "List orchestrator queue jobs by project",
        operationId: "listProjectOrchestratorJobs",
        parameters: [
          pathParam("projectId", "Project id"),
          queryParam(
            "state",
            { type: "string", enum: ["queued", "running", "completed", "failed", "canceled"] },
            "Optional state filter"
          )
        ],
        responses: responses([
          [200, "Project queue jobs"],
          [503, "Queue unavailable"]
        ])
      }
    },
    "/api/orchestrator/jobs/{jobId}/cancel": {
      post: {
        summary: "Cancel one orchestrator queue job",
        operationId: "cancelOrchestratorJob",
        parameters: [pathParam("jobId", "Queue job id")],
        requestBody: requestBody({ type: "object", additionalProperties: true }, false),
        responses: responses([
          [200, "Queue job canceled"],
          [404, "Job not found"],
          [409, "Job already terminal"],
          [503, "Queue unavailable"]
        ])
      }
    },
    "/api/projects": {
      get: {
        summary: "List projects",
        operationId: "listProjects",
        responses: responses([
          [200, "Project list"]
        ])
      },
      post: {
        summary: "Create a project",
        operationId: "createProject",
        requestBody: requestBody({
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 }
          }
        }),
        responses: responses([
          [200, "Project created"],
          [409, "Duplicate project name"]
        ])
      }
    },
    "/api/projects/{projectId}/rename": {
      post: {
        summary: "Rename a project",
        operationId: "renameProject",
        parameters: [pathParam("projectId", "Project id")],
        requestBody: requestBody({
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 }
          }
        }),
        responses: responses([
          [200, "Project renamed"],
          [404, "Project not found"],
          [409, "Duplicate project name"]
        ])
      }
    },
    "/api/projects/{projectId}": {
      delete: {
        summary: "Delete a project",
        operationId: "deleteProject",
        parameters: [pathParam("projectId", "Project id")],
        responses: responses([
          [200, "Project deleted"],
          [404, "Project not found"],
          [409, "Project must be empty before deletion"]
        ])
      }
    },
    "/api/projects/{projectId}/agent-sessions": {
      get: {
        summary: "List project-owned agent sessions",
        operationId: "listProjectAgentSessions",
        parameters: [pathParam("projectId", "Project id")],
        responses: responses([
          [200, "Project agent sessions"],
          [404, "Project not found"]
        ])
      }
    },
    "/api/projects/{projectId}/chats/move-all": {
      post: {
        summary: "Move all project chats",
        operationId: "moveProjectChats",
        parameters: [pathParam("projectId", "Project id")],
        requestBody: requestBody({
          type: "object",
          required: ["destination"],
          properties: {
            destination: { type: "string", enum: ["unassigned", "archive"] }
          }
        }),
        responses: responses([
          [200, "Chats moved"],
          [404, "Project not found"],
          [409, "Archive precondition failed"]
        ])
      }
    },
    "/api/projects/{projectId}/chats/delete-all": {
      post: {
        summary: "Delete all project chats",
        operationId: "deleteProjectChats",
        parameters: [pathParam("projectId", "Project id")],
        requestBody: requestBody({ type: "object", additionalProperties: true }, false),
        responses: responses([
          [200, "Chats deleted"],
          [404, "Project not found"]
        ])
      }
    },
    "/api/sessions": {
      get: {
        summary: "List sessions",
        operationId: "listSessions",
        parameters: [
          queryParam("archived", { type: "boolean" }, "When true, list archived sessions."),
          ...paginationParams
        ],
        responses: responses([
          [200, "Session list"]
        ])
      },
      post: {
        summary: "Create a session",
        operationId: "createSession",
        requestBody: requestBody(schemaRef("CreateSessionRequest"), false),
        responses: responses([
          [200, jsonResponse("Session created", schemaRef("CreateSessionResponse"))]
        ])
      }
    },
    "/api/sessions/{sessionId}": {
      get: {
        summary: "Read a session transcript",
        operationId: "readSession",
        parameters: [pathParam("sessionId", "Session id")],
        responses: responses([
          [200, jsonResponse("Session detail", schemaRef("ReadSessionResponse"))],
          [410, jsonResponse("Session deleted", schemaRef("DeletedSessionPayload"))]
        ])
      },
      delete: {
        summary: "Permanently delete a session",
        operationId: "deleteSession",
        parameters: [pathParam("sessionId", "Session id")],
        responses: responses([
          [200, "Session deleted"],
          [404, "Session not found"],
          [410, "Session already deleted"]
        ])
      }
    },
    "/api/sessions/{sessionId}/transcript/upsert": {
      post: {
        summary: "Upsert one supplemental transcript entry",
        operationId: "upsertSessionTranscriptEntry",
        parameters: [pathParam("sessionId", "Session id")],
        requestBody: requestBody({
          type: "object",
          required: ["messageId", "turnId", "role", "type", "content", "status"],
          properties: {
            messageId: { type: "string", minLength: 1 },
            turnId: { type: "string", minLength: 1 },
            role: { type: "string", enum: ["user", "assistant", "system"] },
            type: { type: "string", minLength: 1 },
            content: { type: "string" },
            status: { type: "string", enum: ["streaming", "complete", "canceled", "error"] },
            details: { type: "string" },
            startedAt: { type: "integer", minimum: 0 },
            completedAt: { type: "integer", minimum: 0 }
          }
        }),
        responses: responses([
          [200, "Transcript entry upserted"],
          [404, "Session not found"],
          [410, "Session deleted"]
        ])
      }
    },
    "/api/sessions/{sessionId}/fork": {
      post: {
        summary: "Fork a session",
        operationId: "forkSession",
        parameters: [pathParam("sessionId", "Session id")],
        requestBody: requestBody({ type: "object", additionalProperties: true }, false),
        responses: responses([
          [200, "Session forked"],
          [410, "Session deleted"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/sessions/{sessionId}/compact": {
      post: {
        summary: "Start context compaction",
        operationId: "compactSession",
        parameters: [pathParam("sessionId", "Session id")],
        requestBody: requestBody({ type: "object", additionalProperties: true }, false),
        responses: responses([
          [200, "Compaction started"],
          [410, "Session deleted"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/sessions/{sessionId}/rollback": {
      post: {
        summary: "Rollback turns in a session",
        operationId: "rollbackSession",
        parameters: [pathParam("sessionId", "Session id")],
        requestBody: requestBody(
          {
            type: "object",
            properties: {
              numTurns: { type: "integer", minimum: 1, default: 1 }
            }
          },
          false
        ),
        responses: responses([
          [200, "Session rolled back"],
          [400, "Invalid rollback payload"],
          [409, "Rollback not allowed in current state"],
          [410, "Session deleted"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/sessions/{sessionId}/background-terminals/clean": {
      post: {
        summary: "Clean background terminals",
        operationId: "cleanBackgroundTerminals",
        parameters: [pathParam("sessionId", "Session id")],
        requestBody: requestBody({ type: "object", additionalProperties: true }, false),
        responses: responses([
          [200, "Background terminals cleaned"],
          [410, "Session deleted"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/sessions/{sessionId}/review": {
      post: {
        summary: "Start review mode",
        operationId: "startReview",
        parameters: [pathParam("sessionId", "Session id")],
        requestBody: requestBody(
          {
            type: "object",
            properties: {
              delivery: { type: "string", enum: ["inline", "detached"] },
              targetType: { type: "string", enum: ["uncommittedChanges", "baseBranch", "commit", "custom"] },
              branch: { type: "string" },
              sha: { type: "string" },
              title: { type: "string" },
              instructions: { type: "string" }
            }
          },
          false
        ),
        responses: responses([
          [200, "Review started"],
          [410, "Session deleted"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/sessions/{sessionId}/turns/{turnId}/steer": {
      post: {
        summary: "Steer an active turn",
        operationId: "steerTurn",
        parameters: [pathParam("sessionId", "Session id"), pathParam("turnId", "Turn id")],
        requestBody: requestBody({
          type: "object",
          required: ["input"],
          properties: {
            input: { type: "string", minLength: 1 }
          }
        }),
        responses: responses([
          [200, "Turn steered"],
          [400, "Invalid steer payload"],
          [410, "Session deleted"],
          [501, "Method unavailable"]
        ])
      }
    },
    "/api/sessions/{sessionId}/rename": {
      post: {
        summary: "Rename a session",
        operationId: "renameSession",
        parameters: [pathParam("sessionId", "Session id")],
        requestBody: requestBody({
          type: "object",
          required: ["title"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 200 }
          }
        }),
        responses: responses([
          [200, "Session renamed"]
        ])
      }
    },
    "/api/sessions/{sessionId}/archive": {
      post: {
        summary: "Archive a session",
        operationId: "archiveSession",
        parameters: [pathParam("sessionId", "Session id")],
        requestBody: requestBody({ type: "object", additionalProperties: true }, false),
        responses: responses([
          [200, "Session archived"],
          [409, "Session not materialized"],
          [410, "Session deleted"]
        ])
      }
    },
    "/api/sessions/{sessionId}/unarchive": {
      post: {
        summary: "Unarchive a session",
        operationId: "unarchiveSession",
        parameters: [pathParam("sessionId", "Session id")],
        requestBody: requestBody({ type: "object", additionalProperties: true }, false),
        responses: responses([
          [200, "Session unarchived"]
        ])
      }
    },
    "/api/sessions/{sessionId}/approvals": {
      get: {
        summary: "List pending approvals for a session",
        operationId: "listSessionApprovals",
        parameters: [pathParam("sessionId", "Session id")],
        responses: responses([
          [200, "Pending approvals"],
          [410, "Session deleted"]
        ])
      }
    },
    "/api/sessions/{sessionId}/tool-input": {
      get: {
        summary: "List pending tool-input requests for a session",
        operationId: "listSessionToolInput",
        parameters: [pathParam("sessionId", "Session id")],
        responses: responses([
          [200, "Pending tool-input requests"],
          [410, "Session deleted"]
        ])
      }
    },
    "/api/sessions/{sessionId}/tool-calls": {
      get: {
        summary: "List pending dynamic tool-call requests for a session",
        operationId: "listSessionToolCalls",
        parameters: [pathParam("sessionId", "Session id")],
        responses: responses([
          [200, jsonResponse("Pending dynamic tool-call requests", schemaRef("ListSessionToolCallsResponse"))],
          [403, jsonResponse("System-owned session", schemaRef("SystemSessionError"))],
          [410, "Session deleted"]
        ])
      }
    },
    "/api/sessions/{sessionId}/session-controls": {
      get: {
        summary: "Read session/default controls tuple",
        operationId: "getSessionControls",
        parameters: [pathParam("sessionId", "Session id")],
        responses: responses([
          [200, "Session controls"],
          [404, "Session not found"],
          [410, "Session deleted"]
        ])
      },
      post: {
        summary: "Apply session/default controls tuple",
        operationId: "applySessionControls",
        parameters: [pathParam("sessionId", "Session id")],
        requestBody: requestBody({
          type: "object",
          required: ["scope", "controls"],
          properties: {
            scope: { type: "string", enum: ["session", "default"] },
            controls: {
              type: "object",
              required: ["model", "approvalPolicy", "networkAccess", "filesystemSandbox"],
              properties: {
                model: { type: ["string", "null"] },
                approvalPolicy: { type: "string", enum: ["untrusted", "on-failure", "on-request", "never"] },
                networkAccess: { type: "string", enum: ["restricted", "enabled"] },
                filesystemSandbox: { type: "string", enum: ["read-only", "workspace-write", "danger-full-access"] },
                settings: { type: "object", additionalProperties: true }
              }
            },
            actor: { type: "string" },
            source: { type: "string" }
          }
        }),
        responses: responses([
          [200, "Session controls applied"],
          [400, "Invalid request"],
          [404, "Session not found"],
          [410, "Session deleted"],
          [423, "Default controls locked"]
        ])
      }
    },
    "/api/sessions/{sessionId}/settings": {
      get: {
        summary: "Read session settings",
        operationId: "getSessionSettings",
        parameters: [
          pathParam("sessionId", "Session id"),
          queryParam("scope", settingsScopeSchema, "Settings scope"),
          queryParam("key", { type: "string" }, "Optional top-level settings key")
        ],
        responses: responses([
          [200, jsonResponse("Session settings", schemaRef("SessionSettingsGetResponse"))],
          [403, jsonResponse("System session forbidden", schemaRef("SystemSessionError"))],
          [404, jsonResponse("Session not found", schemaRef("SessionNotFoundPayload"))],
          [410, jsonResponse("Session deleted", schemaRef("DeletedSessionPayload"))]
        ])
      },
      post: {
        summary: "Upsert session settings",
        operationId: "setSessionSettings",
        parameters: [pathParam("sessionId", "Session id")],
        requestBody: requestBody(schemaRef("SetSessionSettingsRequest")),
        responses: responses([
          [200, jsonResponse("Session settings updated", schemaRef("SessionSettingsSetResponse"))],
          [400, jsonResponse("Invalid request", schemaRef("ApiValidationError"))],
          [403, jsonResponse("System session forbidden", schemaRef("SystemSessionError"))],
          [404, jsonResponse("Session not found", schemaRef("SessionNotFoundPayload"))],
          [410, jsonResponse("Session deleted", schemaRef("DeletedSessionPayload"))],
          [423, jsonResponse("Default settings locked", schemaRef("SessionSettingsLockedResponse"))]
        ])
      }
    },
    "/api/sessions/{sessionId}/settings/{key}": {
      delete: {
        summary: "Delete one top-level session setting",
        operationId: "deleteSessionSetting",
        parameters: [
          pathParam("sessionId", "Session id"),
          pathParam("key", "Top-level settings key"),
          queryParam("scope", settingsScopeSchema, "Settings scope"),
          queryParam("actor", { type: "string" }, "Optional audit actor"),
          queryParam("source", { type: "string" }, "Optional audit source")
        ],
        responses: responses([
          [200, jsonResponse("Session setting deleted or unchanged", schemaRef("SessionSettingsDeleteResponse"))],
          [403, jsonResponse("System session forbidden", schemaRef("SystemSessionError"))],
          [404, jsonResponse("Session not found", schemaRef("SessionNotFoundPayload"))],
          [410, jsonResponse("Session deleted", schemaRef("DeletedSessionPayload"))],
          [423, jsonResponse("Default settings locked", schemaRef("SessionSettingsLockedResponse"))]
        ])
      }
    },
    "/api/sessions/{sessionId}/resume": {
      post: {
        summary: "Resume a session",
        operationId: "resumeSession",
        parameters: [pathParam("sessionId", "Session id")],
        requestBody: requestBody({ type: "object", additionalProperties: true }, false),
        responses: responses([
          [200, "Session resumed"],
          [410, "Session deleted"]
        ])
      }
    },
    "/api/sessions/{sessionId}/approval-policy": {
      post: {
        summary: "Set session approval policy",
        operationId: "setSessionApprovalPolicy",
        parameters: [pathParam("sessionId", "Session id")],
        requestBody: requestBody({
          type: "object",
          required: ["approvalPolicy"],
          properties: {
            approvalPolicy: approvalPolicySchema
          }
        }),
        responses: responses([
          [200, jsonResponse("Approval policy updated", schemaRef("SessionApprovalPolicyResponse"))],
          [403, jsonResponse("System session forbidden", schemaRef("SystemSessionError"))],
          [404, jsonResponse("Session not found", schemaRef("SessionNotFoundPayload"))],
          [410, jsonResponse("Session deleted", schemaRef("DeletedSessionPayload"))]
        ])
      }
    },
    "/api/sessions/{sessionId}/suggested-request/jobs": {
      post: {
        summary: "Enqueue suggested-request generation job",
        operationId: "enqueueSuggestedSessionRequest",
        parameters: [pathParam("sessionId", "Session id")],
        requestBody: requestBody(schemaRef("SuggestedRequestBody"), false),
        responses: responses([
          [202, jsonResponse("Suggested request queued", schemaRef("SuggestedRequestQueuedResponse"))],
          [400, jsonResponse("Invalid request", schemaRef("ApiValidationError"))],
          [403, jsonResponse("System session forbidden", schemaRef("SystemSessionError"))],
          [404, jsonResponse("Session not found", schemaRef("SessionNotFoundPayload"))],
          [409, jsonResponse("Queue job conflict", schemaRef("QueueErrorResponse"))],
          [410, jsonResponse("Session deleted", schemaRef("DeletedSessionPayload"))],
          [429, jsonResponse("Queue full", schemaRef("QueueErrorResponse"))],
          [503, jsonResponse("Queue unavailable", schemaRef("QueueErrorResponse"))]
        ])
      }
    },
    "/api/sessions/{sessionId}/suggested-request": {
      post: {
        summary: "Generate a suggested user request for a session",
        operationId: "suggestSessionRequest",
        parameters: [pathParam("sessionId", "Session id")],
        requestBody: requestBody(schemaRef("SuggestedRequestBody"), false),
        responses: responses([
          [200, jsonResponse("Suggested request generated", schemaRef("SuggestSessionRequestSuccessResponse"))],
          [202, jsonResponse("Suggested request queued", schemaRef("SuggestedRequestQueuedResponse"))],
          [400, jsonResponse("Invalid request", schemaRef("ApiValidationError"))],
          [403, jsonResponse("System session forbidden", schemaRef("SystemSessionError"))],
          [404, jsonResponse("Session not found", schemaRef("SessionNotFoundPayload"))],
          [409, jsonResponse("No available context for suggestion", schemaRef("SuggestSessionRequestNoContextResponse"))],
          [410, jsonResponse("Session deleted", schemaRef("DeletedSessionPayload"))],
          [429, jsonResponse("Queue full", schemaRef("QueueErrorResponse"))],
          [503, jsonResponse("Queue unavailable", schemaRef("QueueErrorResponse"))]
        ])
      }
    },
    "/api/sessions/{sessionId}/suggested-request/upsert": {
      post: {
        summary: "Upsert suggested-request runtime state",
        operationId: "upsertSuggestedSessionRequest",
        parameters: [pathParam("sessionId", "Session id")],
        requestBody: requestBody(schemaRef("SuggestedRequestUpsertBody")),
        responses: responses([
          [200, jsonResponse("Suggested request state updated", schemaRef("SuggestedRequestUpsertResponse"))],
          [400, jsonResponse("Invalid request", schemaRef("SuggestedRequestUpsertErrorResponse"))],
          [403, jsonResponse("System session forbidden", schemaRef("SystemSessionError"))],
          [404, jsonResponse("Session not found", schemaRef("SessionNotFoundPayload"))],
          [410, jsonResponse("Session deleted", schemaRef("DeletedSessionPayload"))]
        ])
      }
    },
    "/api/sessions/{sessionId}/project": {
      post: {
        summary: "Assign or unassign a session project",
        operationId: "setSessionProject",
        parameters: [pathParam("sessionId", "Session id")],
        requestBody: requestBody({
          type: "object",
          required: ["projectId"],
          properties: {
            projectId: {
              type: ["string", "null"],
              minLength: 1,
              maxLength: 200
            }
          }
        }),
        responses: responses([
          [200, "Session project updated"],
          [404, "Session or project not found"],
          [410, "Session deleted"]
        ])
      }
    },
    "/api/sessions/{sessionId}/messages": {
      post: {
        summary: "Start a turn in a session",
        operationId: "sendSessionMessage",
        parameters: [pathParam("sessionId", "Session id")],
        requestBody: requestBody(schemaRef("SendSessionMessageRequest")),
        responses: responses([
          [202, jsonResponse("Turn accepted", schemaRef("SendSessionMessageAcceptedResponse"))],
          [400, jsonResponse("Invalid request", schemaRef("ApiValidationError"))],
          [403, jsonResponse("System session forbidden", schemaRef("SystemSessionError"))],
          [404, jsonResponse("Session not found", schemaRef("SessionNotFoundPayload"))],
          [410, jsonResponse("Session deleted", schemaRef("DeletedSessionPayload"))]
        ])
      }
    },
    "/api/sessions/{sessionId}/interrupt": {
      post: {
        summary: "Interrupt active turn",
        operationId: "interruptSessionTurn",
        parameters: [pathParam("sessionId", "Session id")],
        requestBody: requestBody(
          {
            type: "object",
            properties: {
              turnId: { type: "string" }
            }
          },
          false
        ),
        responses: responses([
          [200, "Turn interrupted"],
          [409, "No active turn"],
          [410, "Session deleted"]
        ])
      }
    },
    "/api/tool-input/{requestId}/decision": {
      post: {
        summary: "Submit tool-input decision",
        operationId: "decideToolInput",
        parameters: [pathParam("requestId", "Tool-input request id")],
        requestBody: requestBody(schemaRef("ToolInputDecisionRequest")),
        responses: responses([
          [200, jsonResponse("Decision submitted", schemaRef("ToolInputDecisionSuccessResponse"))],
          [404, jsonResponse("Request not found", schemaRef("ToolInputDecisionNotFoundResponse"))],
          [500, jsonResponse("Decision failed", schemaRef("ToolInputDecisionErrorResponse"))]
        ])
      }
    },
    "/api/tool-calls/{requestId}/response": {
      post: {
        summary: "Submit dynamic tool-call response",
        operationId: "respondToolCall",
        parameters: [pathParam("requestId", "Dynamic tool-call request id")],
        requestBody: requestBody(schemaRef("ToolCallResponseRequest")),
        responses: responses([
          [200, jsonResponse("Response submitted", schemaRef("ToolCallResponseSuccessResponse"))],
          [404, jsonResponse("Request not found", schemaRef("ToolCallResponseNotFoundResponse"))],
          [409, jsonResponse("Response in flight", schemaRef("ToolCallResponseConflictResponse"))],
          [500, jsonResponse("Response failed", schemaRef("ToolCallResponseErrorResponse"))]
        ])
      }
    },
    "/api/approvals/{approvalId}/decision": {
      post: {
        summary: "Submit approval decision",
        operationId: "decideApproval",
        parameters: [pathParam("approvalId", "Approval id")],
        requestBody: requestBody(schemaRef("ApprovalDecisionRequest")),
        responses: responses([
          [200, jsonResponse("Decision submitted", schemaRef("ApprovalDecisionSuccessResponse"))],
          [404, jsonResponse("Approval not found", schemaRef("ApprovalDecisionNotFoundResponse"))],
          [409, jsonResponse("Approval reconciled", schemaRef("ApprovalDecisionReconciledResponse"))],
          [500, jsonResponse("Decision failed", schemaRef("ApprovalDecisionErrorResponse"))]
        ])
      }
    }
  },
  components: {
    schemas: {
      ApprovalPolicy: approvalPolicySchema,
      NetworkAccess: networkAccessSchema,
      FilesystemSandbox: filesystemSandboxSchema,
      SessionSettingsScope: settingsScopeSchema,
      SessionControlsTuple: {
        type: "object",
        required: ["model", "approvalPolicy", "networkAccess", "filesystemSandbox"],
        properties: {
          model: { type: ["string", "null"] },
          approvalPolicy: schemaRef("ApprovalPolicy"),
          networkAccess: schemaRef("NetworkAccess"),
          filesystemSandbox: schemaRef("FilesystemSandbox"),
          settings: {
            type: "object",
            additionalProperties: true
          }
        }
      },
      SessionSummary: {
        type: "object",
        required: [
          "sessionId",
          "title",
          "materialized",
          "modelProvider",
          "approvalPolicy",
          "sessionControls",
          "createdAt",
          "updatedAt",
          "cwd",
          "source",
          "projectId"
        ],
        properties: {
          sessionId: { type: "string" },
          title: { type: "string" },
          materialized: { type: "boolean" },
          modelProvider: { type: "string" },
          approvalPolicy: schemaRef("ApprovalPolicy"),
          sessionControls: schemaRef("SessionControlsTuple"),
          createdAt: { type: "number" },
          updatedAt: { type: "number" },
          cwd: { type: "string" },
          source: { type: "string" },
          projectId: { type: ["string", "null"] }
        }
      },
      CodexThreadItem: {
        type: "object",
        required: ["type", "id"],
        properties: {
          type: { type: "string" },
          id: { type: "string" }
        },
        additionalProperties: true
      },
      CodexTurn: {
        type: "object",
        required: ["id", "status", "items"],
        properties: {
          id: { type: "string" },
          status: { type: "string" },
          items: {
            type: "array",
            items: schemaRef("CodexThreadItem")
          },
          startedAt: {},
          startTime: {},
          completedAt: {},
          endTime: {}
        },
        additionalProperties: true
      },
      CodexThread: {
        type: "object",
        required: ["id", "preview", "modelProvider", "createdAt", "updatedAt", "cwd", "source"],
        properties: {
          id: { type: "string" },
          preview: { type: "string" },
          modelProvider: { type: "string" },
          createdAt: { type: "number" },
          updatedAt: { type: "number" },
          cwd: { type: "string" },
          source: {},
          turns: {
            type: "array",
            items: schemaRef("CodexTurn")
          }
        },
        additionalProperties: true
      },
      TranscriptEntry: {
        type: "object",
        required: ["messageId", "turnId", "role", "type", "content", "status"],
        properties: {
          messageId: { type: "string" },
          turnId: { type: "string" },
          role: { type: "string", enum: ["user", "assistant", "system"] },
          type: { type: "string" },
          content: { type: "string" },
          details: { type: ["string", "null"] },
          startedAt: { type: "integer" },
          completedAt: { type: "integer" },
          status: { type: "string", enum: ["streaming", "complete", "canceled", "error"] }
        },
        additionalProperties: true
      },
      DeletedSessionPayload: {
        type: "object",
        required: ["status", "sessionId", "message", "deletedAt"],
        properties: {
          status: { type: "string", enum: ["deleted"] },
          sessionId: { type: "string" },
          title: { type: ["string", "null"] },
          message: { type: "string" },
          deletedAt: { type: "string", format: "date-time" }
        }
      },
      SessionNotFoundPayload: {
        type: "object",
        required: ["status", "sessionId"],
        properties: {
          status: { type: "string", enum: ["not_found"] },
          sessionId: { type: "string" }
        }
      },
      SystemSessionError: {
        type: "object",
        required: ["status", "code", "sessionId", "message"],
        properties: {
          status: { type: "string", enum: ["error"] },
          code: { type: "string", enum: ["system_session"] },
          sessionId: { type: "string" },
          message: { type: "string" }
        }
      },
      ApiValidationError: {
        type: "object",
        required: ["status", "code", "message"],
        properties: {
          status: { type: "string", enum: ["error"] },
          code: { type: "string" },
          message: { type: "string" },
          issues: {
            type: "array",
            items: {}
          }
        },
        additionalProperties: true
      },
      CreateSessionRequest: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          model: { type: "string" },
          approvalPolicy: schemaRef("ApprovalPolicy"),
          networkAccess: schemaRef("NetworkAccess"),
          filesystemSandbox: schemaRef("FilesystemSandbox")
        }
      },
      SendSessionMessageRequest: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", minLength: 1 },
          model: { type: "string" },
          effort: reasoningEffortSchema,
          approvalPolicy: schemaRef("ApprovalPolicy"),
          networkAccess: schemaRef("NetworkAccess"),
          filesystemSandbox: schemaRef("FilesystemSandbox")
        }
      },
      SuggestedRequestBody: {
        type: "object",
        properties: {
          model: { type: "string" },
          effort: reasoningEffortSchema,
          draft: { type: "string", minLength: 1, maxLength: 4000 }
        }
      },
      SuggestedRequestUpsertBody: {
        type: "object",
        required: ["requestKey", "status"],
        properties: {
          requestKey: { type: "string", minLength: 1 },
          status: suggestionStatusSchema,
          suggestion: { type: "string", minLength: 1, maxLength: 8000 },
          error: { type: "string", minLength: 1, maxLength: 4000 }
        }
      },
      ApprovalDecisionRequest: {
        type: "object",
        required: ["decision"],
        properties: {
          decision: { type: "string", enum: ["accept", "decline", "cancel"] },
          scope: { type: "string", enum: ["turn", "session"] }
        }
      },
      ToolInputDecisionOptionAnswers: {
        type: "object",
        required: ["answers"],
        properties: {
          answers: {
            type: "array",
            items: { type: "string" }
          }
        }
      },
      ToolInputDecisionRequest: {
        type: "object",
        required: ["decision"],
        properties: {
          decision: { type: "string", enum: ["accept", "decline", "cancel"] },
          answers: {
            type: "object",
            additionalProperties: schemaRef("ToolInputDecisionOptionAnswers")
          },
          response: {}
        }
      },
      DynamicToolCallOutputContentItem: {
        oneOf: [
          schemaRef("DynamicToolCallTextContentItem"),
          schemaRef("DynamicToolCallImageContentItem")
        ]
      },
      DynamicToolCallTextContentItem: {
        type: "object",
        required: ["type", "text"],
        properties: {
          type: { type: "string", enum: ["inputText"] },
          text: { type: "string" }
        }
      },
      DynamicToolCallImageContentItem: {
        type: "object",
        required: ["type", "imageUrl"],
        properties: {
          type: { type: "string", enum: ["inputImage"] },
          imageUrl: { type: "string" }
        }
      },
      PendingToolCall: {
        type: "object",
        required: [
          "requestId",
          "method",
          "threadId",
          "turnId",
          "itemId",
          "callId",
          "tool",
          "arguments",
          "summary",
          "details",
          "createdAt",
          "status"
        ],
        properties: {
          requestId: { type: "string" },
          method: { type: "string", enum: ["item/tool/call"] },
          threadId: { type: "string" },
          turnId: { type: ["string", "null"] },
          itemId: { type: ["string", "null"] },
          callId: { type: ["string", "null"] },
          tool: { type: "string" },
          arguments: {},
          summary: { type: "string" },
          details: { type: "object", additionalProperties: true },
          createdAt: { type: "string" },
          status: { type: "string", enum: ["pending"] }
        }
      },
      ListSessionToolCallsResponse: {
        type: "object",
        required: ["data"],
        properties: {
          data: {
            type: "array",
            items: schemaRef("PendingToolCall")
          }
        }
      },
      ToolCallResponseRequest: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          text: { type: "string" },
          contentItems: {
            type: "array",
            items: schemaRef("DynamicToolCallOutputContentItem")
          },
          response: {}
        }
      },
      CreateSessionResponse: {
        type: "object",
        required: ["session", "thread"],
        properties: {
          session: schemaRef("SessionSummary"),
          thread: schemaRef("CodexThread")
        }
      },
      ReadSessionResponse: {
        type: "object",
        required: ["session", "thread", "transcript"],
        properties: {
          session: schemaRef("SessionSummary"),
          thread: schemaRef("CodexThread"),
          transcript: {
            type: "array",
            items: schemaRef("TranscriptEntry")
          }
        }
      },
      SessionSettingsListResponse: {
        type: "object",
        required: ["status", "sessionId", "scope", "settings"],
        properties: {
          status: { type: "string", enum: ["ok"] },
          sessionId: { type: "string" },
          scope: schemaRef("SessionSettingsScope"),
          settings: {
            type: "object",
            additionalProperties: true
          }
        }
      },
      SessionSettingsKeyResponse: {
        type: "object",
        required: ["status", "sessionId", "scope", "key", "found", "value"],
        properties: {
          status: { type: "string", enum: ["ok"] },
          sessionId: { type: "string" },
          scope: schemaRef("SessionSettingsScope"),
          key: { type: "string" },
          found: { type: "boolean" },
          value: {}
        }
      },
      SessionSettingsGetResponse: {
        oneOf: [schemaRef("SessionSettingsListResponse"), schemaRef("SessionSettingsKeyResponse")]
      },
      SetSessionSettingsRequest: {
        type: "object",
        required: ["scope"],
        properties: {
          scope: schemaRef("SessionSettingsScope"),
          key: { type: "string" },
          value: {},
          settings: {
            type: "object",
            additionalProperties: true
          },
          mode: { type: "string", enum: ["merge", "replace"] },
          actor: { type: "string" },
          source: { type: "string" }
        }
      },
      SessionSettingsSetResponse: {
        type: "object",
        required: ["status", "sessionId", "scope", "settings"],
        properties: {
          status: { type: "string", enum: ["ok", "unchanged"] },
          sessionId: { type: "string" },
          scope: schemaRef("SessionSettingsScope"),
          key: { type: "string" },
          settings: {
            type: "object",
            additionalProperties: true
          }
        }
      },
      SessionSettingsDeleteResponse: {
        type: "object",
        required: ["status", "sessionId", "scope", "key", "removed", "settings"],
        properties: {
          status: { type: "string", enum: ["ok", "unchanged"] },
          sessionId: { type: "string" },
          scope: schemaRef("SessionSettingsScope"),
          key: { type: "string" },
          removed: { type: "boolean" },
          settings: {
            type: "object",
            additionalProperties: true
          }
        }
      },
      SessionSettingsLockedResponse: {
        type: "object",
        required: ["status", "scope", "message", "sessionId", "settings"],
        properties: {
          status: { type: "string", enum: ["locked"] },
          scope: schemaRef("SessionSettingsScope"),
          message: { type: "string" },
          sessionId: { type: "string" },
          settings: {
            type: "object",
            additionalProperties: true
          }
        }
      },
      SessionApprovalPolicyResponse: {
        type: "object",
        required: ["status", "sessionId", "approvalPolicy"],
        properties: {
          status: { type: "string", enum: ["ok"] },
          sessionId: { type: "string" },
          approvalPolicy: schemaRef("ApprovalPolicy")
        }
      },
      SuggestedRequestQueuedResponse: {
        type: "object",
        required: ["status", "jobId", "requestKey", "sessionId", "projectId", "dedupe"],
        properties: {
          status: { type: "string", enum: ["queued"] },
          jobId: { type: "string" },
          requestKey: { type: "string" },
          sessionId: { type: "string" },
          projectId: { type: "string" },
          dedupe: { type: "string", enum: ["already_queued", "enqueued"] }
        }
      },
      QueueErrorResponse: {
        type: "object",
        required: ["status", "code", "sessionId", "message"],
        properties: {
          status: { type: "string", enum: ["error"] },
          code: { type: "string", enum: ["queue_full", "job_conflict", "invalid_payload"] },
          sessionId: { type: "string" },
          message: { type: "string" }
        }
      },
      SuggestSessionRequestOkResponse: {
        type: "object",
        required: ["status", "sessionId", "requestKey", "suggestion"],
        properties: {
          status: { type: "string", enum: ["ok"] },
          sessionId: { type: "string" },
          requestKey: { type: "string" },
          suggestion: { type: "string" }
        }
      },
      SuggestSessionRequestFallbackResponse: {
        type: "object",
        required: ["status", "sessionId", "requestKey", "suggestion"],
        properties: {
          status: { type: "string", enum: ["fallback"] },
          sessionId: { type: "string" },
          requestKey: { type: "string" },
          suggestion: { type: "string" }
        }
      },
      SuggestSessionRequestSuccessResponse: {
        oneOf: [schemaRef("SuggestSessionRequestOkResponse"), schemaRef("SuggestSessionRequestFallbackResponse")]
      },
      SuggestSessionRequestNoContextResponse: {
        type: "object",
        required: ["status", "sessionId", "requestKey", "message"],
        properties: {
          status: { type: "string", enum: ["no_context"] },
          sessionId: { type: "string" },
          requestKey: { type: "string" },
          message: { type: "string" }
        }
      },
      SuggestedRequestRuntimeEntry: {
        type: "object",
        required: ["status", "updatedAt"],
        properties: {
          status: suggestionStatusSchema,
          suggestion: { type: "string" },
          error: { type: "string" },
          updatedAt: { type: "string", format: "date-time" }
        }
      },
      SuggestedRequestUpsertResponse: {
        type: "object",
        required: ["status", "sessionId", "requestKey", "entry"],
        properties: {
          status: { type: "string", enum: ["ok"] },
          sessionId: { type: "string" },
          requestKey: { type: "string" },
          entry: schemaRef("SuggestedRequestRuntimeEntry")
        }
      },
      SuggestedRequestUpsertInvalidResponse: {
        type: "object",
        required: ["status", "code", "message"],
        properties: {
          status: { type: "string", enum: ["invalid_request"] },
          code: { type: "string", enum: ["missing_suggestion"] },
          message: { type: "string" }
        }
      },
      SuggestedRequestUpsertErrorResponse: {
        oneOf: [schemaRef("ApiValidationError"), schemaRef("SuggestedRequestUpsertInvalidResponse")]
      },
      SendSessionMessageAcceptedResponse: {
        type: "object",
        required: ["status", "sessionId", "turnId"],
        properties: {
          status: { type: "string", enum: ["accepted"] },
          sessionId: { type: "string" },
          turnId: { type: "string" }
        }
      },
      ToolInputDecisionSuccessResponse: {
        type: "object",
        required: ["status", "requestId", "threadId"],
        properties: {
          status: { type: "string", enum: ["ok"] },
          requestId: { type: "string" },
          threadId: { type: "string" }
        }
      },
      ToolInputDecisionNotFoundResponse: {
        type: "object",
        required: ["status", "requestId"],
        properties: {
          status: { type: "string", enum: ["not_found"] },
          requestId: { type: "string" }
        }
      },
      ToolInputDecisionErrorResponse: {
        type: "object",
        required: ["status", "requestId"],
        properties: {
          status: { type: "string", enum: ["error"] },
          requestId: { type: "string" }
        }
      },
      ToolCallResponseSuccessResponse: {
        type: "object",
        required: ["status", "requestId", "threadId"],
        properties: {
          status: { type: "string", enum: ["ok"] },
          requestId: { type: "string" },
          threadId: { type: "string" }
        }
      },
      ToolCallResponseNotFoundResponse: {
        type: "object",
        required: ["status", "requestId"],
        properties: {
          status: { type: "string", enum: ["not_found"] },
          requestId: { type: "string" }
        }
      },
      ToolCallResponseConflictResponse: {
        type: "object",
        required: ["status", "code", "requestId"],
        properties: {
          status: { type: "string", enum: ["conflict"] },
          code: { type: "string", enum: ["in_flight"] },
          requestId: { type: "string" }
        }
      },
      ToolCallResponseErrorResponse: {
        type: "object",
        required: ["status", "requestId"],
        properties: {
          status: { type: "string", enum: ["error"] },
          requestId: { type: "string" }
        }
      },
      ApprovalDecisionSuccessResponse: {
        type: "object",
        required: ["status", "approvalId", "threadId"],
        properties: {
          status: { type: "string", enum: ["ok"] },
          approvalId: { type: "string" },
          threadId: { type: "string" }
        }
      },
      ApprovalDecisionNotFoundResponse: {
        type: "object",
        required: ["status", "approvalId"],
        properties: {
          status: { type: "string", enum: ["not_found"] },
          approvalId: { type: "string" }
        }
      },
      ApprovalDecisionReconciledResponse: {
        type: "object",
        required: ["status", "approvalId", "threadId", "code"],
        properties: {
          status: { type: "string", enum: ["reconciled"] },
          approvalId: { type: "string" },
          threadId: { type: "string" },
          code: { type: "string", enum: ["already_resolved", "not_eligible", "conflict"] }
        }
      },
      ApprovalDecisionErrorResponse: {
        type: "object",
        required: ["status", "approvalId"],
        properties: {
          status: { type: "string", enum: ["error"] },
          approvalId: { type: "string" }
        }
      }
    }
  }
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(openApiDocument, null, 2)}\n`, "utf8");
console.log(`wrote ${path.relative(root, outputPath)}`);
