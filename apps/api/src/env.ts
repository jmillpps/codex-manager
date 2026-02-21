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
  ORCHESTRATOR_SUGGEST_REPLY_ENABLED: z.enum(["true", "false"]).default("true"),
  ORCHESTRATOR_SUGGEST_REPLY_ALLOW_HELPER_FALLBACK: z.enum(["true", "false"]).default("false"),
  ORCHESTRATOR_SUGGEST_REPLY_WAIT_MS: z.coerce.number().int().positive().default(12_000),
  ORCHESTRATOR_DIFF_EXPLAIN_ENABLED: z.enum(["true", "false"]).default("true"),
  ORCHESTRATOR_DIFF_EXPLAIN_MAX_DIFF_CHARS: z.coerce.number().int().positive().default(50_000),
  ORCHESTRATOR_SUPERVISOR_INSIGHT_ENABLED: z.enum(["true", "false"]).default("true"),
  ORCHESTRATOR_RISK_RECHECK_ENABLED: z.enum(["true", "false"]).default("true"),
  ORCHESTRATOR_TURN_SUPERVISOR_REVIEW_ENABLED: z.enum(["true", "false"]).default("true"),
  ORCHESTRATOR_RISK_RECHECK_MAX_CONCURRENCY: z.coerce.number().int().positive().default(3),
  ORCHESTRATOR_RISK_RECHECK_PER_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000)
});

const parsed = envSchema.parse(process.env);

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
  SESSION_DEFAULTS_LOCKED: parsed.SESSION_DEFAULTS_LOCKED === "true",
  ORCHESTRATOR_QUEUE_ENABLED: parsed.ORCHESTRATOR_QUEUE_ENABLED === "true",
  ORCHESTRATOR_SUGGEST_REPLY_ENABLED: parsed.ORCHESTRATOR_SUGGEST_REPLY_ENABLED === "true",
  ORCHESTRATOR_SUGGEST_REPLY_ALLOW_HELPER_FALLBACK: parsed.ORCHESTRATOR_SUGGEST_REPLY_ALLOW_HELPER_FALLBACK === "true",
  ORCHESTRATOR_DIFF_EXPLAIN_ENABLED: parsed.ORCHESTRATOR_DIFF_EXPLAIN_ENABLED === "true",
  ORCHESTRATOR_SUPERVISOR_INSIGHT_ENABLED: parsed.ORCHESTRATOR_SUPERVISOR_INSIGHT_ENABLED === "true",
  ORCHESTRATOR_RISK_RECHECK_ENABLED: parsed.ORCHESTRATOR_RISK_RECHECK_ENABLED === "true",
  ORCHESTRATOR_TURN_SUPERVISOR_REVIEW_ENABLED: parsed.ORCHESTRATOR_TURN_SUPERVISOR_REVIEW_ENABLED === "true",
  WORKSPACE_ROOT: workspaceRoot,
  DATA_DIR: resolveFromWorkspaceRoot(parsed.DATA_DIR),
  CODEX_HOME: parsed.CODEX_HOME ? resolveFromWorkspaceRoot(parsed.CODEX_HOME) : undefined
};
