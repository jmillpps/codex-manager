import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type CliAuthConfig = {
  bearer: string | null;
  rbacToken: string | null;
  role: string | null;
  actor: string | null;
};

export type CliProfile = {
  baseUrl: string;
  apiPrefix: string;
  timeoutMs: number;
  headers: Record<string, string>;
  auth: CliAuthConfig;
};

export type CliConfigStore = {
  currentProfile: string;
  profiles: Record<string, CliProfile>;
};

const DEFAULT_PROFILE_NAME = "local";

export const DEFAULT_PROFILE: CliProfile = {
  baseUrl: "http://127.0.0.1:3001",
  apiPrefix: "/api",
  timeoutMs: 30_000,
  headers: {},
  auth: {
    bearer: null,
    rbacToken: null,
    role: null,
    actor: null
  }
};

export function configFilePath(): string {
  const root = process.env.XDG_CONFIG_HOME
    ? process.env.XDG_CONFIG_HOME
    : path.join(homedir(), ".config");
  return path.join(root, "codex-manager", "cli", "config.json");
}

function normalizePrefix(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "/api";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeProfile(input: Partial<CliProfile> | undefined): CliProfile {
  const headers =
    input?.headers && typeof input.headers === "object" && !Array.isArray(input.headers)
      ? Object.fromEntries(
          Object.entries(input.headers)
            .filter(([key, value]) => key.trim().length > 0 && typeof value === "string")
            .map(([key, value]) => [key, value])
        )
      : {};

  const auth = input?.auth && typeof input.auth === "object" ? input.auth : DEFAULT_PROFILE.auth;

  return {
    baseUrl:
      typeof input?.baseUrl === "string" && input.baseUrl.trim().length > 0
        ? input.baseUrl.trim()
        : DEFAULT_PROFILE.baseUrl,
    apiPrefix:
      typeof input?.apiPrefix === "string" && input.apiPrefix.trim().length > 0
        ? normalizePrefix(input.apiPrefix)
        : DEFAULT_PROFILE.apiPrefix,
    timeoutMs:
      typeof input?.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
        ? Math.floor(input.timeoutMs)
        : DEFAULT_PROFILE.timeoutMs,
    headers,
    auth: {
      bearer: typeof auth.bearer === "string" && auth.bearer.trim().length > 0 ? auth.bearer.trim() : null,
      rbacToken:
        typeof auth.rbacToken === "string" && auth.rbacToken.trim().length > 0 ? auth.rbacToken.trim() : null,
      role: typeof auth.role === "string" && auth.role.trim().length > 0 ? auth.role.trim() : null,
      actor: typeof auth.actor === "string" && auth.actor.trim().length > 0 ? auth.actor.trim() : null
    }
  };
}

export async function loadCliConfig(): Promise<CliConfigStore> {
  const file = configFilePath();
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<CliConfigStore>;
    const profiles =
      parsed && parsed.profiles && typeof parsed.profiles === "object"
        ? Object.fromEntries(
            Object.entries(parsed.profiles).map(([name, profile]) => [name, normalizeProfile(profile as Partial<CliProfile>)])
          )
        : {};

    if (!(DEFAULT_PROFILE_NAME in profiles)) {
      profiles[DEFAULT_PROFILE_NAME] = { ...DEFAULT_PROFILE };
    }

    const currentProfile =
      typeof parsed.currentProfile === "string" && parsed.currentProfile in profiles
        ? parsed.currentProfile
        : DEFAULT_PROFILE_NAME;

    return {
      currentProfile,
      profiles
    };
  } catch {
    return {
      currentProfile: DEFAULT_PROFILE_NAME,
      profiles: {
        [DEFAULT_PROFILE_NAME]: { ...DEFAULT_PROFILE }
      }
    };
  }
}

export async function saveCliConfig(config: CliConfigStore): Promise<void> {
  const file = configFilePath();
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function resolveProfile(config: CliConfigStore, profileName?: string): { name: string; profile: CliProfile } {
  const name = profileName && profileName.trim().length > 0 ? profileName.trim() : config.currentProfile;
  const profile = config.profiles[name] ?? config.profiles[DEFAULT_PROFILE_NAME] ?? DEFAULT_PROFILE;
  return {
    name,
    profile: normalizeProfile(profile)
  };
}

export async function upsertProfile(
  profileName: string,
  mutator: (current: CliProfile) => CliProfile
): Promise<{ config: CliConfigStore; profileName: string; profile: CliProfile }> {
  const config = await loadCliConfig();
  const trimmed = profileName.trim();
  if (!trimmed) {
    throw new Error("profile name is required");
  }

  const current = normalizeProfile(config.profiles[trimmed]);
  const next = normalizeProfile(mutator(current));
  config.profiles[trimmed] = next;
  if (!config.currentProfile || !(config.currentProfile in config.profiles)) {
    config.currentProfile = trimmed;
  }
  await saveCliConfig(config);
  return {
    config,
    profileName: trimmed,
    profile: next
  };
}

export async function setCurrentProfile(profileName: string): Promise<CliConfigStore> {
  const config = await loadCliConfig();
  const trimmed = profileName.trim();
  if (!trimmed) {
    throw new Error("profile name is required");
  }
  if (!(trimmed in config.profiles)) {
    throw new Error(`profile not found: ${trimmed}`);
  }
  config.currentProfile = trimmed;
  await saveCliConfig(config);
  return config;
}
