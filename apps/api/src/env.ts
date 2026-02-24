import { existsSync } from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  CODEX_BIN: z.string().min(1).default("codex"),
  CODEX_HOME: z.string().min(1).optional(),
  DATA_DIR: z.string().min(1).default(".data"),
  OPENAI_API_KEY: z.string().optional(),
  DEFAULT_APPROVAL_POLICY: z.enum(["untrusted", "on-failure", "on-request", "never"]).default("untrusted"),
  DEFAULT_SANDBOX_MODE: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("read-only"),
  DEFAULT_NETWORK_ACCESS: z.enum(["restricted", "enabled"]).default("restricted"),
  SESSION_DEFAULTS_LOCKED: z.enum(["true", "false"]).default("false"),
  ORCHESTRATOR_QUEUE_ENABLED: z.enum(["true", "false"]).default("true"),
  ORCHESTRATOR_QUEUE_GLOBAL_CONCURRENCY: z.coerce.number().int().positive().default(2),
  ORCHESTRATOR_QUEUE_MAX_PER_PROJECT: z.coerce.number().int().positive().default(100),
  ORCHESTRATOR_QUEUE_MAX_GLOBAL: z.coerce.number().int().positive().default(500),
  ORCHESTRATOR_QUEUE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(2),
  ORCHESTRATOR_QUEUE_DEFAULT_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  ORCHESTRATOR_QUEUE_BACKGROUND_AGING_MS: z.coerce.number().int().min(0).default(15_000),
  ORCHESTRATOR_QUEUE_MAX_INTERACTIVE_BURST: z.coerce.number().int().positive().default(3),
  ORCHESTRATOR_SUGGEST_REQUEST_ENABLED: z.enum(["true", "false"]).default("true"),
  ORCHESTRATOR_SUGGEST_REQUEST_WAIT_MS: z.coerce.number().int().positive().default(12_000),
  ORCHESTRATOR_AGENT_TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  ORCHESTRATOR_AGENT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(350),
  ORCHESTRATOR_AGENT_INCLUDE_TURNS_GRACE_MS: z.coerce.number().int().positive().default(3_000),
  ORCHESTRATOR_AGENT_UNTRUSTED_TERMINAL_GRACE_MS: z.coerce.number().int().positive().default(3_000),
  ORCHESTRATOR_AGENT_EMPTY_TURN_GRACE_MS: z.coerce.number().int().positive().default(8_000),
  AGENT_EXTENSION_RBAC_MODE: z.enum(["disabled", "header", "jwt"]).default("disabled"),
  AGENT_EXTENSION_ALLOW_INSECURE_HEADER_MODE: z.enum(["true", "false"]).default("false"),
  AGENT_EXTENSION_RBAC_HEADER_SECRET: z.string().optional(),
  AGENT_EXTENSION_RBAC_JWT_SECRET: z.string().optional(),
  AGENT_EXTENSION_RBAC_JWT_ISSUER: z.string().optional(),
  AGENT_EXTENSION_RBAC_JWT_AUDIENCE: z.string().optional(),
  AGENT_EXTENSION_RBAC_JWT_ROLE_CLAIM: z.string().default("role"),
  AGENT_EXTENSION_RBAC_JWT_ACTOR_CLAIM: z.string().default("sub"),
  AGENT_EXTENSION_TRUST_MODE: z.enum(["disabled", "warn", "enforced"]).default("warn"),
  AGENT_EXTENSION_CONFIGURED_ROOTS: z.string().default(""),
  AGENT_EXTENSION_PACKAGE_ROOTS: z.string().default("")
});

const parsed = envSchema.parse(process.env);

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

if (parsed.AGENT_EXTENSION_RBAC_MODE === "header") {
  if (parsed.AGENT_EXTENSION_ALLOW_INSECURE_HEADER_MODE !== "true" && !isLoopbackHost(parsed.HOST)) {
    throw new Error(
      `AGENT_EXTENSION_RBAC_MODE=header requires loopback HOST or AGENT_EXTENSION_ALLOW_INSECURE_HEADER_MODE=true (received HOST=${parsed.HOST})`
    );
  }
  if (
    parsed.AGENT_EXTENSION_ALLOW_INSECURE_HEADER_MODE !== "true" &&
    (!parsed.AGENT_EXTENSION_RBAC_HEADER_SECRET || parsed.AGENT_EXTENSION_RBAC_HEADER_SECRET.trim().length === 0)
  ) {
    throw new Error(
      "AGENT_EXTENSION_RBAC_MODE=header requires AGENT_EXTENSION_RBAC_HEADER_SECRET unless AGENT_EXTENSION_ALLOW_INSECURE_HEADER_MODE=true"
    );
  }
}

if (parsed.AGENT_EXTENSION_RBAC_MODE === "jwt" && (!parsed.AGENT_EXTENSION_RBAC_JWT_SECRET || parsed.AGENT_EXTENSION_RBAC_JWT_SECRET.trim().length === 0)) {
  throw new Error("AGENT_EXTENSION_RBAC_MODE=jwt requires AGENT_EXTENSION_RBAC_JWT_SECRET");
}

function findWorkspaceRoot(startDir: string): string {
  let current = startDir;

  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return startDir;
    }

    current = parent;
  }
}

const workspaceRoot = findWorkspaceRoot(process.cwd());

function resolveFromWorkspaceRoot(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(workspaceRoot, value);
}

export const env = {
  ...parsed,
  AGENT_EXTENSION_ALLOW_INSECURE_HEADER_MODE: parsed.AGENT_EXTENSION_ALLOW_INSECURE_HEADER_MODE === "true",
  AGENT_EXTENSION_RBAC_HEADER_SECRET:
    typeof parsed.AGENT_EXTENSION_RBAC_HEADER_SECRET === "string" && parsed.AGENT_EXTENSION_RBAC_HEADER_SECRET.trim().length > 0
      ? parsed.AGENT_EXTENSION_RBAC_HEADER_SECRET.trim()
      : undefined,
  SESSION_DEFAULTS_LOCKED: parsed.SESSION_DEFAULTS_LOCKED === "true",
  ORCHESTRATOR_QUEUE_ENABLED: parsed.ORCHESTRATOR_QUEUE_ENABLED === "true",
  ORCHESTRATOR_SUGGEST_REQUEST_ENABLED: parsed.ORCHESTRATOR_SUGGEST_REQUEST_ENABLED === "true",
  WORKSPACE_ROOT: workspaceRoot,
  DATA_DIR: resolveFromWorkspaceRoot(parsed.DATA_DIR),
  CODEX_HOME: parsed.CODEX_HOME ? resolveFromWorkspaceRoot(parsed.CODEX_HOME) : undefined
};
