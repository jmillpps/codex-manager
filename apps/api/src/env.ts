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
  DEFAULT_SANDBOX_MODE: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("read-only")
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
  WORKSPACE_ROOT: workspaceRoot,
  DATA_DIR: resolveFromWorkspaceRoot(parsed.DATA_DIR),
  CODEX_HOME: parsed.CODEX_HOME ? resolveFromWorkspaceRoot(parsed.CODEX_HOME) : undefined
};
