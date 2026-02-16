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
  Object.fromEntries(entries.map(([status, description]) => [String(status), { description }]));

const paginationParams = [
  queryParam("cursor", { type: "string" }, "Pagination cursor from a previous response."),
  queryParam("limit", { type: "integer", minimum: 1, maximum: 200 }, "Maximum rows to return.")
];

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
        requestBody: requestBody(
          {
            type: "object",
            properties: {
              cwd: { type: "string" },
              model: { type: "string" }
            }
          },
          false
        ),
        responses: responses([
          [200, "Session created"]
        ])
      }
    },
    "/api/sessions/{sessionId}": {
      get: {
        summary: "Read a session transcript",
        operationId: "readSession",
        parameters: [pathParam("sessionId", "Session id")],
        responses: responses([
          [200, "Session detail"],
          [410, "Session deleted"]
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
    "/api/sessions/{sessionId}/suggested-reply": {
      post: {
        summary: "Generate a suggested user reply for a session",
        operationId: "suggestSessionReply",
        parameters: [pathParam("sessionId", "Session id")],
        requestBody: requestBody(
          {
            type: "object",
            properties: {
              model: { type: "string" },
              draft: { type: "string", minLength: 1, maxLength: 4000 }
            }
          },
          false
        ),
        responses: responses([
          [200, "Suggested reply generated"],
          [409, "No available context for suggestion"],
          [410, "Session deleted"]
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
        requestBody: requestBody({
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string" },
            model: { type: "string" }
          }
        }),
        responses: responses([
          [202, "Turn accepted"],
          [410, "Session deleted"]
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
        requestBody: requestBody({
          type: "object",
          required: ["decision"],
          properties: {
            decision: { type: "string", enum: ["accept", "decline", "cancel"] },
            answers: {
              type: "object",
              additionalProperties: {
                type: "object",
                required: ["answers"],
                properties: {
                  answers: {
                    type: "array",
                    items: { type: "string" }
                  }
                }
              }
            },
            response: {}
          }
        }),
        responses: responses([
          [200, "Decision submitted"],
          [404, "Request not found"]
        ])
      }
    },
    "/api/approvals/{approvalId}/decision": {
      post: {
        summary: "Submit approval decision",
        operationId: "decideApproval",
        parameters: [pathParam("approvalId", "Approval id")],
        requestBody: requestBody({
          type: "object",
          required: ["decision"],
          properties: {
            decision: { type: "string", enum: ["accept", "decline", "cancel"] },
            scope: { type: "string", enum: ["turn", "session"] }
          }
        }),
        responses: responses([
          [200, "Decision submitted"],
          [404, "Approval not found"]
        ])
      }
    }
  }
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(openApiDocument, null, 2)}\n`, "utf8");
console.log(`wrote ${path.relative(root, outputPath)}`);
