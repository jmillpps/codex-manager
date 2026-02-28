#!/usr/bin/env node
import { Command } from "commander";
import WebSocket from "ws";
import {
  loadCliConfig,
  saveCliConfig,
  setCurrentProfile,
  upsertProfile,
  type CliConfigStore,
  type CliProfile
} from "./lib/config.js";
import { parseCsvList, parseJsonInput, parseMaybeBoolean, parseTextInput } from "./lib/body.js";
import { invokeApi, type InvokeApiInput } from "./lib/http.js";
import { printError, printSuccess } from "./lib/output.js";
import { buildRuntime, type RuntimeContext } from "./lib/runtime.js";

function compactPathForCommand(ctx: RuntimeContext, path: string): string {
  if (path === "/api") {
    return ctx.apiPrefix;
  }
  if (path.startsWith("/api/")) {
    return `${ctx.apiPrefix}${path.slice(4)}`;
  }
  if (path.startsWith("/")) {
    return path.startsWith(ctx.apiPrefix) ? path : `${ctx.apiPrefix}${path}`;
  }
  return `${ctx.apiPrefix}/${path}`;
}

function toWebSocketUrl(ctx: RuntimeContext, path: string, query: Record<string, string | undefined>): string {
  const normalizedPath = compactPathForCommand(ctx, path);
  const url = new URL(`${ctx.baseUrl}${normalizedPath}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  for (const [key, value] of Object.entries(query)) {
    if (value && value.trim().length > 0) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

async function runApiCall(ctx: RuntimeContext, input: InvokeApiInput): Promise<void> {
  const result = await invokeApi(ctx, input);
  printSuccess(ctx, result);
}

function withRuntime(
  commandName: string,
  handler: (ctx: RuntimeContext, args: Array<unknown>) => Promise<void>
): (...args: Array<unknown>) => Promise<void> {
  return async (...args: Array<unknown>) => {
    const command = args.at(-1);
    if (!(command instanceof Command)) {
      throw new Error("commander command context unavailable");
    }

    let ctx: RuntimeContext | null = null;
    try {
      ctx = await buildRuntime(command);
      await handler(ctx, args);
    } catch (error) {
      if (ctx) {
        printError(ctx, commandName, error);
      } else {
        process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      process.exitCode = 1;
    }
  };
}

async function commandProfileList(): Promise<void> {
  const config = await loadCliConfig();
  const payload = {
    currentProfile: config.currentProfile,
    profiles: config.profiles
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function commandProfileUse(profileName: string): Promise<void> {
  await setCurrentProfile(profileName);
  process.stdout.write(`${JSON.stringify({ status: "ok", currentProfile: profileName }, null, 2)}\n`);
}

function applyProfileField(
  profile: CliProfile,
  updates: {
    baseUrl?: string;
    apiPrefix?: string;
    timeoutMs?: string;
  }
): CliProfile {
  const timeoutMs =
    typeof updates.timeoutMs === "string" && updates.timeoutMs.trim().length > 0
      ? Number(updates.timeoutMs)
      : Number.NaN;

  return {
    ...profile,
    baseUrl: updates.baseUrl?.trim() ? updates.baseUrl.trim() : profile.baseUrl,
    apiPrefix: updates.apiPrefix?.trim() ? updates.apiPrefix.trim() : profile.apiPrefix,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : profile.timeoutMs
  };
}

async function commandProfileSet(
  profileName: string,
  updates: {
    baseUrl?: string;
    apiPrefix?: string;
    timeoutMs?: string;
  }
): Promise<void> {
  const result = await upsertProfile(profileName, (current) => applyProfileField(current, updates));
  process.stdout.write(
    `${JSON.stringify({ status: "ok", profileName: result.profileName, profile: result.profile }, null, 2)}\n`
  );
}

async function commandProfileAuthSet(
  profileName: string,
  updates: {
    bearer?: string;
    rbacToken?: string;
    role?: string;
    actor?: string;
  }
): Promise<void> {
  const result = await upsertProfile(profileName, (current) => ({
    ...current,
    auth: {
      bearer: updates.bearer?.trim() ? updates.bearer.trim() : current.auth.bearer,
      rbacToken: updates.rbacToken?.trim() ? updates.rbacToken.trim() : current.auth.rbacToken,
      role: updates.role?.trim() ? updates.role.trim() : current.auth.role,
      actor: updates.actor?.trim() ? updates.actor.trim() : current.auth.actor
    }
  }));
  process.stdout.write(
    `${JSON.stringify({ status: "ok", profileName: result.profileName, profile: result.profile }, null, 2)}\n`
  );
}

function parseStatusList(input: string | undefined): Array<number> {
  if (!input) {
    return [200];
  }
  const list = input
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value) && value >= 100 && value <= 599);
  return list.length > 0 ? list : [200];
}

function parseKeyValuePairs(entries: Array<string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const entry of entries) {
    const index = entry.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = entry.slice(0, index).trim();
    const value = entry.slice(index + 1).trim();
    if (!key) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

function parseOptionalPositiveInt(value: string | undefined, fieldName: string): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${fieldName} must be a positive number`);
  }
  return Math.floor(parsed);
}

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function buildProgram(): Command {
  const program = new Command();

  program
    .name("codex-manager")
    .description("Codex Manager operator and automation CLI")
    .option("--profile <name>", "Profile name from CLI config")
    .option("--base-url <url>", "API base URL, e.g. http://127.0.0.1:3001")
    .option("--api-prefix <path>", "API prefix path", "/api")
    .option("--timeout-ms <n>", "Request timeout in milliseconds")
    .option("--json", "Emit machine-readable JSON envelope")
    .option("--verbose", "Verbose output")
    .option("--bearer <token>", "Bearer auth token")
    .option("--rbac-token <token>", "RBAC header token")
    .option("--role <role>", "RBAC role header")
    .option("--actor <id>", "RBAC actor header")
    .option("--headers <key:value>", "Additional request headers", (value, all: Array<string>) => [...all, value], []);

  const profile = program.command("profile").description("Manage CLI profiles");
  profile.command("list").description("List profiles").action(async () => {
    try {
      await commandProfileList();
    } catch (error) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });

  profile.command("use <name>").description("Set current profile").action(async (name: string) => {
    try {
      await commandProfileUse(name);
    } catch (error) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });

  profile
    .command("set <name>")
    .description("Create or update profile defaults")
    .option("--base-url <url>")
    .option("--api-prefix <path>")
    .option("--timeout-ms <n>")
    .action(async (name: string, options: { baseUrl?: string; apiPrefix?: string; timeoutMs?: string }) => {
      try {
        await commandProfileSet(name, options);
      } catch (error) {
        process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    });

  profile
    .command("auth-set <name>")
    .description("Set profile auth defaults")
    .option("--bearer <token>")
    .option("--rbac-token <token>")
    .option("--role <role>")
    .option("--actor <actor>")
    .action(
      async (
        name: string,
        options: { bearer?: string; rbacToken?: string; role?: string; actor?: string }
      ) => {
        try {
          await commandProfileAuthSet(name, options);
        } catch (error) {
          process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
          process.exitCode = 1;
        }
      }
    );

  const system = program.command("system").description("System and capability endpoints");
  system
    .command("info")
    .description("Get API metadata")
    .action(
      withRuntime("system info", async (ctx) =>
        runApiCall(ctx, {
          command: "system info",
          method: "GET",
          pathTemplate: "/api"
        })
      )
    );

  system
    .command("health")
    .description("Get API health")
    .action(
      withRuntime("system health", async (ctx) =>
        runApiCall(ctx, {
          command: "system health",
          method: "GET",
          pathTemplate: "/api/health"
        })
      )
    );

  system
    .command("capabilities")
    .description("Get capabilities")
    .option("--refresh <boolean>", "Refresh capabilities before read")
    .action(
      withRuntime("system capabilities", async (ctx, args) => {
        const options = args[0] as { refresh?: string };
        await runApiCall(ctx, {
          command: "system capabilities",
          method: "GET",
          pathTemplate: "/api/capabilities",
          query: {
            refresh: parseMaybeBoolean(options.refresh)
          }
        });
      })
    );

  const systemFeatures = system.command("features").description("Experimental feature metadata");
  systemFeatures
    .command("list")
    .option("--cursor <cursor>")
    .option("--limit <n>")
    .action(
      withRuntime("system features list", async (ctx, args) => {
        const options = args[0] as { cursor?: string; limit?: string };
        await runApiCall(ctx, {
          command: "system features list",
          method: "GET",
          pathTemplate: "/api/features/experimental",
          query: {
            cursor: options.cursor,
            limit: options.limit ? Number(options.limit) : undefined
          },
          allowStatuses: [200, 501]
        });
      })
    );

  const collaboration = system.command("collaboration-modes").description("Collaboration mode endpoints");
  collaboration
    .command("list")
    .option("--cursor <cursor>")
    .option("--limit <n>")
    .action(
      withRuntime("system collaboration-modes list", async (ctx, args) => {
        const options = args[0] as { cursor?: string; limit?: string };
        await runApiCall(ctx, {
          command: "system collaboration-modes list",
          method: "GET",
          pathTemplate: "/api/collaboration/modes",
          query: {
            cursor: options.cursor,
            limit: options.limit ? Number(options.limit) : undefined
          },
          allowStatuses: [200, 501]
        });
      })
    );

  const models = program.command("models").description("Model catalog endpoints");
  models
    .command("list")
    .description("List models")
    .option("--cursor <cursor>")
    .option("--limit <n>")
    .action(
      withRuntime("models list", async (ctx, args) => {
        const options = args[0] as { cursor?: string; limit?: string };
        await runApiCall(ctx, {
          command: "models list",
          method: "GET",
          pathTemplate: "/api/models",
          query: {
            cursor: options.cursor,
            limit: options.limit ? Number(options.limit) : undefined
          },
          allowStatuses: [200, 501]
        });
      })
    );

  const apps = program.command("apps").description("App/connector endpoints");
  apps
    .command("list")
    .option("--cursor <cursor>")
    .option("--limit <n>")
    .option("--thread-id <id>")
    .option("--force-refetch <boolean>")
    .action(
      withRuntime("apps list", async (ctx, args) => {
        const options = args[0] as {
          cursor?: string;
          limit?: string;
          threadId?: string;
          forceRefetch?: string;
        };
        await runApiCall(ctx, {
          command: "apps list",
          method: "GET",
          pathTemplate: "/api/apps",
          query: {
            cursor: options.cursor,
            limit: options.limit ? Number(options.limit) : undefined,
            threadId: options.threadId,
            forceRefetch: parseMaybeBoolean(options.forceRefetch)
          },
          allowStatuses: [200, 501]
        });
      })
    );

  const skills = program.command("skills").description("Skills endpoints");
  skills
    .command("list")
    .option("--force-reload <boolean>")
    .option("--cwd <cwd>")
    .action(
      withRuntime("skills list", async (ctx, args) => {
        const options = args[0] as { forceReload?: string; cwd?: string };
        await runApiCall(ctx, {
          command: "skills list",
          method: "GET",
          pathTemplate: "/api/skills",
          query: {
            forceReload: parseMaybeBoolean(options.forceReload),
            cwd: options.cwd
          },
          allowStatuses: [200, 501]
        });
      })
    );

  const skillConfig = skills.command("config").description("Skill config operations");
  skillConfig
    .command("set")
    .requiredOption("--path <path>")
    .requiredOption("--enabled <boolean>")
    .action(
      withRuntime("skills config set", async (ctx, args) => {
        const options = args[0] as { path: string; enabled: string };
        const enabled = parseMaybeBoolean(options.enabled);
        if (enabled === undefined) {
          throw new Error("--enabled must be true or false");
        }
        await runApiCall(ctx, {
          command: "skills config set",
          method: "POST",
          pathTemplate: "/api/skills/config",
          body: {
            path: options.path,
            enabled
          },
          allowStatuses: [200, 501]
        });
      })
    );

  const skillRemote = skills.command("remote").description("Remote skills settings");
  skillRemote
    .command("get")
    .action(
      withRuntime("skills remote get", async (ctx) => {
        await runApiCall(ctx, {
          command: "skills remote get",
          method: "GET",
          pathTemplate: "/api/skills/remote",
          allowStatuses: [200, 500, 501]
        });
      })
    );

  skillRemote
    .command("set")
    .requiredOption("--hazelnut-id <id>")
    .requiredOption("--is-preload <boolean>")
    .action(
      withRuntime("skills remote set", async (ctx, args) => {
        const options = args[0] as { hazelnutId: string; isPreload: string };
        const isPreload = parseMaybeBoolean(options.isPreload);
        if (isPreload === undefined) {
          throw new Error("--is-preload must be true or false");
        }
        await runApiCall(ctx, {
          command: "skills remote set",
          method: "POST",
          pathTemplate: "/api/skills/remote",
          body: {
            hazelnutId: options.hazelnutId,
            isPreload
          },
          allowStatuses: [200, 501]
        });
      })
    );

  const mcp = program.command("mcp").description("MCP endpoints");
  mcp
    .command("reload")
    .action(
      withRuntime("mcp reload", async (ctx) => {
        await runApiCall(ctx, {
          command: "mcp reload",
          method: "POST",
          pathTemplate: "/api/mcp/reload",
          body: {},
          allowStatuses: [200, 501]
        });
      })
    );

  const mcpServers = mcp.command("servers").description("MCP server status");
  mcpServers
    .command("list")
    .option("--cursor <cursor>")
    .option("--limit <n>")
    .action(
      withRuntime("mcp servers list", async (ctx, args) => {
        const options = args[0] as { cursor?: string; limit?: string };
        await runApiCall(ctx, {
          command: "mcp servers list",
          method: "GET",
          pathTemplate: "/api/mcp/servers",
          query: {
            cursor: options.cursor,
            limit: options.limit ? Number(options.limit) : undefined
          },
          allowStatuses: [200, 501]
        });
      })
    );

  const mcpOauth = mcp.command("oauth").description("MCP OAuth endpoints");
  mcpOauth
    .command("login")
    .requiredOption("--server-name <name>")
    .option("--scopes <comma-separated>")
    .option("--timeout-secs <n>")
    .action(
      withRuntime("mcp oauth login", async (ctx, args) => {
        const options = args[0] as { serverName: string; scopes?: string; timeoutSecs?: string };
        await runApiCall(ctx, {
          command: "mcp oauth login",
          method: "POST",
          pathTemplate: "/api/mcp/servers/:serverName/oauth/login",
          pathParams: {
            serverName: options.serverName
          },
          body: {
            ...(parseCsvList(options.scopes) ? { scopes: parseCsvList(options.scopes) } : {}),
            ...(options.timeoutSecs ? { timeoutSecs: Number(options.timeoutSecs) } : {})
          },
          allowStatuses: [200, 501]
        });
      })
    );

  const account = program.command("account").description("Account endpoints");
  account
    .command("get")
    .action(
      withRuntime("account get", async (ctx) => {
        await runApiCall(ctx, {
          command: "account get",
          method: "GET",
          pathTemplate: "/api/account",
          allowStatuses: [200, 401, 501]
        });
      })
    );

  const accountLogin = account.command("login").description("Account login flows");
  accountLogin
    .command("start")
    .requiredOption("--type <type>", "apiKey|chatgpt|chatgptAuthTokens")
    .option("--api-key <key>")
    .option("--access-token <token>")
    .option("--chatgpt-account-id <id>")
    .option("--chatgpt-plan-type <type>")
    .action(
      withRuntime("account login start", async (ctx, args) => {
        const options = args[0] as {
          type: string;
          apiKey?: string;
          accessToken?: string;
          chatgptAccountId?: string;
          chatgptPlanType?: string;
        };

        let body: Record<string, unknown>;
        if (options.type === "apiKey") {
          if (!options.apiKey) {
            throw new Error("--api-key is required when --type apiKey");
          }
          body = {
            type: "apiKey",
            apiKey: options.apiKey
          };
        } else if (options.type === "chatgpt") {
          body = {
            type: "chatgpt"
          };
        } else if (options.type === "chatgptAuthTokens") {
          if (!options.accessToken || !options.chatgptAccountId) {
            throw new Error("--access-token and --chatgpt-account-id are required for chatgptAuthTokens");
          }
          body = {
            type: "chatgptAuthTokens",
            accessToken: options.accessToken,
            chatgptAccountId: options.chatgptAccountId,
            ...(options.chatgptPlanType ? { chatgptPlanType: options.chatgptPlanType } : {})
          };
        } else {
          throw new Error("--type must be one of: apiKey, chatgpt, chatgptAuthTokens");
        }

        await runApiCall(ctx, {
          command: "account login start",
          method: "POST",
          pathTemplate: "/api/account/login/start",
          body,
          allowStatuses: [200, 400, 501]
        });
      })
    );

  accountLogin
    .command("cancel")
    .requiredOption("--login-id <id>")
    .action(
      withRuntime("account login cancel", async (ctx, args) => {
        const options = args[0] as { loginId: string };
        await runApiCall(ctx, {
          command: "account login cancel",
          method: "POST",
          pathTemplate: "/api/account/login/cancel",
          body: {
            loginId: options.loginId
          },
          allowStatuses: [200, 404, 501]
        });
      })
    );

  account
    .command("logout")
    .action(
      withRuntime("account logout", async (ctx) => {
        await runApiCall(ctx, {
          command: "account logout",
          method: "POST",
          pathTemplate: "/api/account/logout",
          body: {},
          allowStatuses: [200, 501]
        });
      })
    );

  account
    .command("rate-limits")
    .action(
      withRuntime("account rate-limits", async (ctx) => {
        await runApiCall(ctx, {
          command: "account rate-limits",
          method: "GET",
          pathTemplate: "/api/account/rate-limits",
          allowStatuses: [200, 401, 501]
        });
      })
    );

  const config = program.command("config").description("Config endpoints");
  config
    .command("get")
    .option("--cwd <cwd>")
    .option("--include-layers <boolean>")
    .action(
      withRuntime("config get", async (ctx, args) => {
        const options = args[0] as { cwd?: string; includeLayers?: string };
        await runApiCall(ctx, {
          command: "config get",
          method: "GET",
          pathTemplate: "/api/config",
          query: {
            cwd: options.cwd,
            includeLayers: parseMaybeBoolean(options.includeLayers)
          },
          allowStatuses: [200, 501]
        });
      })
    );

  config
    .command("requirements")
    .action(
      withRuntime("config requirements", async (ctx) => {
        await runApiCall(ctx, {
          command: "config requirements",
          method: "GET",
          pathTemplate: "/api/config/requirements",
          allowStatuses: [200, 501]
        });
      })
    );

  config
    .command("set")
    .requiredOption("--key-path <keyPath>")
    .requiredOption("--merge-strategy <strategy>", "replace|upsert")
    .requiredOption("--value <json or @file>")
    .option("--expected-version <version>")
    .option("--file-path <path>")
    .action(
      withRuntime("config set", async (ctx, args) => {
        const options = args[0] as {
          keyPath: string;
          mergeStrategy: "replace" | "upsert";
          value: string;
          expectedVersion?: string;
          filePath?: string;
        };
        const value = await parseJsonInput(options.value);
        await runApiCall(ctx, {
          command: "config set",
          method: "POST",
          pathTemplate: "/api/config/value",
          body: {
            keyPath: options.keyPath,
            mergeStrategy: options.mergeStrategy,
            value,
            ...(options.expectedVersion ? { expectedVersion: options.expectedVersion } : {}),
            ...(options.filePath ? { filePath: options.filePath } : {})
          },
          allowStatuses: [200, 501]
        });
      })
    );

  config
    .command("batch-set")
    .requiredOption("--body <json or @file>")
    .action(
      withRuntime("config batch-set", async (ctx, args) => {
        const options = args[0] as { body: string };
        const body = await parseJsonInput(options.body);
        await runApiCall(ctx, {
          command: "config batch-set",
          method: "POST",
          pathTemplate: "/api/config/batch",
          body,
          allowStatuses: [200, 501]
        });
      })
    );

  const runtime = program.command("runtime").description("Runtime utility endpoints");
  runtime
    .command("exec [command...]")
    .description("Execute command via API runtime")
    .option("--cwd <cwd>")
    .option("--timeout-ms <n>")
    .action(
      withRuntime("runtime exec", async (ctx, args) => {
        const commandArgs = (args[0] as Array<string>) ?? [];
        const options = args[1] as { cwd?: string; timeoutMs?: string };
        if (!Array.isArray(commandArgs) || commandArgs.length === 0) {
          throw new Error("runtime exec requires at least one command argument");
        }
        await runApiCall(ctx, {
          command: "runtime exec",
          method: "POST",
          pathTemplate: "/api/commands/exec",
          body: {
            command: commandArgs,
            ...(options.cwd ? { cwd: options.cwd } : {}),
            ...(options.timeoutMs ? { timeoutMs: Number(options.timeoutMs) } : {})
          },
          allowStatuses: [200, 501]
        });
      })
    );

  const feedback = program.command("feedback").description("Feedback endpoints");
  feedback
    .command("submit")
    .requiredOption("--classification <classification>")
    .requiredOption("--include-logs <boolean>")
    .option("--reason <reason>")
    .option("--thread-id <id>")
    .action(
      withRuntime("feedback submit", async (ctx, args) => {
        const options = args[0] as {
          classification: string;
          includeLogs: string;
          reason?: string;
          threadId?: string;
        };
        const includeLogs = parseMaybeBoolean(options.includeLogs);
        if (includeLogs === undefined) {
          throw new Error("--include-logs must be true or false");
        }
        await runApiCall(ctx, {
          command: "feedback submit",
          method: "POST",
          pathTemplate: "/api/feedback",
          body: {
            classification: options.classification,
            includeLogs,
            ...(options.reason ? { reason: options.reason } : {}),
            ...(options.threadId ? { threadId: options.threadId } : {})
          },
          allowStatuses: [200, 501]
        });
      })
    );

  const agents = program.command("agents").description("Agent extension endpoints");
  const agentsExtensions = agents.command("extensions").description("Extension lifecycle");
  agentsExtensions
    .command("list")
    .action(
      withRuntime("agents extensions list", async (ctx) => {
        await runApiCall(ctx, {
          command: "agents extensions list",
          method: "GET",
          pathTemplate: "/api/agents/extensions"
        });
      })
    );
  agentsExtensions
    .command("reload")
    .action(
      withRuntime("agents extensions reload", async (ctx) => {
        await runApiCall(ctx, {
          command: "agents extensions reload",
          method: "POST",
          pathTemplate: "/api/agents/extensions/reload",
          body: {}
        });
      })
    );

  const orchestrator = program.command("orchestrator").description("Orchestrator job endpoints");
  const orchestratorJobs = orchestrator.command("jobs").description("Job management");
  orchestratorJobs
    .command("get")
    .requiredOption("--job-id <id>")
    .action(
      withRuntime("orchestrator jobs get", async (ctx, args) => {
        const options = args[0] as { jobId: string };
        await runApiCall(ctx, {
          command: "orchestrator jobs get",
          method: "GET",
          pathTemplate: "/api/orchestrator/jobs/:jobId",
          pathParams: {
            jobId: options.jobId
          },
          allowStatuses: [200, 404]
        });
      })
    );

  orchestratorJobs
    .command("list")
    .requiredOption("--project-id <id>")
    .option("--state <state>", "queued|running|completed|failed|canceled")
    .option("--source-session-id <id>")
    .option("--job-kind <kind>")
    .option("--agent <name>")
    .option("--sort <order>", "asc|desc", "asc")
    .option("--limit <n>")
    .action(
      withRuntime("orchestrator jobs list", async (ctx, args) => {
        const options = args[0] as {
          projectId: string;
          state?: string;
          sourceSessionId?: string;
          jobKind?: string;
          agent?: string;
          sort?: string;
          limit?: string;
        };

        const result = await invokeApi(ctx, {
          command: "orchestrator jobs list",
          method: "GET",
          pathTemplate: "/api/projects/:projectId/orchestrator/jobs",
          pathParams: {
            projectId: options.projectId
          },
          query: {
            state: options.state
          }
        });

        const responseBody = asObjectRecord(result.response.body);
        const data = Array.isArray(responseBody?.data) ? responseBody.data : null;
        if (!responseBody || !data) {
          printSuccess(ctx, result);
          return;
        }

        let jobs = data.filter((entry): entry is Record<string, unknown> => asObjectRecord(entry) !== null);

        if (options.sourceSessionId) {
          jobs = jobs.filter((job) => job.sourceSessionId === options.sourceSessionId);
        }
        if (options.jobKind) {
          jobs = jobs.filter((job) => {
            const payload = asObjectRecord(job.payload);
            return payload?.jobKind === options.jobKind;
          });
        }
        if (options.agent) {
          jobs = jobs.filter((job) => {
            const payload = asObjectRecord(job.payload);
            return payload?.agent === options.agent;
          });
        }

        const sortOrder = (options.sort ?? "asc").toLowerCase();
        if (sortOrder !== "asc" && sortOrder !== "desc") {
          throw new Error("--sort must be asc or desc");
        }
        jobs.sort((left, right) => {
          const leftCreated = Date.parse(String(left.createdAt ?? ""));
          const rightCreated = Date.parse(String(right.createdAt ?? ""));
          if (!Number.isFinite(leftCreated) || !Number.isFinite(rightCreated)) {
            return 0;
          }
          return sortOrder === "asc" ? leftCreated - rightCreated : rightCreated - leftCreated;
        });

        const limit = parseOptionalPositiveInt(options.limit, "limit");
        if (limit) {
          jobs = jobs.slice(0, limit);
        }

        printSuccess(ctx, {
          ...result,
          response: {
            ...result.response,
            body: {
              ...responseBody,
              data: jobs
            }
          }
        });
      })
    );

  orchestratorJobs
    .command("cancel")
    .requiredOption("--job-id <id>")
    .action(
      withRuntime("orchestrator jobs cancel", async (ctx, args) => {
        const options = args[0] as { jobId: string };
        await runApiCall(ctx, {
          command: "orchestrator jobs cancel",
          method: "POST",
          pathTemplate: "/api/orchestrator/jobs/:jobId/cancel",
          pathParams: {
            jobId: options.jobId
          },
          body: {},
          allowStatuses: [200, 404, 409]
        });
      })
    );

  orchestratorJobs
    .command("wait")
    .requiredOption("--job-id <id>")
    .option("--timeout-ms <n>", "Max wait time", "60000")
    .option("--poll-ms <n>", "Polling interval", "500")
    .action(
      withRuntime("orchestrator jobs wait", async (ctx, args) => {
        const options = args[0] as { jobId: string; timeoutMs: string; pollMs: string };
        const deadline = Date.now() + Number(options.timeoutMs);
        const pollMs = Math.max(50, Number(options.pollMs));

        while (Date.now() < deadline) {
          const result = await invokeApi(ctx, {
            command: "orchestrator jobs get",
            method: "GET",
            pathTemplate: "/api/orchestrator/jobs/:jobId",
            pathParams: {
              jobId: options.jobId
            },
            allowStatuses: [200, 404]
          });

          printSuccess(ctx, result);

          const body = result.response.body as Record<string, unknown>;
          const job =
            body && typeof body === "object" && body.job && typeof body.job === "object"
              ? (body.job as Record<string, unknown>)
              : null;
          const state = typeof job?.state === "string" ? job.state : null;
          if (state && ["completed", "failed", "canceled"].includes(state)) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }

        throw new Error(`timed out waiting for job ${options.jobId}`);
      })
    );

  const projects = program.command("projects").description("Project endpoints");
  projects
    .command("list")
    .action(
      withRuntime("projects list", async (ctx) => {
        await runApiCall(ctx, {
          command: "projects list",
          method: "GET",
          pathTemplate: "/api/projects"
        });
      })
    );

  const projectAgentSessions = projects.command("agent-sessions").description("Project-owned agent session mappings");
  projectAgentSessions
    .command("list")
    .requiredOption("--project-id <id>")
    .action(
      withRuntime("projects agent-sessions list", async (ctx, args) => {
        const options = args[0] as { projectId: string };
        await runApiCall(ctx, {
          command: "projects agent-sessions list",
          method: "GET",
          pathTemplate: "/api/projects/:projectId/agent-sessions",
          pathParams: {
            projectId: options.projectId
          },
          allowStatuses: [200, 404]
        });
      })
    );

  projects
    .command("create")
    .requiredOption("--name <name>")
    .option("--working-directory <path>")
    .option("--clear-working-directory", "Set working directory to null")
    .action(
      withRuntime("projects create", async (ctx, args) => {
        const options = args[0] as { name: string; workingDirectory?: string; clearWorkingDirectory?: boolean };
        await runApiCall(ctx, {
          command: "projects create",
          method: "POST",
          pathTemplate: "/api/projects",
          body: {
            name: options.name,
            ...(options.clearWorkingDirectory
              ? { workingDirectory: null }
              : options.workingDirectory
                ? { workingDirectory: options.workingDirectory }
                : {})
          },
          allowStatuses: [200, 409]
        });
      })
    );

  projects
    .command("rename")
    .requiredOption("--project-id <id>")
    .requiredOption("--name <name>")
    .option("--working-directory <path>")
    .option("--clear-working-directory", "Set working directory to null")
    .action(
      withRuntime("projects rename", async (ctx, args) => {
        const options = args[0] as {
          projectId: string;
          name: string;
          workingDirectory?: string;
          clearWorkingDirectory?: boolean;
        };
        await runApiCall(ctx, {
          command: "projects rename",
          method: "POST",
          pathTemplate: "/api/projects/:projectId/rename",
          pathParams: {
            projectId: options.projectId
          },
          body: {
            name: options.name,
            ...(options.clearWorkingDirectory
              ? { workingDirectory: null }
              : options.workingDirectory
                ? { workingDirectory: options.workingDirectory }
                : {})
          },
          allowStatuses: [200, 404, 409]
        });
      })
    );

  projects
    .command("delete")
    .requiredOption("--project-id <id>")
    .action(
      withRuntime("projects delete", async (ctx, args) => {
        const options = args[0] as { projectId: string };
        await runApiCall(ctx, {
          command: "projects delete",
          method: "DELETE",
          pathTemplate: "/api/projects/:projectId",
          pathParams: {
            projectId: options.projectId
          },
          allowStatuses: [200, 404, 409]
        });
      })
    );

  const projectChats = projects.command("chats").description("Project chat bulk operations");
  projectChats
    .command("move-all")
    .requiredOption("--project-id <id>")
    .requiredOption("--destination <destination>", "unassigned|archive")
    .action(
      withRuntime("projects chats move-all", async (ctx, args) => {
        const options = args[0] as { projectId: string; destination: "unassigned" | "archive" };
        await runApiCall(ctx, {
          command: "projects chats move-all",
          method: "POST",
          pathTemplate: "/api/projects/:projectId/chats/move-all",
          pathParams: {
            projectId: options.projectId
          },
          body: {
            destination: options.destination
          },
          allowStatuses: [200, 404, 409]
        });
      })
    );

  projectChats
    .command("delete-all")
    .requiredOption("--project-id <id>")
    .action(
      withRuntime("projects chats delete-all", async (ctx, args) => {
        const options = args[0] as { projectId: string };
        await runApiCall(ctx, {
          command: "projects chats delete-all",
          method: "POST",
          pathTemplate: "/api/projects/:projectId/chats/delete-all",
          pathParams: {
            projectId: options.projectId
          },
          body: {},
          allowStatuses: [200, 404]
        });
      })
    );

  const sessions = program.command("sessions").description("Session endpoints");
  sessions
    .command("list")
    .option("--archived <boolean>")
    .option("--cursor <cursor>")
    .option("--limit <n>")
    .option("--include-system-owned <boolean>")
    .action(
      withRuntime("sessions list", async (ctx, args) => {
        const options = args[0] as {
          archived?: string;
          cursor?: string;
          limit?: string;
          includeSystemOwned?: string;
        };
        await runApiCall(ctx, {
          command: "sessions list",
          method: "GET",
          pathTemplate: "/api/sessions",
          query: {
            archived: parseMaybeBoolean(options.archived),
            cursor: options.cursor,
            limit: options.limit ? Number(options.limit) : undefined,
            includeSystemOwned: parseMaybeBoolean(options.includeSystemOwned)
          }
        });
      })
    );

  sessions
    .command("create")
    .option("--cwd <cwd>")
    .option("--model <model>")
    .option("--approval-policy <policy>")
    .option("--network-access <mode>")
    .option("--filesystem-sandbox <mode>")
    .option("--dynamic-tools <json or @file>")
    .action(
      withRuntime("sessions create", async (ctx, args) => {
        const options = args[0] as {
          cwd?: string;
          model?: string;
          approvalPolicy?: string;
          networkAccess?: string;
          filesystemSandbox?: string;
          dynamicTools?: string;
        };
        const dynamicTools = options.dynamicTools ? await parseJsonInput(options.dynamicTools) : undefined;
        await runApiCall(ctx, {
          command: "sessions create",
          method: "POST",
          pathTemplate: "/api/sessions",
          body: {
            ...(options.cwd ? { cwd: options.cwd } : {}),
            ...(options.model ? { model: options.model } : {}),
            ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
            ...(options.networkAccess ? { networkAccess: options.networkAccess } : {}),
            ...(options.filesystemSandbox ? { filesystemSandbox: options.filesystemSandbox } : {}),
            ...(dynamicTools !== undefined ? { dynamicTools } : {})
          }
        });
      })
    );

  sessions
    .command("get")
    .requiredOption("--session-id <id>")
    .action(
      withRuntime("sessions get", async (ctx, args) => {
        const options = args[0] as { sessionId: string };
        await runApiCall(ctx, {
          command: "sessions get",
          method: "GET",
          pathTemplate: "/api/sessions/:sessionId",
          pathParams: {
            sessionId: options.sessionId
          },
          allowStatuses: [200, 410]
        });
      })
    );

  sessions
    .command("inspect")
    .requiredOption("--session-id <id>")
    .option("--transcript-tail <n>", "Tail entry count after filtering", "12")
    .option("--types <csv>", "Filter transcript entry types")
    .option("--statuses <csv>", "Filter transcript statuses")
    .option("--roles <csv>", "Filter transcript roles")
    .option("--contains <text>", "Substring filter against transcript content")
    .option("--content-chars <n>", "Truncate content preview length", "220")
    .action(
      withRuntime("sessions inspect", async (ctx, args) => {
        const options = args[0] as {
          sessionId: string;
          transcriptTail?: string;
          types?: string;
          statuses?: string;
          roles?: string;
          contains?: string;
          contentChars?: string;
        };
        const transcriptTail = parseOptionalPositiveInt(options.transcriptTail, "transcript-tail") ?? 12;
        const contentChars = parseOptionalPositiveInt(options.contentChars, "content-chars") ?? 220;
        const types = new Set(parseCsvList(options.types) ?? []);
        const statuses = new Set(parseCsvList(options.statuses) ?? []);
        const roles = new Set(parseCsvList(options.roles) ?? []);
        const contains = options.contains?.trim().toLowerCase();

        const result = await invokeApi(ctx, {
          command: "sessions inspect",
          method: "GET",
          pathTemplate: "/api/sessions/:sessionId",
          pathParams: {
            sessionId: options.sessionId
          },
          allowStatuses: [200, 410]
        });

        const responseBody = asObjectRecord(result.response.body);
        if (!responseBody) {
          printSuccess(ctx, result);
          return;
        }

        const session = asObjectRecord(responseBody.session);
        const thread = asObjectRecord(responseBody.thread);
        const transcript = Array.isArray(responseBody.transcript) ? responseBody.transcript : [];
        const turns = Array.isArray(thread?.turns) ? thread.turns : [];
        const lastTurn = turns.length > 0 ? asObjectRecord(turns.at(-1)) : null;

        const filteredTranscript = transcript
          .map((entry) => asObjectRecord(entry))
          .filter((entry): entry is Record<string, unknown> => entry !== null)
          .filter((entry) => (types.size > 0 ? types.has(String(entry.type ?? "")) : true))
          .filter((entry) => (statuses.size > 0 ? statuses.has(String(entry.status ?? "")) : true))
          .filter((entry) => (roles.size > 0 ? roles.has(String(entry.role ?? "")) : true))
          .filter((entry) => {
            if (!contains) {
              return true;
            }
            const content = String(entry.content ?? "").toLowerCase();
            return content.includes(contains);
          });

        const transcriptTailEntries = filteredTranscript.slice(-transcriptTail).map((entry) => ({
          messageId: entry.messageId ?? null,
          turnId: entry.turnId ?? null,
          role: entry.role ?? null,
          type: entry.type ?? null,
          status: entry.status ?? null,
          startedAt: entry.startedAt ?? null,
          completedAt: entry.completedAt ?? null,
          content: String(entry.content ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, contentChars)
        }));

        printSuccess(ctx, {
          ...result,
          response: {
            ...result.response,
            body: {
              session,
              thread: thread
                ? {
                    id: thread.id ?? null,
                    preview: thread.preview ?? null,
                    updatedAt: thread.updatedAt ?? null
                  }
                : null,
              latestTurn: lastTurn
                ? {
                    id: lastTurn.id ?? null,
                    status: lastTurn.status ?? null,
                    error: lastTurn.error ?? null
                  }
                : null,
              transcriptCount: transcript.length,
              filteredTranscriptCount: filteredTranscript.length,
              transcriptTail: transcriptTailEntries
            }
          }
        });
      })
    );

  sessions
    .command("delete")
    .requiredOption("--session-id <id>")
    .action(
      withRuntime("sessions delete", async (ctx, args) => {
        const options = args[0] as { sessionId: string };
        await runApiCall(ctx, {
          command: "sessions delete",
          method: "DELETE",
          pathTemplate: "/api/sessions/:sessionId",
          pathParams: {
            sessionId: options.sessionId
          },
          allowStatuses: [200, 404, 410]
        });
      })
    );

  sessions
    .command("resume")
    .requiredOption("--session-id <id>")
    .option("--dynamic-tools <json or @file>")
    .action(
      withRuntime("sessions resume", async (ctx, args) => {
        const options = args[0] as { sessionId: string; dynamicTools?: string };
        const dynamicTools = options.dynamicTools ? await parseJsonInput(options.dynamicTools) : undefined;
        await runApiCall(ctx, {
          command: "sessions resume",
          method: "POST",
          pathTemplate: "/api/sessions/:sessionId/resume",
          pathParams: {
            sessionId: options.sessionId
          },
          body: dynamicTools === undefined ? {} : { dynamicTools },
          allowStatuses: [200, 410]
        });
      })
    );

  sessions
    .command("rename")
    .requiredOption("--session-id <id>")
    .requiredOption("--title <title>")
    .action(
      withRuntime("sessions rename", async (ctx, args) => {
        const options = args[0] as { sessionId: string; title: string };
        await runApiCall(ctx, {
          command: "sessions rename",
          method: "POST",
          pathTemplate: "/api/sessions/:sessionId/rename",
          pathParams: {
            sessionId: options.sessionId
          },
          body: {
            title: options.title
          }
        });
      })
    );

  const sessionsProject = sessions.command("project").description("Session project assignment");
  sessionsProject
    .command("set")
    .requiredOption("--session-id <id>")
    .option("--project-id <id>")
    .option("--clear", "Assign to unassigned")
    .action(
      withRuntime("sessions project set", async (ctx, args) => {
        const options = args[0] as { sessionId: string; projectId?: string; clear?: boolean };
        await runApiCall(ctx, {
          command: "sessions project set",
          method: "POST",
          pathTemplate: "/api/sessions/:sessionId/project",
          pathParams: {
            sessionId: options.sessionId
          },
          body: {
            projectId: options.clear ? null : options.projectId ?? null
          },
          allowStatuses: [200, 404, 410]
        });
      })
    );

  sessions
    .command("archive")
    .requiredOption("--session-id <id>")
    .action(
      withRuntime("sessions archive", async (ctx, args) => {
        const options = args[0] as { sessionId: string };
        await runApiCall(ctx, {
          command: "sessions archive",
          method: "POST",
          pathTemplate: "/api/sessions/:sessionId/archive",
          pathParams: {
            sessionId: options.sessionId
          },
          body: {},
          allowStatuses: [200, 409, 410]
        });
      })
    );

  sessions
    .command("unarchive")
    .requiredOption("--session-id <id>")
    .action(
      withRuntime("sessions unarchive", async (ctx, args) => {
        const options = args[0] as { sessionId: string };
        await runApiCall(ctx, {
          command: "sessions unarchive",
          method: "POST",
          pathTemplate: "/api/sessions/:sessionId/unarchive",
          pathParams: {
            sessionId: options.sessionId
          },
          body: {}
        });
      })
    );

  sessions
    .command("send")
    .requiredOption("--session-id <id>")
    .requiredOption("--text <text>")
    .option("--model <model>")
    .option("--effort <effort>")
    .option("--approval-policy <policy>")
    .option("--network-access <mode>")
    .option("--filesystem-sandbox <mode>")
    .option("--dynamic-tools <json or @file>")
    .action(
      withRuntime("sessions send", async (ctx, args) => {
        const options = args[0] as {
          sessionId: string;
          text: string;
          model?: string;
          effort?: string;
          approvalPolicy?: string;
          networkAccess?: string;
          filesystemSandbox?: string;
          dynamicTools?: string;
        };
        const dynamicTools = options.dynamicTools ? await parseJsonInput(options.dynamicTools) : undefined;
        await runApiCall(ctx, {
          command: "sessions send",
          method: "POST",
          pathTemplate: "/api/sessions/:sessionId/messages",
          pathParams: {
            sessionId: options.sessionId
          },
          body: {
            text: options.text,
            ...(options.model ? { model: options.model } : {}),
            ...(options.effort ? { effort: options.effort } : {}),
            ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
            ...(options.networkAccess ? { networkAccess: options.networkAccess } : {}),
            ...(options.filesystemSandbox ? { filesystemSandbox: options.filesystemSandbox } : {}),
            ...(dynamicTools !== undefined ? { dynamicTools } : {})
          },
          allowStatuses: [202, 404, 410]
        });
      })
    );

  sessions
    .command("interrupt")
    .requiredOption("--session-id <id>")
    .option("--turn-id <id>")
    .action(
      withRuntime("sessions interrupt", async (ctx, args) => {
        const options = args[0] as { sessionId: string; turnId?: string };
        await runApiCall(ctx, {
          command: "sessions interrupt",
          method: "POST",
          pathTemplate: "/api/sessions/:sessionId/interrupt",
          pathParams: {
            sessionId: options.sessionId
          },
          body: options.turnId ? { turnId: options.turnId } : {},
          allowStatuses: [200, 409, 410]
        });
      })
    );

  sessions
    .command("steer")
    .requiredOption("--session-id <id>")
    .requiredOption("--turn-id <id>")
    .option("--input <text>")
    .option("--input-file <path>")
    .action(
      withRuntime("sessions steer", async (ctx, args) => {
        const options = args[0] as { sessionId: string; turnId: string; input?: string; inputFile?: string };
        const input = await parseTextInput({
          value: options.input,
          file: options.inputFile,
          field: "input",
          required: true
        });
        await runApiCall(ctx, {
          command: "sessions steer",
          method: "POST",
          pathTemplate: "/api/sessions/:sessionId/turns/:turnId/steer",
          pathParams: {
            sessionId: options.sessionId,
            turnId: options.turnId
          },
          body: {
            input
          },
          allowStatuses: [200, 400, 409, 410, 501]
        });
      })
    );

  sessions
    .command("fork")
    .requiredOption("--session-id <id>")
    .action(
      withRuntime("sessions fork", async (ctx, args) => {
        const options = args[0] as { sessionId: string };
        await runApiCall(ctx, {
          command: "sessions fork",
          method: "POST",
          pathTemplate: "/api/sessions/:sessionId/fork",
          pathParams: {
            sessionId: options.sessionId
          },
          body: {},
          allowStatuses: [200, 410, 501]
        });
      })
    );

  sessions
    .command("compact")
    .requiredOption("--session-id <id>")
    .action(
      withRuntime("sessions compact", async (ctx, args) => {
        const options = args[0] as { sessionId: string };
        await runApiCall(ctx, {
          command: "sessions compact",
          method: "POST",
          pathTemplate: "/api/sessions/:sessionId/compact",
          pathParams: {
            sessionId: options.sessionId
          },
          body: {},
          allowStatuses: [200, 410, 501]
        });
      })
    );

  sessions
    .command("rollback")
    .requiredOption("--session-id <id>")
    .option("--num-turns <n>", "Number of turns", "1")
    .action(
      withRuntime("sessions rollback", async (ctx, args) => {
        const options = args[0] as { sessionId: string; numTurns: string };
        await runApiCall(ctx, {
          command: "sessions rollback",
          method: "POST",
          pathTemplate: "/api/sessions/:sessionId/rollback",
          pathParams: {
            sessionId: options.sessionId
          },
          body: {
            numTurns: Number(options.numTurns)
          },
          allowStatuses: [200, 400, 409, 410, 501]
        });
      })
    );

  const sessionsBackground = sessions.command("background-terminals").description("Background terminal operations");
  sessionsBackground
    .command("clean")
    .requiredOption("--session-id <id>")
    .action(
      withRuntime("sessions background-terminals clean", async (ctx, args) => {
        const options = args[0] as { sessionId: string };
        await runApiCall(ctx, {
          command: "sessions background-terminals clean",
          method: "POST",
          pathTemplate: "/api/sessions/:sessionId/background-terminals/clean",
          pathParams: {
            sessionId: options.sessionId
          },
          body: {},
          allowStatuses: [200, 410, 501]
        });
      })
    );

  const sessionsReview = sessions.command("review").description("Review operations");
  sessionsReview
    .command("start")
    .requiredOption("--session-id <id>")
    .option("--delivery <delivery>")
    .option("--target-type <type>")
    .option("--branch <branch>")
    .option("--sha <sha>")
    .option("--title <title>")
    .option("--instructions <instructions>")
    .action(
      withRuntime("sessions review start", async (ctx, args) => {
        const options = args[0] as {
          sessionId: string;
          delivery?: string;
          targetType?: string;
          branch?: string;
          sha?: string;
          title?: string;
          instructions?: string;
        };
        await runApiCall(ctx, {
          command: "sessions review start",
          method: "POST",
          pathTemplate: "/api/sessions/:sessionId/review",
          pathParams: {
            sessionId: options.sessionId
          },
          body: {
            ...(options.delivery ? { delivery: options.delivery } : {}),
            ...(options.targetType ? { targetType: options.targetType } : {}),
            ...(options.branch ? { branch: options.branch } : {}),
            ...(options.sha ? { sha: options.sha } : {}),
            ...(options.title ? { title: options.title } : {}),
            ...(options.instructions ? { instructions: options.instructions } : {})
          },
          allowStatuses: [200, 410, 501]
        });
      })
    );

  const sessionsControls = sessions.command("controls").description("Session control tuple operations");
  sessionsControls
    .command("get")
    .requiredOption("--session-id <id>")
    .action(
      withRuntime("sessions controls get", async (ctx, args) => {
        const options = args[0] as { sessionId: string };
        await runApiCall(ctx, {
          command: "sessions controls get",
          method: "GET",
          pathTemplate: "/api/sessions/:sessionId/session-controls",
          pathParams: {
            sessionId: options.sessionId
          },
          allowStatuses: [200, 404, 410]
        });
      })
    );

  sessionsControls
    .command("apply")
    .requiredOption("--session-id <id>")
    .requiredOption("--scope <scope>", "session|default")
    .requiredOption("--approval-policy <policy>")
    .requiredOption("--network-access <mode>")
    .requiredOption("--filesystem-sandbox <mode>")
    .option("--model <model>")
    .option("--inherit-model", "Set model to null")
    .option("--actor <actor>")
    .option("--source <source>")
    .action(
      withRuntime("sessions controls apply", async (ctx, args) => {
        const options = args[0] as {
          sessionId: string;
          scope: "session" | "default";
          approvalPolicy: string;
          networkAccess: string;
          filesystemSandbox: string;
          model?: string;
          inheritModel?: boolean;
          actor?: string;
          source?: string;
        };
        await runApiCall(ctx, {
          command: "sessions controls apply",
          method: "POST",
          pathTemplate: "/api/sessions/:sessionId/session-controls",
          pathParams: {
            sessionId: options.sessionId
          },
          body: {
            scope: options.scope,
            controls: {
              model: options.inheritModel ? null : options.model ?? null,
              approvalPolicy: options.approvalPolicy,
              networkAccess: options.networkAccess,
              filesystemSandbox: options.filesystemSandbox
            },
            ...(options.actor ? { actor: options.actor } : {}),
            ...(options.source ? { source: options.source } : {})
          },
          allowStatuses: [200, 400, 404, 410, 423]
        });
      })
    );

  const sessionsSettings = sessions.command("settings").description("Generic session settings storage");
  sessionsSettings
    .command("get")
    .requiredOption("--session-id <id>")
    .option("--scope <scope>", "session|default", "session")
    .option("--key <key>", "Return a single key from settings")
    .action(
      withRuntime("sessions settings get", async (ctx, args) => {
        const options = args[0] as { sessionId: string; scope?: "session" | "default"; key?: string };
        const scope = options.scope === "default" ? "default" : "session";
        await runApiCall(ctx, {
          command: "sessions settings get",
          method: "GET",
          pathTemplate: "/api/sessions/:sessionId/settings",
          pathParams: {
            sessionId: options.sessionId
          },
          query: {
            scope,
            key: options.key
          },
          allowStatuses: [200, 404, 410]
        });
      })
    );

  sessionsSettings
    .command("set")
    .requiredOption("--session-id <id>")
    .requiredOption("--scope <scope>", "session|default")
    .option("--key <key>", "Top-level settings key to set")
    .option("--value <value>", "JSON value for --key (falls back to plain string)")
    .option("--value-file <path>", "File with value payload for --key")
    .option("--settings <json>", "JSON object payload")
    .option("--settings-file <path>", "Path to JSON object payload")
    .option("--mode <mode>", "merge|replace", "merge")
    .option("--actor <actor>")
    .option("--source <source>")
    .action(
      withRuntime("sessions settings set", async (ctx, args) => {
        const options = args[0] as {
          sessionId: string;
          scope: "session" | "default";
          key?: string;
          value?: string;
          valueFile?: string;
          settings?: string;
          settingsFile?: string;
          mode?: "merge" | "replace";
          actor?: string;
          source?: string;
        };
        const scope = options.scope === "default" ? "default" : "session";
        const key = options.key?.trim();
        const mode = options.mode === "replace" ? "replace" : "merge";
        const hasSettingsInput =
          (typeof options.settings === "string" && options.settings.trim().length > 0) ||
          (typeof options.settingsFile === "string" && options.settingsFile.trim().length > 0);

        if (key && hasSettingsInput) {
          throw new Error("--key/--value cannot be combined with --settings/--settings-file");
        }

        if (key) {
          const valueRaw = await parseTextInput({
            value: options.value,
            file: options.valueFile,
            field: "value",
            required: true
          });
          if (typeof valueRaw !== "string") {
            throw new Error("value payload is required");
          }
          const trimmedValue = valueRaw.trim();
          let parsedValue: unknown = valueRaw;
          if (trimmedValue.startsWith("@")) {
            parsedValue = await parseJsonInput(trimmedValue);
          } else {
            try {
              parsedValue = await parseJsonInput(valueRaw);
            } catch {
              parsedValue = valueRaw;
            }
          }

          await runApiCall(ctx, {
            command: "sessions settings set",
            method: "POST",
            pathTemplate: "/api/sessions/:sessionId/settings",
            pathParams: {
              sessionId: options.sessionId
            },
            body: {
              scope,
              key,
              value: parsedValue,
              ...(options.actor ? { actor: options.actor } : {}),
              ...(options.source ? { source: options.source } : {})
            },
            allowStatuses: [200, 400, 404, 410, 423]
          });
          return;
        }

        const settingsRaw = await parseTextInput({
          value: options.settings,
          file: options.settingsFile,
          field: "settings",
          required: true
        });
        if (typeof settingsRaw !== "string") {
          throw new Error("settings payload is required");
        }
        const parsedSettings = await parseJsonInput(settingsRaw);
        const nextSettingsInput = asObjectRecord(parsedSettings);
        if (!nextSettingsInput) {
          throw new Error("settings payload must be a JSON object");
        }

        await runApiCall(ctx, {
          command: "sessions settings set",
          method: "POST",
          pathTemplate: "/api/sessions/:sessionId/settings",
          pathParams: {
            sessionId: options.sessionId
          },
          body: {
            scope,
            settings: nextSettingsInput,
            mode,
            ...(options.actor ? { actor: options.actor } : {}),
            ...(options.source ? { source: options.source } : {})
          },
          allowStatuses: [200, 400, 404, 410, 423]
        });
      })
    );

  sessionsSettings
    .command("unset")
    .requiredOption("--session-id <id>")
    .requiredOption("--scope <scope>", "session|default")
    .requiredOption("--key <key>")
    .option("--actor <actor>")
    .option("--source <source>")
    .action(
      withRuntime("sessions settings unset", async (ctx, args) => {
        const options = args[0] as {
          sessionId: string;
          scope: "session" | "default";
          key: string;
          actor?: string;
          source?: string;
        };
        const scope = options.scope === "default" ? "default" : "session";
        await runApiCall(ctx, {
          command: "sessions settings unset",
          method: "DELETE",
          pathTemplate: "/api/sessions/:sessionId/settings/:key",
          pathParams: {
            sessionId: options.sessionId,
            key: options.key
          },
          query: {
            scope,
            actor: options.actor,
            source: options.source
          },
          allowStatuses: [200, 404, 410, 423]
        });
      })
    );

  const sessionsApprovalPolicy = sessions.command("approval-policy").description("Session approval policy");
  sessionsApprovalPolicy
    .command("set")
    .requiredOption("--session-id <id>")
    .requiredOption("--approval-policy <policy>")
    .action(
      withRuntime("sessions approval-policy set", async (ctx, args) => {
        const options = args[0] as { sessionId: string; approvalPolicy: string };
        await runApiCall(ctx, {
          command: "sessions approval-policy set",
          method: "POST",
          pathTemplate: "/api/sessions/:sessionId/approval-policy",
          pathParams: {
            sessionId: options.sessionId
          },
          body: {
            approvalPolicy: options.approvalPolicy
          },
          allowStatuses: [200, 404, 410]
        });
      })
    );

  const sessionsApprovals = sessions.command("approvals").description("Pending approvals");
  sessionsApprovals
    .command("list")
    .requiredOption("--session-id <id>")
    .action(
      withRuntime("sessions approvals list", async (ctx, args) => {
        const options = args[0] as { sessionId: string };
        await runApiCall(ctx, {
          command: "sessions approvals list",
          method: "GET",
          pathTemplate: "/api/sessions/:sessionId/approvals",
          pathParams: {
            sessionId: options.sessionId
          },
          allowStatuses: [200, 410]
        });
      })
    );

  const sessionsToolInput = sessions.command("tool-input").description("Pending tool-input requests");
  sessionsToolInput
    .command("list")
    .requiredOption("--session-id <id>")
    .action(
      withRuntime("sessions tool-input list", async (ctx, args) => {
        const options = args[0] as { sessionId: string };
        await runApiCall(ctx, {
          command: "sessions tool-input list",
          method: "GET",
          pathTemplate: "/api/sessions/:sessionId/tool-input",
          pathParams: {
            sessionId: options.sessionId
          },
          allowStatuses: [200, 410]
        });
      })
    );

  const sessionsToolCalls = sessions.command("tool-calls").description("Pending dynamic tool-call requests");
  sessionsToolCalls
    .command("list")
    .requiredOption("--session-id <id>")
    .action(
      withRuntime("sessions tool-calls list", async (ctx, args) => {
        const options = args[0] as { sessionId: string };
        await runApiCall(ctx, {
          command: "sessions tool-calls list",
          method: "GET",
          pathTemplate: "/api/sessions/:sessionId/tool-calls",
          pathParams: {
            sessionId: options.sessionId
          },
          allowStatuses: [200, 403, 410]
        });
      })
    );

  const sessionsTranscript = sessions.command("transcript").description("Supplemental transcript operations");
  sessionsTranscript
    .command("upsert")
    .requiredOption("--session-id <id>")
    .requiredOption("--message-id <id>")
    .requiredOption("--turn-id <id>")
    .requiredOption("--entry-role <role>")
    .requiredOption("--type <type>")
    .option("--content <content>")
    .option("--content-file <path>")
    .requiredOption("--status <status>")
    .option("--details <details>")
    .option("--details-file <path>")
    .option("--started-at <epoch-ms>")
    .option("--completed-at <epoch-ms>")
    .action(
      withRuntime("sessions transcript upsert", async (ctx, args) => {
        const options = args[0] as {
          sessionId: string;
          messageId: string;
          turnId: string;
          entryRole: "user" | "assistant" | "system";
          type: string;
          content?: string;
          contentFile?: string;
          status: "streaming" | "complete" | "canceled" | "error";
          details?: string;
          detailsFile?: string;
          startedAt?: string;
          completedAt?: string;
        };
        const content = await parseTextInput({
          value: options.content,
          file: options.contentFile,
          field: "content",
          required: true
        });
        const details = await parseTextInput({
          value: options.details,
          file: options.detailsFile,
          field: "details"
        });
        await runApiCall(ctx, {
          command: "sessions transcript upsert",
          method: "POST",
          pathTemplate: "/api/sessions/:sessionId/transcript/upsert",
          pathParams: {
            sessionId: options.sessionId
          },
          body: {
            messageId: options.messageId,
            turnId: options.turnId,
            role: options.entryRole,
            type: options.type,
            content,
            status: options.status,
            ...(typeof details === "string" ? { details } : {}),
            ...(options.startedAt ? { startedAt: Number(options.startedAt) } : {}),
            ...(options.completedAt ? { completedAt: Number(options.completedAt) } : {})
          },
          allowStatuses: [200, 404, 410]
        });
      })
    );

  const sessionsSuggest = sessions.command("suggest-request").description("Suggested request operations");
  sessionsSuggest
    .command("run")
    .requiredOption("--session-id <id>")
    .option("--model <model>")
    .option("--effort <effort>")
    .option("--draft <draft>")
    .action(
      withRuntime("sessions suggest-request run", async (ctx, args) => {
        const options = args[0] as { sessionId: string; model?: string; effort?: string; draft?: string };
        await runApiCall(ctx, {
          command: "sessions suggest-request run",
          method: "POST",
          pathTemplate: "/api/sessions/:sessionId/suggested-request",
          pathParams: {
            sessionId: options.sessionId
          },
          body: {
            ...(options.model ? { model: options.model } : {}),
            ...(options.effort ? { effort: options.effort } : {}),
            ...(options.draft ? { draft: options.draft } : {})
          },
          allowStatuses: [200, 202, 404, 409, 410]
        });
      })
    );

  sessionsSuggest
    .command("enqueue")
    .requiredOption("--session-id <id>")
    .option("--model <model>")
    .option("--effort <effort>")
    .option("--draft <draft>")
    .action(
      withRuntime("sessions suggest-request enqueue", async (ctx, args) => {
        const options = args[0] as { sessionId: string; model?: string; effort?: string; draft?: string };
        await runApiCall(ctx, {
          command: "sessions suggest-request enqueue",
          method: "POST",
          pathTemplate: "/api/sessions/:sessionId/suggested-request/jobs",
          pathParams: {
            sessionId: options.sessionId
          },
          body: {
            ...(options.model ? { model: options.model } : {}),
            ...(options.effort ? { effort: options.effort } : {}),
            ...(options.draft ? { draft: options.draft } : {})
          },
          allowStatuses: [202, 404, 409, 410]
        });
      })
    );

  sessionsSuggest
    .command("upsert")
    .requiredOption("--session-id <id>")
    .requiredOption("--request-key <key>")
    .requiredOption("--status <status>", "streaming|complete|error|canceled")
    .option("--suggestion <text>")
    .option("--suggestion-file <path>")
    .option("--error <message>")
    .action(
      withRuntime("sessions suggest-request upsert", async (ctx, args) => {
        const options = args[0] as {
          sessionId: string;
          requestKey: string;
          status: "streaming" | "complete" | "error" | "canceled";
          suggestion?: string;
          suggestionFile?: string;
          error?: string;
        };
        const suggestion = await parseTextInput({
          value: options.suggestion,
          file: options.suggestionFile,
          field: "suggestion",
          required: options.status === "complete"
        });

        await runApiCall(ctx, {
          command: "sessions suggest-request upsert",
          method: "POST",
          pathTemplate: "/api/sessions/:sessionId/suggested-request/upsert",
          pathParams: {
            sessionId: options.sessionId
          },
          body: {
            requestKey: options.requestKey,
            status: options.status,
            ...(typeof suggestion === "string" ? { suggestion } : {}),
            ...(options.error ? { error: options.error } : {})
          },
          allowStatuses: [200, 400, 403, 404, 410]
        });
      })
    );

  const approvals = program.command("approvals").description("Approval decision endpoints");
  approvals
    .command("decide")
    .requiredOption("--approval-id <id>")
    .requiredOption("--decision <decision>", "accept|decline|cancel")
    .option("--scope <scope>", "turn|session", "turn")
    .action(
      withRuntime("approvals decide", async (ctx, args) => {
        const options = args[0] as { approvalId: string; decision: string; scope: string };
        await runApiCall(ctx, {
          command: "approvals decide",
          method: "POST",
          pathTemplate: "/api/approvals/:approvalId/decision",
          pathParams: {
            approvalId: options.approvalId
          },
          body: {
            decision: options.decision,
            scope: options.scope
          },
          allowStatuses: [200, 404, 409, 500]
        });
      })
    );

  const toolCalls = program.command("tool-calls").description("Dynamic tool-call response endpoints");
  toolCalls
    .command("respond")
    .requiredOption("--request-id <id>")
    .option("--success <value>", "true|false")
    .option("--text <text>", "Convenience text response")
    .option("--content-items <json or @file>", "Dynamic tool-call contentItems payload")
    .option("--response <json or @file>", "Raw response payload")
    .action(
      withRuntime("tool-calls respond", async (ctx, args) => {
        const options = args[0] as {
          requestId: string;
          success?: string;
          text?: string;
          contentItems?: string;
          response?: string;
        };
        const body: Record<string, unknown> = {};
        if (typeof options.success === "string") {
          const normalized = options.success.trim().toLowerCase();
          if (normalized !== "true" && normalized !== "false") {
            throw new Error("--success must be true or false");
          }
          body.success = normalized === "true";
        }
        if (typeof options.text === "string") {
          body.text = options.text;
        }
        if (options.contentItems) {
          body.contentItems = await parseJsonInput(options.contentItems);
        }
        if (options.response) {
          body.response = await parseJsonInput(options.response);
        }

        await runApiCall(ctx, {
          command: "tool-calls respond",
          method: "POST",
          pathTemplate: "/api/tool-calls/:requestId/response",
          pathParams: {
            requestId: options.requestId
          },
          body,
          allowStatuses: [200, 404, 409, 500]
        });
      })
    );

  const toolInput = program.command("tool-input").description("Tool input decision endpoints");
  toolInput
    .command("decide")
    .requiredOption("--request-id <id>")
    .requiredOption("--decision <decision>", "accept|decline|cancel")
    .option("--answers <json or @file>", "Answers payload for question-based input")
    .option("--response <json or @file>", "Raw response payload")
    .action(
      withRuntime("tool-input decide", async (ctx, args) => {
        const options = args[0] as { requestId: string; decision: string; answers?: string; response?: string };
        const body: Record<string, unknown> = {
          decision: options.decision
        };
        if (options.answers) {
          body.answers = await parseJsonInput(options.answers);
        }
        if (options.response) {
          body.response = await parseJsonInput(options.response);
        }

        await runApiCall(ctx, {
          command: "tool-input decide",
          method: "POST",
          pathTemplate: "/api/tool-input/:requestId/decision",
          pathParams: {
            requestId: options.requestId
          },
          body,
          allowStatuses: [200, 404, 500]
        });
      })
    );

  const stream = program.command("stream").description("WebSocket stream operations");
  stream
    .command("events")
    .option("--thread-id <id>", "Initial thread filter")
    .option("--subscribe <id>", "Send subscribe command after connect")
    .option("--jsonl", "Output raw event JSON lines")
    .option("--duration-ms <n>", "Close stream after duration")
    .option("--ping-interval-ms <n>", "Send ws ping command interval")
    .action(
      withRuntime("stream events", async (ctx, args) => {
        const options = args[0] as {
          threadId?: string;
          subscribe?: string;
          jsonl?: boolean;
          durationMs?: string;
          pingIntervalMs?: string;
        };

        const url = toWebSocketUrl(ctx, "/api/stream", {
          threadId: options.threadId
        });

        const ws = new WebSocket(url, {
          headers: ctx.headers
        });

        let done = false;
        let pingTimer: NodeJS.Timeout | null = null;
        let durationTimer: NodeJS.Timeout | null = null;

        const cleanup = (): void => {
          if (pingTimer) {
            clearInterval(pingTimer);
          }
          if (durationTimer) {
            clearTimeout(durationTimer);
          }
        };

        await new Promise<void>((resolve, reject) => {
          ws.on("open", () => {
            if (options.subscribe) {
              ws.send(JSON.stringify({ type: "subscribe", threadId: options.subscribe }));
            }
            if (options.pingIntervalMs) {
              const interval = Math.max(100, Number(options.pingIntervalMs));
              if (Number.isFinite(interval)) {
                pingTimer = setInterval(() => {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "ping" }));
                  }
                }, interval);
              }
            }
            if (options.durationMs) {
              const duration = Math.max(1, Number(options.durationMs));
              if (Number.isFinite(duration)) {
                durationTimer = setTimeout(() => {
                  ws.close(1000, "duration_elapsed");
                }, duration);
              }
            }
          });

          ws.on("message", (raw) => {
            const text = typeof raw === "string" ? raw : raw.toString("utf8");
            if (options.jsonl) {
              process.stdout.write(`${text}\n`);
              return;
            }
            try {
              const parsed = JSON.parse(text) as Record<string, unknown>;
              const eventType = typeof parsed.type === "string" ? parsed.type : "event";
              process.stdout.write(`${eventType} ${JSON.stringify(parsed)}\n`);
            } catch {
              process.stdout.write(`${text}\n`);
            }
          });

          ws.on("close", () => {
            cleanup();
            if (!done) {
              done = true;
              resolve();
            }
          });

          ws.on("error", (error) => {
            cleanup();
            if (!done) {
              done = true;
              reject(error);
            }
          });
        });
      })
    );

  const api = program.command("api").description("Raw API fallback");
  api
    .command("request")
    .requiredOption("--method <method>")
    .requiredOption("--path <path>")
    .option("--query <key=value>", "Query string key/value", (value, all: Array<string>) => [...all, value], [])
    .option("--body <json or @file>")
    .option("--allow-status <codes>", "Comma-separated HTTP status codes", "200")
    .option("--header <key:value>", "Extra request header", (value, all: Array<string>) => [...all, value], [])
    .action(
      withRuntime("api request", async (ctx, args) => {
        const options = args[0] as {
          method: string;
          path: string;
          query: Array<string>;
          body?: string;
          allowStatus: string;
          header: Array<string>;
        };

        const method = options.method.trim().toUpperCase() as InvokeApiInput["method"];
        if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
          throw new Error("--method must be one of GET, POST, PUT, PATCH, DELETE");
        }

        const body = options.body ? await parseJsonInput(options.body) : undefined;
        const headers = Object.fromEntries(
          options.header
            .map((entry) => {
              const idx = entry.indexOf(":");
              if (idx <= 0) {
                return null;
              }
              return [entry.slice(0, idx).trim(), entry.slice(idx + 1).trim()] as const;
            })
            .filter((entry): entry is readonly [string, string] => Boolean(entry && entry[0]))
        );

        await runApiCall(ctx, {
          command: "api request",
          method,
          pathTemplate: options.path,
          query: parseKeyValuePairs(Array.isArray(options.query) ? options.query : []),
          body,
          headers,
          allowStatuses: parseStatusList(options.allowStatus)
        });
      })
    );

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  const argv = [...process.argv];
  // pnpm script forwarding can inject a leading standalone "--" before command args.
  // Commander interprets that token as end-of-options and then treats subsequent
  // global flags as positional args, so normalize it away for a smoother UX.
  if (argv[2] === "--") {
    argv.splice(2, 1);
  }
  await program.parseAsync(argv);
}

main().catch((error) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
