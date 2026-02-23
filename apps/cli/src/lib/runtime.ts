import type { Command } from "commander";
import { loadCliConfig, resolveProfile, type CliConfigStore } from "./config.js";

export type GlobalOptions = {
  profile?: string;
  baseUrl?: string;
  apiPrefix?: string;
  timeoutMs?: string;
  json?: boolean;
  verbose?: boolean;
  bearer?: string;
  rbacToken?: string;
  role?: string;
  actor?: string;
  headers?: string[];
};

export type RuntimeContext = {
  commandName: string;
  config: CliConfigStore;
  profileName: string;
  baseUrl: string;
  apiPrefix: string;
  timeoutMs: number;
  outputJson: boolean;
  verbose: boolean;
  headers: Record<string, string>;
};

function parseHeaderPairs(values: Array<string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of values) {
    const index = entry.indexOf(":");
    if (index <= 0) {
      continue;
    }
    const key = entry.slice(0, index).trim();
    const value = entry.slice(index + 1).trim();
    if (!key) {
      continue;
    }
    headers[key] = value;
  }
  return headers;
}

function normalizeApiPrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed) {
    return "/api";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export async function buildRuntime(command: Command): Promise<RuntimeContext> {
  const opts = command.optsWithGlobals<GlobalOptions>();
  const config = await loadCliConfig();
  const { name: profileName, profile } = resolveProfile(config, opts.profile);

  const timeoutFromFlag =
    typeof opts.timeoutMs === "string" && opts.timeoutMs.trim().length > 0
      ? Number(opts.timeoutMs)
      : Number.NaN;

  const timeoutFromEnv =
    typeof process.env.CODEX_MANAGER_TIMEOUT_MS === "string" && process.env.CODEX_MANAGER_TIMEOUT_MS.trim().length > 0
      ? Number(process.env.CODEX_MANAGER_TIMEOUT_MS)
      : Number.NaN;

  const timeoutMs = Number.isFinite(timeoutFromFlag) && timeoutFromFlag > 0
    ? Math.floor(timeoutFromFlag)
    : Number.isFinite(timeoutFromEnv) && timeoutFromEnv > 0
      ? Math.floor(timeoutFromEnv)
      : profile.timeoutMs;

  const baseUrl =
    (opts.baseUrl && opts.baseUrl.trim().length > 0
      ? opts.baseUrl.trim()
      : process.env.CODEX_MANAGER_API_BASE && process.env.CODEX_MANAGER_API_BASE.trim().length > 0
        ? process.env.CODEX_MANAGER_API_BASE.trim()
        : profile.baseUrl).replace(/\/$/, "");

  const apiPrefix = normalizeApiPrefix(
    opts.apiPrefix && opts.apiPrefix.trim().length > 0
      ? opts.apiPrefix
      : process.env.CODEX_MANAGER_API_PREFIX && process.env.CODEX_MANAGER_API_PREFIX.trim().length > 0
        ? process.env.CODEX_MANAGER_API_PREFIX
        : profile.apiPrefix
  );

  const headers: Record<string, string> = {
    ...profile.headers,
    ...parseHeaderPairs(Array.isArray(opts.headers) ? opts.headers : [])
  };

  const bearer =
    opts.bearer && opts.bearer.trim().length > 0
      ? opts.bearer.trim()
      : process.env.CODEX_MANAGER_BEARER_TOKEN && process.env.CODEX_MANAGER_BEARER_TOKEN.trim().length > 0
        ? process.env.CODEX_MANAGER_BEARER_TOKEN.trim()
        : profile.auth.bearer;

  const rbacToken =
    opts.rbacToken && opts.rbacToken.trim().length > 0
      ? opts.rbacToken.trim()
      : process.env.CODEX_MANAGER_RBAC_TOKEN && process.env.CODEX_MANAGER_RBAC_TOKEN.trim().length > 0
        ? process.env.CODEX_MANAGER_RBAC_TOKEN.trim()
        : profile.auth.rbacToken;

  const role =
    opts.role && opts.role.trim().length > 0
      ? opts.role.trim()
      : process.env.CODEX_MANAGER_RBAC_ROLE && process.env.CODEX_MANAGER_RBAC_ROLE.trim().length > 0
        ? process.env.CODEX_MANAGER_RBAC_ROLE.trim()
        : profile.auth.role;

  const actor =
    opts.actor && opts.actor.trim().length > 0
      ? opts.actor.trim()
      : process.env.CODEX_MANAGER_RBAC_ACTOR && process.env.CODEX_MANAGER_RBAC_ACTOR.trim().length > 0
        ? process.env.CODEX_MANAGER_RBAC_ACTOR.trim()
        : profile.auth.actor;

  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  }
  if (rbacToken) {
    headers["x-codex-rbac-token"] = rbacToken;
  }
  if (role) {
    headers["x-codex-role"] = role;
  }
  if (actor) {
    headers["x-codex-actor"] = actor;
  }

  return {
    commandName: command.name(),
    config,
    profileName,
    baseUrl,
    apiPrefix,
    timeoutMs,
    outputJson: Boolean(opts.json),
    verbose: Boolean(opts.verbose),
    headers
  };
}
