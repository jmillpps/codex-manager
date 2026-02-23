import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";

export type AgentExtensionOriginType = "repo_local" | "installed_package" | "configured_root";

export type AgentExtensionOrigin = {
  type: AgentExtensionOriginType;
  path: string;
};

export type AgentRuntimeCompatibilityInput = {
  coreVersion: number;
  runtimeProfileId: string;
  runtimeProfileVersion: string;
};

export type AgentExtensionManifest = {
  name: string;
  version: string;
  agentId: string;
  displayName: string;
  runtime?: {
    coreApiVersion?: number;
    coreApiVersionRange?: string;
    profiles?: Array<{
      name: string;
      version?: string;
      versionRange?: string;
    }>;
  };
  entrypoints?: {
    events?: string;
    orientation?: string;
    instructions?: string;
    config?: string;
  };
  capabilities?: {
    events?: Array<string>;
    actions?: Array<string>;
  };
};

export type AgentExtensionCompatibilitySummary = {
  apiVersion: number | null;
  apiVersionRange: string | null;
  runtimeVersion: number;
  profileId: string;
  profileVersion: string;
  compatible: boolean;
  reasons: Array<string>;
};

export type LoadedAgentExtensionInventory = {
  moduleName: string;
  name: string;
  version: string;
  agentId: string;
  displayName: string;
  manifestPath: string | null;
  entrypointPath: string;
  events: Array<string>;
  origin: AgentExtensionOrigin;
  compatibility: AgentExtensionCompatibilitySummary;
  capabilities: {
    events: Array<string>;
    actions: Array<string>;
  };
  trust: {
    mode: "disabled" | "warn" | "enforced";
    status: "accepted" | "accepted_with_warnings" | "denied";
    warnings: Array<string>;
    errors: Array<string>;
  };
  diagnostics: Array<string>;
};

function normalizeStringArray(value: unknown): Array<string> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeSemver(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const valid = semver.valid(trimmed, { loose: true });
  if (valid) {
    return valid;
  }

  const coerced = semver.coerce(trimmed, { loose: true });
  return coerced ? coerced.version : null;
}

function semverEquivalent(left: string, right: string): boolean {
  const normalizedLeft = normalizeSemver(left);
  const normalizedRight = normalizeSemver(right);
  if (normalizedLeft && normalizedRight) {
    return semver.eq(normalizedLeft, normalizedRight, { loose: true });
  }
  return left.trim() === right.trim();
}

function matchesVersionRange(actualVersion: string, range: string): boolean {
  const normalizedActual = normalizeSemver(actualVersion);
  if (!normalizedActual) {
    return false;
  }

  const normalizedRange = range.trim();
  if (normalizedRange.length === 0) {
    return true;
  }

  try {
    return semver.satisfies(normalizedActual, normalizedRange, {
      includePrerelease: true,
      loose: true
    });
  } catch {
    return false;
  }
}

function coreVersionToSemver(coreVersion: number): string {
  return `${Math.trunc(coreVersion)}.0.0`;
}

function resolveCandidateEntrypoints(extensionRoot: string, manifest: AgentExtensionManifest | null): Array<string> {
  const candidates: Array<string> = [];
  const manifestEntrypoint = manifest?.entrypoints?.events;
  if (typeof manifestEntrypoint === "string" && manifestEntrypoint.trim().length > 0) {
    candidates.push(path.resolve(extensionRoot, manifestEntrypoint));
  }
  candidates.push(path.join(extensionRoot, "events.js"));
  candidates.push(path.join(extensionRoot, "events.mjs"));
  candidates.push(path.join(extensionRoot, "events.ts"));

  return candidates;
}

function parseManifestLike(input: unknown): AgentExtensionManifest | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const value = input as Record<string, unknown>;

  const name = typeof value.name === "string" ? value.name.trim() : "";
  const version = typeof value.version === "string" ? value.version.trim() : "";
  const agentId = typeof value.agentId === "string" ? value.agentId.trim() : "";
  const displayName = typeof value.displayName === "string" ? value.displayName.trim() : "";
  if (!name || !version || !agentId || !displayName) {
    return null;
  }

  const runtimeRaw =
    value.runtime && typeof value.runtime === "object" && !Array.isArray(value.runtime)
      ? (value.runtime as Record<string, unknown>)
      : null;
  const capabilitiesRaw =
    value.capabilities && typeof value.capabilities === "object" && !Array.isArray(value.capabilities)
      ? (value.capabilities as Record<string, unknown>)
      : null;
  const entrypointsRaw =
    value.entrypoints && typeof value.entrypoints === "object" && !Array.isArray(value.entrypoints)
      ? (value.entrypoints as Record<string, unknown>)
      : null;

  const runtimeProfiles = Array.isArray(runtimeRaw?.["profiles"])
    ? (runtimeRaw["profiles"] as Array<unknown>)
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry))
        .map((entry) => ({
          name: typeof entry.name === "string" ? entry.name.trim() : "",
          ...(typeof entry.version === "string" ? { version: entry.version.trim() } : {}),
          ...(typeof entry.versionRange === "string" ? { versionRange: entry.versionRange.trim() } : {})
        }))
        .filter((entry) => entry.name.length > 0)
    : [];

  return {
    name,
    version,
    agentId,
    displayName,
    ...(runtimeRaw
      ? {
          runtime: {
            ...(typeof runtimeRaw["coreApiVersion"] === "number"
              ? { coreApiVersion: Math.floor(runtimeRaw["coreApiVersion"]) }
              : {}),
            ...(typeof runtimeRaw["coreApiVersionRange"] === "string"
              ? { coreApiVersionRange: runtimeRaw["coreApiVersionRange"].trim() }
              : {}),
            ...(runtimeProfiles.length > 0 ? { profiles: runtimeProfiles } : {})
          }
        }
      : {}),
    ...(entrypointsRaw
      ? {
          entrypoints: {
            ...(typeof entrypointsRaw["events"] === "string" ? { events: entrypointsRaw["events"].trim() } : {}),
            ...(typeof entrypointsRaw["orientation"] === "string" ? { orientation: entrypointsRaw["orientation"].trim() } : {}),
            ...(typeof entrypointsRaw["instructions"] === "string"
              ? { instructions: entrypointsRaw["instructions"].trim() }
              : {}),
            ...(typeof entrypointsRaw["config"] === "string" ? { config: entrypointsRaw["config"].trim() } : {})
          }
        }
      : {}),
    ...(capabilitiesRaw
      ? {
          capabilities: {
            events: normalizeStringArray(capabilitiesRaw["events"]),
            actions: normalizeStringArray(capabilitiesRaw["actions"])
          }
        }
      : {})
  };
}

export async function readExtensionManifest(extensionRoot: string): Promise<{
  manifestPath: string | null;
  manifest: AgentExtensionManifest | null;
  diagnostics: Array<string>;
}> {
  const manifestPath = path.join(extensionRoot, "extension.manifest.json");
  if (!existsSync(manifestPath)) {
    return {
      manifestPath: null,
      manifest: null,
      diagnostics: []
    };
  }

  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const manifest = parseManifestLike(parsed);
    if (!manifest) {
      return {
        manifestPath,
        manifest: null,
        diagnostics: ["manifest shape is invalid or missing required fields"]
      };
    }
    return {
      manifestPath,
      manifest,
      diagnostics: []
    };
  } catch (error) {
    return {
      manifestPath,
      manifest: null,
      diagnostics: [error instanceof Error ? error.message : String(error)]
    };
  }
}

export function resolveEventsEntrypoint(extensionRoot: string, manifest: AgentExtensionManifest | null): string | null {
  const candidates = resolveCandidateEntrypoints(extensionRoot, manifest);
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function evaluateCompatibility(
  manifest: AgentExtensionManifest | null,
  runtime: AgentRuntimeCompatibilityInput
): AgentExtensionCompatibilitySummary {
  const reasons: Array<string> = [];

  if (!manifest?.runtime) {
    return {
      apiVersion: null,
      apiVersionRange: null,
      runtimeVersion: runtime.coreVersion,
      profileId: runtime.runtimeProfileId,
      profileVersion: runtime.runtimeProfileVersion,
      compatible: true,
      reasons
    };
  }

  const coreApiVersion = typeof manifest.runtime.coreApiVersion === "number" ? manifest.runtime.coreApiVersion : null;
  const coreApiRange = typeof manifest.runtime.coreApiVersionRange === "string" ? manifest.runtime.coreApiVersionRange : null;

  if (coreApiVersion !== null && coreApiVersion !== runtime.coreVersion) {
    reasons.push(`requires coreApiVersion=${coreApiVersion}; runtime=${runtime.coreVersion}`);
  }

  if (coreApiRange && !matchesVersionRange(coreVersionToSemver(runtime.coreVersion), coreApiRange)) {
    reasons.push(`requires coreApiVersionRange=${coreApiRange}; runtime=${runtime.coreVersion}`);
  }

  const profiles = Array.isArray(manifest.runtime.profiles) ? manifest.runtime.profiles : [];
  if (profiles.length > 0) {
    const profile = profiles.find((entry) => entry.name === runtime.runtimeProfileId);
    if (!profile) {
      reasons.push(`profile ${runtime.runtimeProfileId} is not declared in manifest runtime.profiles`);
    } else {
      if (profile.version && !semverEquivalent(profile.version, runtime.runtimeProfileVersion)) {
        reasons.push(`requires profile version ${profile.version}; runtime=${runtime.runtimeProfileVersion}`);
      }
      if (profile.versionRange && !matchesVersionRange(runtime.runtimeProfileVersion, profile.versionRange)) {
        reasons.push(`requires profile versionRange ${profile.versionRange}; runtime=${runtime.runtimeProfileVersion}`);
      }
    }
  }

  return {
    apiVersion: coreApiVersion,
    apiVersionRange: coreApiRange,
    runtimeVersion: runtime.coreVersion,
    profileId: runtime.runtimeProfileId,
    profileVersion: runtime.runtimeProfileVersion,
    compatible: reasons.length === 0,
    reasons
  };
}
