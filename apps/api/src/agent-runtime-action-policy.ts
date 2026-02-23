import { createHash } from "node:crypto";
import type { AgentRuntimeActionResult } from "@codex-manager/agent-runtime-sdk";

const REPLAY_CACHEABLE_STATUSES = new Set<AgentRuntimeActionResult["status"]>([
  "performed",
  "already_resolved",
  "not_eligible",
  "forbidden"
]);

export type SupplementalTranscriptStatus = "streaming" | "complete" | "canceled" | "error";

export function isReplayCacheableActionStatus(status: AgentRuntimeActionResult["status"]): boolean {
  return REPLAY_CACHEABLE_STATUSES.has(status);
}

export function normalizeActionTranscriptDetails(details: unknown): string | null {
  if (typeof details === "string") {
    return details;
  }
  if (details === null || details === undefined) {
    return null;
  }
  if (typeof details === "object") {
    try {
      return JSON.stringify(details);
    } catch {
      return "[unserializable-details]";
    }
  }
  return String(details);
}

export function shouldPreserveSuccessfulSupplementalEntry(input: {
  existingStatus?: SupplementalTranscriptStatus;
  terminalStatus: Extract<SupplementalTranscriptStatus, "complete" | "error" | "canceled">;
}): boolean {
  return input.existingStatus === "complete" && input.terminalStatus !== "complete";
}

function stableSerializeForActionSignature(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerializeForActionSignature(entry)).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    const serializedEntries: Array<string> = [];
    for (const key of Object.keys(objectValue).sort((left, right) => left.localeCompare(right))) {
      const entryValue = objectValue[key];
      if (entryValue === undefined) {
        continue;
      }
      serializedEntries.push(`${JSON.stringify(key)}:${stableSerializeForActionSignature(entryValue)}`);
    }
    return `{${serializedEntries.join(",")}}`;
  }

  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

export function normalizeAgentActionSignature(input: {
  actionType: string;
  payload: Record<string, unknown>;
  scope?: {
    projectId?: string | null;
    sourceSessionId?: string | null;
    turnId?: string | null;
  };
}): string {
  const scopeProjectId = typeof input.scope?.projectId === "string" ? input.scope.projectId.trim() : "";
  const scopeSessionId = typeof input.scope?.sourceSessionId === "string" ? input.scope.sourceSessionId.trim() : "";
  const scopeTurnId = typeof input.scope?.turnId === "string" ? input.scope.turnId.trim() : "";
  return `${input.actionType}:${scopeProjectId}:${scopeSessionId}:${scopeTurnId}:${stableSerializeForActionSignature(input.payload)}`;
}

export function hashAgentActionSignature(signature: string): string {
  return createHash("sha256").update(signature).digest("hex");
}
