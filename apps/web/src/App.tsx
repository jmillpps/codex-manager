import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";

type SessionSummary = {
  sessionId: string;
  title: string;
  materialized: boolean;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  source: string;
  projectId: string | null;
};

type ProjectSummary = {
  projectId: string;
  name: string;
  workingDirectory: string | null;
  createdAt: string;
  updatedAt: string;
};

type TranscriptEntry = {
  messageId: string;
  turnId: string;
  role: "user" | "assistant" | "system";
  type: string;
  content: string;
  details?: string;
  startedAt?: number;
  completedAt?: number;
  status: "streaming" | "complete" | "canceled" | "error";
};

type SessionDetailResponse = {
  session: SessionSummary;
  transcript: Array<TranscriptEntry>;
};

type ChatMessage = {
  id: string;
  turnId: string;
  role: "user" | "assistant" | "system";
  type: string;
  content: string;
  details?: string;
  status: "streaming" | "complete" | "canceled" | "error";
};

type MessageTiming = {
  startedAt: number;
  completedAt?: number;
};

type TurnMessageGroup = {
  turnId: string;
  messages: Array<ChatMessage>;
};

type ThoughtPanelMode = "full" | "pending-only";

type ThoughtPanelState = {
  open: boolean;
  mode: ThoughtPanelMode;
  lastPendingSignature: string;
};

type TranscriptFilter = "all" | "chat" | "tools" | "approvals";

type PendingApproval = {
  approvalId: string;
  method: string;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
  status: "pending";
};

type ToolInputOption = {
  label: string;
  description: string;
};

type ToolInputQuestion = {
  id: string;
  header: string;
  question: string;
  options: Array<ToolInputOption> | null;
  isOther: boolean;
  isSecret: boolean;
};

type PendingToolInput = {
  requestId: string;
  method: string;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  summary: string;
  questions: Array<ToolInputQuestion>;
  details: Record<string, unknown>;
  createdAt: string;
  status: "pending";
};

type ToolInputAnswer = {
  answers: Array<string>;
};

type CapabilityStatus = "available" | "disabled" | "unknown";

type CapabilitiesResponse = {
  status: string;
  runtime: {
    initialized: boolean;
    capabilitiesLastUpdatedAt: string | null;
  };
  methods: Record<string, CapabilityStatus>;
  details: Record<string, { status: CapabilityStatus; reason: string | null }>;
  features: Record<string, boolean>;
};

type InsightTab = "plan" | "diff" | "usage" | "tools";

type NotificationEnvelope = {
  type:
    | "notification"
    | "server_request"
    | "approval"
    | "approval_resolved"
    | "session_deleted"
    | "project_upserted"
    | "project_deleted"
    | "session_project_updated"
    | "tool_user_input_requested"
    | "tool_user_input_resolved"
    | "turn_plan_updated"
    | "turn_diff_updated"
    | "thread_token_usage_updated"
    | "app_list_updated"
    | "mcp_oauth_completed"
    | "account_updated"
    | "account_login_completed"
    | "account_rate_limits_updated"
    | "ready"
    | "error"
    | "pong";
  threadId?: string | null;
  payload?: unknown;
  message?: string;
};

type SessionDeletedPayload = {
  status?: string;
  sessionId?: string;
  title?: string;
  message?: string;
  deletedAt?: string;
};

type SessionProjectUpdatedPayload = {
  sessionId?: string;
  projectId?: string | null;
};

type ProjectUpsertedPayload = {
  project?: unknown;
};

type ProjectDeletedPayload = {
  projectId?: string;
  sessionIds?: Array<string>;
};

type MoveProjectChatsDestination = "unassigned" | "archive";

type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ReasoningEffortSelection = "" | ReasoningEffort;

type ModelOption = {
  id: string;
  label: string;
  provider: string;
  isDefault: boolean;
  supportedReasoningEfforts: Array<ReasoningEffort>;
  defaultReasoningEffort: ReasoningEffortSelection;
};

const allReasoningEfforts: Array<ReasoningEffort> = ["none", "minimal", "low", "medium", "high", "xhigh"];
const preferredReasoningEffortOrder: Array<ReasoningEffort> = ["xhigh", "high", "medium", "low", "minimal", "none"];
const reasoningEffortLabelByValue: Record<ReasoningEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh"
};

function isReasoningEffortSupportedByModel(model: ModelOption | null, effort: ReasoningEffort): boolean {
  if (!model) {
    return true;
  }

  const supported = model.supportedReasoningEfforts;
  return supported.length === 0 || supported.includes(effort);
}

function reasoningEffortsForModel(model: ModelOption | null): Array<ReasoningEffort> {
  return model && model.supportedReasoningEfforts.length > 0 ? model.supportedReasoningEfforts : allReasoningEfforts;
}

function normalizeModelIdentifier(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function isCodexMaxModel(model: ModelOption): boolean {
  const id = normalizeModelIdentifier(model.id);
  const label = normalizeModelIdentifier(model.label);
  return id === "codex-max" || label === "codex-max" || id.includes("codex-max") || label.includes("codex-max");
}

function preferredModelIdFromList(models: Array<ModelOption>): string {
  if (models.length === 0) {
    return "";
  }

  const codexMax = models.find((model) => isCodexMaxModel(model));
  if (codexMax) {
    return codexMax.id;
  }

  const preferred = models.find((model) => model.isDefault);
  return preferred?.id ?? models[0].id;
}

function preferredReasoningEffortForModel(model: ModelOption | null): ReasoningEffortSelection {
  if (!model) {
    return "";
  }

  if (isReasoningEffortSupportedByModel(model, "xhigh")) {
    return "xhigh";
  }

  if (model.defaultReasoningEffort && isReasoningEffortSupportedByModel(model, model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort;
  }

  const supported = reasoningEffortsForModel(model);
  for (const candidate of preferredReasoningEffortOrder) {
    if (supported.includes(candidate)) {
      return candidate;
    }
  }

  return supported[0] ?? "";
}

function modelDisplayLabel(model: ModelOption): string {
  if (!model.provider || model.provider.toLowerCase() === "unknown") {
    return model.label;
  }

  return `${model.label} (${model.provider})`;
}

type McpServerSummary = {
  name: string;
  status: string;
  authStatus: string;
  toolCount: number;
};

type AccountStatus = {
  account?: unknown;
  requiresOpenaiAuth?: boolean;
  [key: string]: unknown;
};

type SessionMenuPosition = {
  top: number;
  left: number;
};

type SessionMenuAnchor = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

const selectedSessionStorageKeyPrefix = "codex-manager:selected-session-id";

function selectedSessionStorageKey(): string {
  return `${selectedSessionStorageKeyPrefix}:${window.location.pathname}`;
}

function readPersistedSelectedSessionId(): string | null {
  const key = selectedSessionStorageKey();
  try {
    const fromSessionStorage = window.sessionStorage.getItem(key);
    if (fromSessionStorage && fromSessionStorage.trim().length > 0) {
      return fromSessionStorage.trim();
    }
  } catch {
    // Continue to local storage fallback.
  }

  try {
    const fromLocalStorage = window.localStorage.getItem(key);
    if (fromLocalStorage && fromLocalStorage.trim().length > 0) {
      const normalized = fromLocalStorage.trim();
      try {
        window.sessionStorage.setItem(key, normalized);
      } catch {
        // Ignore session storage failures.
      }
      return normalized;
    }
  } catch {
    // Ignore local storage read failures.
  }

  return null;
}

function persistSelectedSessionId(sessionId: string | null): void {
  const key = selectedSessionStorageKey();
  try {
    if (sessionId && sessionId.trim().length > 0) {
      const normalized = sessionId.trim();
      window.sessionStorage.setItem(key, normalized);
    } else {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Ignore session storage write failures (private mode, quota, etc.).
  }

  try {
    // Keep local storage clean so stale cross-tab values do not override tab-local selection.
    window.localStorage.removeItem(key);
  } catch {
    // Ignore local storage write failures.
  }
}

function toWsUrl(apiBase: string, sessionId: string | null): string {
  const url = new URL(`${apiBase}/stream`, window.location.origin);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else {
    url.protocol = "ws:";
  }

  if (sessionId) {
    url.searchParams.set("threadId", sessionId);
  }

  return url.toString();
}

function formatSessionDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

function formatApprovalDate(isoDate: string): string {
  return new Date(isoDate).toLocaleString();
}

function safePrettyJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return null;
}

function parseShellLikeArgs(input: string): Array<string> {
  const trimmed = input.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error("JSON command input must be an array of strings.");
    }

    const values = parsed
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);

    if (values.length === 0) {
      throw new Error("Command array must include at least one non-empty argument.");
    }

    return values;
  }

  return trimmed.split(/\s+/g).filter((part) => part.length > 0);
}

function extractLoginIdCandidate(accountStatus: AccountStatus | null): string {
  if (!accountStatus) {
    return "";
  }

  const direct = accountStatus.loginId;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }

  const loginRecord = asRecord(accountStatus.login);
  const fromLoginRecord = loginRecord?.id;
  if (typeof fromLoginRecord === "string" && fromLoginRecord.trim().length > 0) {
    return fromLoginRecord.trim();
  }

  return "";
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === "string" &&
    (value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh")
  );
}

function reasoningEffortLabel(value: ReasoningEffort): string {
  return reasoningEffortLabelByValue[value];
}

function extractReasoningEffort(input: unknown): ReasoningEffort | null {
  if (isReasoningEffort(input)) {
    return input;
  }

  const value = asRecord(input);
  if (!value) {
    return null;
  }

  const candidate =
    typeof value.reasoningEffort === "string"
      ? value.reasoningEffort
      : typeof value.reasoning_effort === "string"
        ? value.reasoning_effort
        : typeof value.effort === "string"
          ? value.effort
          : null;
  return isReasoningEffort(candidate) ? candidate : null;
}

function normalizeSupportedReasoningEfforts(input: unknown): Array<ReasoningEffort> {
  if (!Array.isArray(input)) {
    return [];
  }

  const normalized: Array<ReasoningEffort> = [];
  const seen = new Set<ReasoningEffort>();
  for (const entry of input) {
    const effort = extractReasoningEffort(entry);
    if (!effort || seen.has(effort)) {
      continue;
    }
    seen.add(effort);
    normalized.push(effort);
  }
  return normalized;
}

function normalizeModelOption(input: unknown): ModelOption | null {
  const value = asRecord(input);
  if (!value || typeof value.id !== "string" || value.id.length === 0) {
    return null;
  }

  const provider =
    typeof value.provider === "string" && value.provider.trim().length > 0
      ? value.provider.trim()
      : typeof value.modelProvider === "string" && value.modelProvider.trim().length > 0
        ? value.modelProvider.trim()
        : "";
  const label =
    typeof value.name === "string" && value.name.trim().length > 0
      ? value.name.trim()
      : typeof value.displayName === "string" && value.displayName.trim().length > 0
        ? value.displayName.trim()
        : value.id;
  const supportedReasoningEfforts = normalizeSupportedReasoningEfforts(value.supportedReasoningEfforts);
  const defaultReasoningEffortCandidate = extractReasoningEffort(value.defaultReasoningEffort ?? value.default_reasoning_effort);
  const defaultReasoningEffort: ReasoningEffortSelection =
    defaultReasoningEffortCandidate &&
    (supportedReasoningEfforts.length === 0 || supportedReasoningEfforts.includes(defaultReasoningEffortCandidate))
      ? defaultReasoningEffortCandidate
      : "";

  return {
    id: value.id,
    label,
    provider,
    isDefault: value.isDefault === true,
    supportedReasoningEfforts,
    defaultReasoningEffort
  };
}

function normalizeMcpServerSummary(input: unknown): McpServerSummary | null {
  const value = asRecord(input);
  if (!value) {
    return null;
  }

  const name =
    typeof value.name === "string" && value.name.trim().length > 0
      ? value.name.trim()
      : typeof value.id === "string" && value.id.trim().length > 0
        ? value.id.trim()
        : null;

  if (!name) {
    return null;
  }

  const status =
    typeof value.status === "string"
      ? value.status
      : typeof value.connectionStatus === "string"
        ? value.connectionStatus
        : typeof value.state === "string"
          ? value.state
          : "unknown";

  const authRecord = asRecord(value.auth);
  const authStatus =
    typeof value.authStatus === "string"
      ? value.authStatus
      : authRecord && typeof authRecord.status === "string"
        ? authRecord.status
        : "unknown";

  const toolCount = Array.isArray(value.tools) ? value.tools.length : typeof value.toolCount === "number" ? value.toolCount : 0;

  return {
    name,
    status,
    authStatus,
    toolCount
  };
}

function normalizeProjectSummary(input: unknown): ProjectSummary | null {
  const value = asRecord(input);
  if (!value) {
    return null;
  }

  const projectId = typeof value.projectId === "string" ? value.projectId.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : "";
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : "";

  if (!projectId || !name || !createdAt || !updatedAt) {
    return null;
  }

  const workingDirectory =
    typeof value.workingDirectory === "string" && value.workingDirectory.trim().length > 0 ? value.workingDirectory.trim() : null;

  return {
    projectId,
    name,
    workingDirectory,
    createdAt,
    updatedAt
  };
}

function normalizeRuntimeErrorMessage(message: string): string {
  const lower = message.toLowerCase();

  if (lower.includes("401 unauthorized") || lower.includes("missing bearer or basic authentication")) {
    return "Codex authentication failed (401). Configure valid OpenAI credentials (for example OPENAI_API_KEY) and restart the API.";
  }

  return message;
}

function summarizeToolEvent(item: Record<string, unknown>): { summary: string; details?: string } {
  const type = typeof item.type === "string" ? item.type : "event";

  if (type === "commandExecution") {
    const command = typeof item.command === "string" ? item.command : "(unknown command)";
    const status = typeof item.status === "string" ? item.status : "unknown";
    return {
      summary: `Command ${status}: ${command}`,
      details: safePrettyJson(item)
    };
  }

  if (type === "fileChange") {
    const status = typeof item.status === "string" ? item.status : "unknown";
    const changes = Array.isArray(item.changes) ? item.changes.length : 0;
    return {
      summary: `File change ${status}: ${changes} change${changes === 1 ? "" : "s"}`,
      details: safePrettyJson(item)
    };
  }

  if (type === "mcpToolCall") {
    const server = typeof item.server === "string" ? item.server : "unknown-server";
    const tool = typeof item.tool === "string" ? item.tool : "unknown-tool";
    const status = typeof item.status === "string" ? item.status : "unknown";
    return {
      summary: `Tool ${server}/${tool} ${status}`,
      details: safePrettyJson(item)
    };
  }

  return {
    summary: `[${type}]`,
    details: safePrettyJson(item)
  };
}

function approvalMessageId(approvalId: string): string {
  return `approval-${approvalId}`;
}

function messageCategory(message: ChatMessage): "chat" | "tools" | "approvals" {
  if (message.type.startsWith("approval.") || message.type.startsWith("tool_input.")) {
    return "approvals";
  }

  if (message.role === "user" || message.role === "assistant") {
    return "chat";
  }

  return "tools";
}

function approvalIdFromMessage(message: ChatMessage): string | null {
  if (!message.type.startsWith("approval.") || !message.id.startsWith("approval-")) {
    return null;
  }
  return message.id.slice("approval-".length);
}

function toolInputRequestIdFromMessage(message: ChatMessage): string | null {
  if (!message.type.startsWith("tool_input.") || !message.id.startsWith("tool-input-")) {
    return null;
  }
  return message.id.slice("tool-input-".length);
}

function statusLabel(status: ChatMessage["status"]): string {
  if (status === "streaming") {
    return "In progress";
  }
  if (status === "complete") {
    return "Complete";
  }
  if (status === "canceled") {
    return "Canceled";
  }
  return "Error";
}

function toEpochMs(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) {
    if (input > 1_000_000_000_000) {
      return input;
    }
    if (input > 1_000_000_000) {
      return input * 1000;
    }
    return null;
  }

  if (typeof input === "string" && input.trim().length > 0) {
    const parsed = Date.parse(input);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function parseMessageTimingFromDetails(details?: string): MessageTiming | null {
  if (!details || details.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(details) as Record<string, unknown>;
    const startedAt =
      toEpochMs(parsed.startedAt) ??
      toEpochMs(parsed.started_at) ??
      toEpochMs(parsed.startTime) ??
      toEpochMs(parsed.start_time) ??
      null;
    const completedAt =
      toEpochMs(parsed.completedAt) ??
      toEpochMs(parsed.completed_at) ??
      toEpochMs(parsed.endTime) ??
      toEpochMs(parsed.end_time) ??
      null;

    if (!startedAt && !completedAt) {
      return null;
    }

    if (startedAt && completedAt) {
      return completedAt >= startedAt ? { startedAt, completedAt } : { startedAt };
    }

    if (startedAt) {
      return { startedAt };
    }

    return completedAt ? { startedAt: completedAt, completedAt } : null;
  } catch {
    return null;
  }
}

function parseDetailsRecord(details?: string): Record<string, unknown> | null {
  if (!details || details.trim().length === 0) {
    return null;
  }

  try {
    return asRecord(JSON.parse(details));
  } catch {
    return null;
  }
}

function parseEmbeddedRecord(value: unknown): Record<string, unknown> | null {
  let current = value;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current === "string") {
      const trimmed = current.trim();
      if (trimmed.length === 0 || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
        return null;
      }

      try {
        current = JSON.parse(trimmed);
      } catch {
        return null;
      }
      continue;
    }

    return asRecord(current);
  }

  return null;
}

function findValueInRecordChain(root: Record<string, unknown> | null, key: string): unknown {
  let cursor: unknown = root;
  for (let depth = 0; depth < 8; depth += 1) {
    const record = parseEmbeddedRecord(cursor);
    if (!record) {
      return undefined;
    }

    if (key in record) {
      return record[key];
    }

    const detailsRecord = parseEmbeddedRecord(record.details);
    if (detailsRecord && key in detailsRecord) {
      return detailsRecord[key];
    }

    const resolutionRecord = parseEmbeddedRecord(record.resolution);
    if (resolutionRecord && key in resolutionRecord) {
      return resolutionRecord[key];
    }

    cursor = record.previous;
  }

  return undefined;
}

function findStringInRecordChain(root: Record<string, unknown> | null, key: string): string | null {
  const value = findValueInRecordChain(root, key);
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  return null;
}

function findNumberInRecordChain(root: Record<string, unknown> | null, key: string): number | null {
  const value = findValueInRecordChain(root, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractCountFromSummaryLine(content: string): number | null {
  const match = content.match(/(\d+)\s+change/i);
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatFileChangeLabel(changeCount: number | null): string {
  if (typeof changeCount === "number") {
    return `${changeCount} file change${changeCount === 1 ? "" : "s"}`;
  }

  return "file changes";
}

function extractCommandFromSummaryLine(content: string): string | null {
  const firstLine = content.split("\n")[0]?.trim() ?? "";
  if (!firstLine) {
    return null;
  }

  const colonIndex = firstLine.indexOf(":");
  if (colonIndex === -1) {
    return null;
  }

  const candidate = firstLine.slice(colonIndex + 1).trim();
  return candidate.length > 0 ? candidate : null;
}

function extractApprovalMethod(message: ChatMessage, pendingApproval?: PendingApproval): string | null {
  if (pendingApproval?.method) {
    return pendingApproval.method;
  }

  const parsedDetails = parseDetailsRecord(message.details);
  return findStringInRecordChain(parsedDetails, "method");
}

function extractApprovalCommand(message: ChatMessage, pendingApproval?: PendingApproval): string | null {
  const pendingDetails = asRecord(pendingApproval?.details);
  const pendingCommand = typeof pendingDetails?.command === "string" ? pendingDetails.command.trim() : "";
  if (pendingCommand.length > 0) {
    return pendingCommand;
  }

  const parsedDetails = parseDetailsRecord(message.details);
  const fromDetails = findStringInRecordChain(parsedDetails, "command");
  if (fromDetails) {
    return fromDetails;
  }

  return extractCommandFromSummaryLine(message.content);
}

function extractApprovalFileChangeCount(message: ChatMessage, pendingApproval?: PendingApproval): number | null {
  const pendingDetails = asRecord(pendingApproval?.details);
  if (pendingDetails) {
    if (Array.isArray(pendingDetails.changes)) {
      return pendingDetails.changes.length;
    }

    if (typeof pendingDetails.changeCount === "number" && Number.isFinite(pendingDetails.changeCount)) {
      return pendingDetails.changeCount;
    }
  }

  const parsedDetails = parseDetailsRecord(message.details);
  const fromCount = findNumberInRecordChain(parsedDetails, "changeCount");
  if (fromCount !== null) {
    return fromCount;
  }

  const changesValue = findValueInRecordChain(parsedDetails, "changes");
  if (Array.isArray(changesValue)) {
    return changesValue.length;
  }

  return extractCountFromSummaryLine(message.content);
}

function extractApprovalDecision(message: ChatMessage): "accept" | "decline" | "cancel" | null {
  const parsedDetails = parseDetailsRecord(message.details);
  const decision = findStringInRecordChain(parsedDetails, "decision");
  if (!decision) {
    return null;
  }

  const normalized = decision.toLowerCase();
  if (normalized === "accept" || normalized === "decline" || normalized === "cancel") {
    return normalized;
  }

  return null;
}

function extractApprovalStatus(message: ChatMessage): string | null {
  const parsedDetails = parseDetailsRecord(message.details);
  const status = findStringInRecordChain(parsedDetails, "status");
  return status ? status.toLowerCase() : null;
}

function normalizeProjectRootPath(path: string | null | undefined): string | null {
  if (!path) {
    return null;
  }

  const trimmed = path.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function deriveUserHomePath(path: string | null): string | null {
  const normalized = normalizeProjectRootPath(path);
  if (!normalized) {
    return null;
  }

  const unixHomeMatch = normalized.match(/^\/home\/([^/]+)/);
  if (unixHomeMatch) {
    return `/home/${unixHomeMatch[1]}`;
  }

  const macHomeMatch = normalized.match(/^\/Users\/([^/]+)/);
  if (macHomeMatch) {
    return `/Users/${macHomeMatch[1]}`;
  }

  const windowsHomeMatch = normalized.match(/^([a-zA-Z]:\\Users\\[^\\]+)/);
  if (windowsHomeMatch) {
    return windowsHomeMatch[1];
  }

  return null;
}

function toProjectRelativePath(path: string, projectRoot: string | null): string {
  const normalizedPath = normalizeProjectRootPath(path) ?? path;
  const normalizedRoot = normalizeProjectRootPath(projectRoot);
  const userHome = deriveUserHomePath(normalizedRoot);
  const baseRoot = userHome ?? normalizedRoot;
  if (!baseRoot) {
    return normalizedPath;
  }

  if (normalizedPath === baseRoot) {
    return "~";
  }

  if (normalizedPath.startsWith(`${baseRoot}/`)) {
    return `~/${normalizedPath.slice(baseRoot.length + 1)}`;
  }

  if (windowsHomeMatchSupported(baseRoot, normalizedPath)) {
    return `~\\${normalizedPath.slice(baseRoot.length + 1)}`;
  }

  return normalizedPath;
}

function windowsHomeMatchSupported(baseRoot: string, normalizedPath: string): boolean {
  return baseRoot.includes("\\") && normalizedPath.startsWith(`${baseRoot}\\`);
}

function replaceProjectRootInCommand(command: string, projectRoot: string | null): string {
  const normalizedRoot = normalizeProjectRootPath(projectRoot);
  const userHome = deriveUserHomePath(normalizedRoot);
  const baseRoot = userHome ?? normalizedRoot;
  if (!baseRoot || command.length === 0) {
    return command;
  }

  return command.split(baseRoot).join("~");
}

function replaceDisplayHomePath(text: string, projectRoot: string | null): string {
  const normalizedRoot = normalizeProjectRootPath(projectRoot);
  const userHome = deriveUserHomePath(normalizedRoot);
  if (!userHome || text.length === 0) {
    return text;
  }

  return text.split(userHome).join("~");
}

function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const match = trimmed.match(/^(?:\/bin\/bash|\/usr\/bin\/bash|bash)\s+-lc\s+(['"])([\s\S]*)\1$/);
  if (!match) {
    return trimmed;
  }

  return match[2].trim();
}

function parseLeadingCd(command: string): {
  command: string;
  cwd: string | null;
} {
  const match = command.match(/^\s*cd\s+(.+?)\s*&&\s*([\s\S]+)$/);
  if (!match) {
    return {
      command: command.trim(),
      cwd: null
    };
  }

  let rawPath = match[1].trim();
  if (
    (rawPath.startsWith("\"") && rawPath.endsWith("\"")) ||
    (rawPath.startsWith("'") && rawPath.endsWith("'"))
  ) {
    rawPath = rawPath.slice(1, -1);
  }

  return {
    command: match[2].trim(),
    cwd: rawPath.length > 0 ? rawPath : null
  };
}

function formatTerminalCommandLine(input: {
  command: string;
  cwd: string | null;
  projectRoot: string | null;
}): {
  promptPath: string;
  commandText: string;
} {
  const normalizedRoot = normalizeProjectRootPath(input.projectRoot);
  const unwrappedCommand = unwrapShellCommand(input.command);
  const parsed = parseLeadingCd(unwrappedCommand);
  const effectiveCwd = parsed.cwd ?? input.cwd ?? normalizedRoot ?? "~";
  const promptPath = toProjectRelativePath(effectiveCwd, normalizedRoot);
  const commandText = replaceProjectRootInCommand(parsed.command, normalizedRoot);

  return {
    promptPath,
    commandText: commandText.length > 0 ? commandText : input.command
  };
}

function summarizeCommandExecutionMessage(message: ChatMessage): {
  command: string;
  aggregatedOutput: string | null;
  exitCode: number | null;
  cwd: string | null;
} {
  const parsedDetails = parseDetailsRecord(message.details);
  const fromDetails = parsedDetails && typeof parsedDetails.command === "string" ? parsedDetails.command.trim() : "";
  const command = fromDetails.length > 0 ? fromDetails : (extractCommandFromSummaryLine(message.content) ?? "(unknown command)");
  const aggregatedOutput =
    parsedDetails && typeof parsedDetails.aggregatedOutput === "string" && parsedDetails.aggregatedOutput.length > 0
      ? parsedDetails.aggregatedOutput
      : null;
  const exitCode = parsedDetails && typeof parsedDetails.exitCode === "number" ? parsedDetails.exitCode : null;
  const cwd = parsedDetails && typeof parsedDetails.cwd === "string" && parsedDetails.cwd.trim().length > 0 ? parsedDetails.cwd.trim() : null;

  return {
    command,
    aggregatedOutput,
    exitCode,
    cwd
  };
}

type FileChangeDiffEntry = {
  path: string | null;
  lines: Array<string>;
  kind: "create" | "update" | "delete" | "move" | "unknown";
  movePath: string | null;
};

type FileChangeEntrySummary = {
  path: string | null;
  kind: "create" | "update" | "delete" | "move" | "unknown";
  movePath: string | null;
};

function normalizeFileChangeKind(value: unknown): {
  kind: "create" | "update" | "delete" | "move" | "unknown";
  movePath: string | null;
} {
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "create" || normalized === "update" || normalized === "delete" || normalized === "move") {
      return { kind: normalized, movePath: null };
    }
    return { kind: "unknown", movePath: null };
  }

  const record = asRecord(value);
  if (!record) {
    return { kind: "unknown", movePath: null };
  }

  const typeValue = typeof record.type === "string" ? record.type.toLowerCase() : "unknown";
  const movePath =
    typeof record.move_path === "string" && record.move_path.trim().length > 0
      ? record.move_path.trim()
      : typeof record.movePath === "string" && record.movePath.trim().length > 0
        ? record.movePath.trim()
        : null;

  if (typeValue === "create" || typeValue === "update" || typeValue === "delete" || typeValue === "move") {
    return { kind: typeValue, movePath };
  }

  return { kind: "unknown", movePath };
}

function collectFileChangeDiffData(changes: unknown): {
  files: Array<string>;
  diffs: Array<FileChangeDiffEntry>;
  entries: Array<FileChangeEntrySummary>;
} {
  const entries = Array.isArray(changes) ? changes : [];
  const files: Array<string> = [];
  const diffs: Array<FileChangeDiffEntry> = [];
  const summaries: Array<FileChangeEntrySummary> = [];

  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }

    const path = typeof record.path === "string" && record.path.trim().length > 0 ? record.path.trim() : null;
    const { kind, movePath } = normalizeFileChangeKind(record.kind);
    summaries.push({
      path,
      kind,
      movePath
    });
    if (path) {
      files.push(path);
    }

    const diff = typeof record.diff === "string" ? record.diff : null;
    if (diff && diff.length > 0) {
      diffs.push({
        path,
        lines: diff.split("\n"),
        kind,
        movePath
      });
    }
  }

  return { files, diffs, entries: summaries };
}

function summarizeFileChangeMessage(message: ChatMessage): {
  status: string;
  changeCount: number | null;
  files: Array<string>;
  diffs: Array<FileChangeDiffEntry>;
  entries: Array<FileChangeEntrySummary>;
} {
  const parsedDetails = parseDetailsRecord(message.details);
  const status = parsedDetails && typeof parsedDetails.status === "string" ? parsedDetails.status : message.status;
  const changeEntries = parsedDetails?.changes;
  const { files, diffs, entries } = collectFileChangeDiffData(changeEntries);
  const changeCount = Array.isArray(changeEntries) && changeEntries.length > 0 ? changeEntries.length : extractCountFromSummaryLine(message.content);

  return {
    status,
    changeCount,
    files,
    diffs,
    entries
  };
}

function classifyDiffLineTone(line: string): "add" | "remove" | "hunk" | "meta" | "context" {
  if (line.startsWith("@@")) {
    return "hunk";
  }

  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
    return "meta";
  }

  if (line.startsWith("+")) {
    return "add";
  }

  if (line.startsWith("-")) {
    return "remove";
  }

  return "context";
}

function summarizePendingFileChangeApproval(approval: PendingApproval): {
  files: Array<string>;
  diffs: Array<FileChangeDiffEntry>;
  entries: Array<FileChangeEntrySummary>;
  changeCount: number | null;
} {
  const details = asRecord(approval.details);
  if (!details) {
    return { files: [], diffs: [], entries: [], changeCount: extractCountFromSummaryLine(approval.summary) };
  }

  const collected = collectFileChangeDiffData(details.changes);
  return {
    ...collected,
    changeCount: collected.entries.length > 0 ? collected.entries.length : extractCountFromSummaryLine(approval.summary)
  };
}

function summarizePendingFileChangeApprovalText(preview: {
  entries: Array<FileChangeEntrySummary>;
  changeCount: number | null;
  projectRoot: string | null;
}): string {
  if (preview.entries.length === 1) {
    const entry = preview.entries[0];
    const path = entry.path ? toProjectRelativePath(entry.path, preview.projectRoot) : "file";
    if (entry.kind === "create") {
      return `Approval required to create file ${path}`;
    }
    if (entry.kind === "update") {
      return `Approval required to modify file ${path}`;
    }
    if (entry.kind === "delete") {
      return `Approval required to delete file ${path}`;
    }
    if (entry.kind === "move") {
      if (entry.movePath) {
        return `Approval required to move file ${path} -> ${toProjectRelativePath(entry.movePath, preview.projectRoot)}`;
      }
      return `Approval required to move file ${path}`;
    }
  }

  return `Approval required to apply: ${formatFileChangeLabel(preview.changeCount)}`;
}

function shouldHidePathHeaderForCreatePreview(preview: {
  entries: Array<FileChangeEntrySummary>;
}): boolean {
  return preview.entries.length === 1 && preview.entries[0].kind === "create";
}

function parseReasoningLines(details?: string, fallbackContent?: string): {
  summaryLines: Array<string>;
  contentLines: Array<string>;
} {
  const trimWrappingAsterisks = (line: string): string => {
    let normalized = line.trim();
    while (normalized.length > 0) {
      const match = normalized.match(/^(\*{1,3})(.+)\1$/);
      if (!match) {
        break;
      }

      const inner = match[2].trim();
      if (!inner) {
        break;
      }

      normalized = inner;
    }

    return normalized;
  };

  const normalizeLines = (value: unknown): Array<string> => {
    if (!Array.isArray(value)) {
      return [];
    }

    const lines: Array<string> = [];
    for (const entry of value) {
      if (typeof entry === "string") {
        const trimmed = trimWrappingAsterisks(entry);
        if (trimmed.length > 0) {
          lines.push(trimmed);
        }
        continue;
      }

      const record = asRecord(entry);
      if (!record) {
        continue;
      }

      const textCandidate =
        typeof record.text === "string"
          ? record.text
          : typeof record.value === "string"
            ? record.value
            : typeof record.summary === "string"
              ? record.summary
              : null;

      if (textCandidate && textCandidate.trim().length > 0) {
        lines.push(trimWrappingAsterisks(textCandidate));
      }
    }
    return lines.filter((line) => line.length > 0);
  };

  if (!details || details.trim().length === 0) {
    const fallback = typeof fallbackContent === "string" ? trimWrappingAsterisks(fallbackContent) : "";
    return {
      summaryLines: fallback && fallback !== "[reasoning]" ? [fallback] : [],
      contentLines: []
    };
  }

  try {
    const parsed = JSON.parse(details) as Record<string, unknown>;
    const summaryLines = normalizeLines(parsed.summary);
    const contentLines = normalizeLines(parsed.content);

    if (summaryLines.length === 0 && contentLines.length === 0) {
      const fallback = typeof fallbackContent === "string" ? trimWrappingAsterisks(fallbackContent) : "";
      return {
        summaryLines: fallback && fallback !== "[reasoning]" ? [fallback] : [],
        contentLines: []
      };
    }

    return {
      summaryLines,
      contentLines
    };
  } catch {
    const fallback = typeof fallbackContent === "string" ? trimWrappingAsterisks(fallbackContent) : "";
    return {
      summaryLines: fallback && fallback !== "[reasoning]" ? [fallback] : [],
      contentLines: []
    };
  }
}

function formatElapsedLabel(durationMs: number): string {
  if (durationMs < 1000) {
    return "<1s";
  }

  const roundedSeconds = Math.round(durationMs / 1000);
  if (roundedSeconds < 60) {
    return `${roundedSeconds}s`;
  }

  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  if (seconds === 0) {
    return `${minutes}m`;
  }

  return `${minutes}m ${seconds}s`;
}

function approvalResolutionStatus(payload: {
  status?: string;
  decision?: "accept" | "decline" | "cancel";
}): ChatMessage["status"] {
  if (payload.status === "expired") {
    return "canceled";
  }

  if (payload.decision === "decline") {
    return "error";
  }

  if (payload.decision === "cancel") {
    return "canceled";
  }

  return "complete";
}

function approvalResolutionSummary(payload: {
  status?: string;
  decision?: "accept" | "decline" | "cancel";
  scope?: "turn" | "session";
}): string {
  if (payload.status === "expired") {
    return "Approval request expired before a decision was submitted.";
  }

  if (payload.decision === "accept") {
    return payload.scope === "session" ? "Approved for the full session." : "Approved for this turn.";
  }

  if (payload.decision === "decline") {
    return "Request denied.";
  }

  if (payload.decision === "cancel") {
    return "Approval request canceled.";
  }

  return "Approval resolved.";
}

function commandApprovalResolutionSummary(
  payload: {
    status?: string;
    decision?: "accept" | "decline" | "cancel";
    scope?: "turn" | "session";
  },
  command: string
): string {
  if (payload.status === "expired") {
    return `Command approval expired: ${command}`;
  }

  if (payload.decision === "accept") {
    return `Approved to run: ${command}`;
  }

  if (payload.decision === "decline") {
    return `Command denied: ${command}`;
  }

  if (payload.decision === "cancel") {
    return `Command approval canceled: ${command}`;
  }

  return `Command approval updated: ${command}`;
}

function fileChangeApprovalResolutionSummary(
  payload: {
    status?: string;
    decision?: "accept" | "decline" | "cancel";
    scope?: "turn" | "session";
  },
  label: string
): string {
  if (payload.status === "expired") {
    return `File-change approval expired: ${label}`;
  }

  if (payload.decision === "accept") {
    return `Approved file changes: ${label}`;
  }

  if (payload.decision === "decline") {
    return `File changes denied: ${label}`;
  }

  if (payload.decision === "cancel") {
    return `File-change approval canceled: ${label}`;
  }

  return `File-change approval updated: ${label}`;
}

function toolInputMessageId(requestId: string): string {
  return `tool-input-${requestId}`;
}

function toolInputResolutionStatus(payload: {
  status?: string;
  decision?: "accept" | "decline" | "cancel";
}): ChatMessage["status"] {
  if (payload.status === "expired") {
    return "canceled";
  }

  if (payload.decision === "decline") {
    return "error";
  }

  if (payload.decision === "cancel") {
    return "canceled";
  }

  return "complete";
}

function toolInputResolutionSummary(payload: {
  status?: string;
  decision?: "accept" | "decline" | "cancel";
}): string {
  if (payload.status === "expired") {
    return "Tool input request expired before a decision was submitted.";
  }

  if (payload.decision === "accept") {
    return "Tool input submitted.";
  }

  if (payload.decision === "decline") {
    return "Tool input declined.";
  }

  if (payload.decision === "cancel") {
    return "Tool input canceled.";
  }

  return "Tool input request resolved.";
}

export function App() {
  const apiBase = useMemo(() => import.meta.env.VITE_API_BASE || "/api", []);
  const [sessions, setSessions] = useState<Array<SessionSummary>>([]);
  const [projects, setProjects] = useState<Array<ProjectSummary>>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() => readPersistedSelectedSessionId());
  const [showArchived, setShowArchived] = useState(false);
  const [showProjects, setShowProjects] = useState(true);
  const [showSessionList, setShowSessionList] = useState(true);
  const [expandedProjectsById, setExpandedProjectsById] = useState<Record<string, boolean>>({});
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [sessionMenuSessionId, setSessionMenuSessionId] = useState<string | null>(null);
  const [sessionMenuPosition, setSessionMenuPosition] = useState<SessionMenuPosition | null>(null);
  const [sessionMenuAnchor, setSessionMenuAnchor] = useState<SessionMenuAnchor | null>(null);
  const [projectMenuProjectId, setProjectMenuProjectId] = useState<string | null>(null);
  const [projectMenuPosition, setProjectMenuPosition] = useState<SessionMenuPosition | null>(null);
  const [projectMenuAnchor, setProjectMenuAnchor] = useState<SessionMenuAnchor | null>(null);
  const [showProjectsHeaderMenu, setShowProjectsHeaderMenu] = useState(false);
  const [projectsHeaderMenuPosition, setProjectsHeaderMenuPosition] = useState<SessionMenuPosition | null>(null);
  const [projectsHeaderMenuAnchor, setProjectsHeaderMenuAnchor] = useState<SessionMenuAnchor | null>(null);
  const [sessionActionSessionId, setSessionActionSessionId] = useState<string | null>(null);
  const [projectActionProjectId, setProjectActionProjectId] = useState<string | null>(null);
  const [transcriptFilter, setTranscriptFilter] = useState<TranscriptFilter>("all");
  const [messages, setMessages] = useState<Array<ChatMessage>>([]);
  const [messageTimingById, setMessageTimingById] = useState<Record<string, MessageTiming>>({});
  const [thoughtPanelStateByTurnId, setThoughtPanelStateByTurnId] = useState<Record<string, ThoughtPanelState>>({});
  const [pendingApprovals, setPendingApprovals] = useState<Array<PendingApproval>>([]);
  const [pendingToolInputs, setPendingToolInputs] = useState<Array<PendingToolInput>>([]);
  const [toolInputDraftById, setToolInputDraftById] = useState<Record<string, Record<string, string>>>({});
  const [toolInputActionRequestId, setToolInputActionRequestId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loadingSuggestedReply, setLoadingSuggestedReply] = useState(false);
  const [steerDraft, setSteerDraft] = useState("");
  const [submittingSteer, setSubmittingSteer] = useState(false);
  const [activeTurnIdBySession, setActiveTurnIdBySession] = useState<Record<string, string>>({});
  const [retryPrompt, setRetryPrompt] = useState<string | null>(null);
  const [models, setModels] = useState<Array<ModelOption>>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [sessionModelById, setSessionModelById] = useState<Record<string, string>>({});
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<ReasoningEffortSelection>("");
  const [sessionReasoningEffortById, setSessionReasoningEffortById] = useState<Record<string, ReasoningEffort>>({});
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse | null>(null);
  const [loadingCapabilities, setLoadingCapabilities] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [accountStatus, setAccountStatus] = useState<AccountStatus | null>(null);
  const [accountRateLimits, setAccountRateLimits] = useState<unknown>(null);
  const [appsCatalog, setAppsCatalog] = useState<Array<Record<string, unknown>>>([]);
  const [skillsCatalog, setSkillsCatalog] = useState<Array<Record<string, unknown>>>([]);
  const [collaborationModes, setCollaborationModes] = useState<Array<Record<string, unknown>>>([]);
  const [experimentalFeatures, setExperimentalFeatures] = useState<Array<Record<string, unknown>>>([]);
  const [configSnapshot, setConfigSnapshot] = useState<Record<string, unknown> | null>(null);
  const [configRequirements, setConfigRequirements] = useState<Record<string, unknown> | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsActionResult, setSettingsActionResult] = useState<unknown>(null);
  const [settingsActionPending, setSettingsActionPending] = useState<string | null>(null);
  const [insightDrawerOpen, setInsightDrawerOpen] = useState(false);
  const [insightTab, setInsightTab] = useState<InsightTab>("plan");
  const [planBySession, setPlanBySession] = useState<Record<string, Array<Record<string, unknown>>>>({});
  const [diffBySession, setDiffBySession] = useState<Record<string, Array<Record<string, unknown>>>>({});
  const [usageBySession, setUsageBySession] = useState<Record<string, Array<Record<string, unknown>>>>({});
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuPosition, setModelMenuPosition] = useState<SessionMenuPosition | null>(null);
  const [modelMenuAnchor, setModelMenuAnchor] = useState<SessionMenuAnchor | null>(null);
  const [threadActionPending, setThreadActionPending] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [mcpServers, setMcpServers] = useState<Array<McpServerSummary>>([]);
  const [loadingMcpServers, setLoadingMcpServers] = useState(false);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingMoreSessions, setLoadingMoreSessions] = useState(false);
  const [sessionsNextCursor, setSessionsNextCursor] = useState<string | null>(null);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [wsState, setWsState] = useState<"connecting" | "connected" | "disconnected">("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [wsReconnectNonce, setWsReconnectNonce] = useState(0);
  const [followTranscriptTail, setFollowTranscriptTail] = useState(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [requireSessionReselection, setRequireSessionReselection] = useState(false);
  const [deletedSessionNotice, setDeletedSessionNotice] = useState<{
    sessionId: string;
    title?: string;
    message: string;
  } | null>(null);

  const websocketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const sendAckTimerRef = useRef<number | null>(null);
  const pendingSendAckRef = useRef<{ sessionId: string; turnId: string | null } | null>(null);
  const openSessionMenuRef = useRef<HTMLDivElement | null>(null);
  const sessionMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const projectMenuRef = useRef<HTMLDivElement | null>(null);
  const projectMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const projectsHeaderMenuRef = useRef<HTMLDivElement | null>(null);
  const projectsHeaderMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const threadMenuRef = useRef<HTMLDivElement | null>(null);
  const threadMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const modelMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const suggestedReplyAbortRef = useRef<AbortController | null>(null);
  const suggestedReplyRequestIdRef = useRef(0);
  const selectedSessionIdRef = useRef<string | null>(null);
  const draftRef = useRef("");
  selectedSessionIdRef.current = selectedSessionId;
  draftRef.current = draft;
  useEffect(() => {
    persistSelectedSessionId(selectedSessionId);
  }, [selectedSessionId]);
  const selectedSession = useMemo(
    () => sessions.find((session) => session.sessionId === selectedSessionId) ?? null,
    [sessions, selectedSessionId]
  );
  const sessionsByProjectId = useMemo(() => {
    const byProjectId = new Map<string, Array<SessionSummary>>();
    for (const project of projects) {
      byProjectId.set(project.projectId, []);
    }

    for (const session of sessions) {
      if (!session.projectId) {
        continue;
      }

      const projectSessions = byProjectId.get(session.projectId);
      if (projectSessions) {
        projectSessions.push(session);
      }
    }

    return byProjectId;
  }, [projects, sessions]);
  const projectNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const project of projects) {
      map[project.projectId] = project.name;
    }
    return map;
  }, [projects]);
  const unassignedSessions = useMemo(() => sessions.filter((session) => session.projectId === null), [sessions]);
  const visibleProjects = useMemo(() => {
    if (!showArchived) {
      return projects;
    }

    return projects.filter((project) => {
      const projectSessions = sessionsByProjectId.get(project.projectId) ?? [];
      return projectSessions.length > 0;
    });
  }, [projects, sessionsByProjectId, showArchived]);
  const showProjectsSection = !showArchived || visibleProjects.length > 0;
  const showYourChatsSection = !showArchived || unassignedSessions.length > 0;
  const defaultModelId = useMemo(() => preferredModelIdFromList(models), [models]);
  const selectedModelOption = useMemo(() => {
    if (selectedModelId) {
      const selected = models.find((model) => model.id === selectedModelId);
      if (selected) {
        return selected;
      }
    }

    if (defaultModelId) {
      const fallback = models.find((model) => model.id === defaultModelId);
      if (fallback) {
        return fallback;
      }
    }

    return models[0] ?? null;
  }, [defaultModelId, models, selectedModelId]);
  const selectedModelMenuLabel = useMemo(() => {
    if (loadingModels) {
      return "Loading models...";
    }

    if (!selectedModelOption) {
      return "No models available";
    }

    const effortLabel = selectedReasoningEffort ? reasoningEffortLabel(selectedReasoningEffort) : "Unavailable";
    return `${modelDisplayLabel(selectedModelOption)} · ${effortLabel}`;
  }, [loadingModels, selectedModelOption, selectedReasoningEffort]);
  const pendingApprovalsById = useMemo(() => {
    return new Map(pendingApprovals.map((approval) => [approval.approvalId, approval]));
  }, [pendingApprovals]);
  const pendingFileChangeApprovalsByItemId = useMemo(() => {
    const byItemId = new Map<string, PendingApproval>();
    for (const approval of pendingApprovals) {
      if (approval.method !== "item/fileChange/requestApproval") {
        continue;
      }

      if (!approval.itemId || approval.itemId.trim().length === 0) {
        continue;
      }

      byItemId.set(approval.itemId, approval);
    }
    return byItemId;
  }, [pendingApprovals]);
  const pendingToolInputsById = useMemo(() => {
    return new Map(pendingToolInputs.map((request) => [request.requestId, request]));
  }, [pendingToolInputs]);
  const activeTurnId = selectedSessionId ? activeTurnIdBySession[selectedSessionId] ?? null : null;
  const capabilityFlags = capabilities?.features ?? {};
  const planEntries = selectedSessionId ? planBySession[selectedSessionId] ?? [] : [];
  const diffEntries = selectedSessionId ? diffBySession[selectedSessionId] ?? [] : [];
  const usageEntries = selectedSessionId ? usageBySession[selectedSessionId] ?? [] : [];
  const runtimeStateLabel =
    pendingToolInputs.length > 0
      ? "Needs input"
      : pendingApprovals.length > 0
        ? "Waiting for approval"
        : streaming
          ? "Streaming"
          : "Idle";
  const showDisconnectedOverlay = wsState === "disconnected" && !deletedSessionNotice;
  const clearPendingSendAck = (): void => {
    pendingSendAckRef.current = null;
    if (sendAckTimerRef.current !== null) {
      window.clearTimeout(sendAckTimerRef.current);
      sendAckTimerRef.current = null;
    }
  };
  const markSendActivityObserved = (sessionId: string, turnId?: string): void => {
    const pending = pendingSendAckRef.current;
    if (!pending || pending.sessionId !== sessionId) {
      return;
    }

    if (pending.turnId && turnId && pending.turnId !== turnId) {
      return;
    }

    clearPendingSendAck();
  };
  const startPendingSendAck = (sessionId: string, turnId: string | null): void => {
    clearPendingSendAck();
    pendingSendAckRef.current = {
      sessionId,
      turnId
    };
    sendAckTimerRef.current = window.setTimeout(() => {
      const pending = pendingSendAckRef.current;
      if (!pending || pending.sessionId !== sessionId) {
        return;
      }

      pendingSendAckRef.current = null;
      sendAckTimerRef.current = null;
      setWsState("disconnected");
      setStreaming(false);
      setError("No response after sending. Connection appears disconnected. Reconnect to continue.");
    }, 12_000);
  };

  const transcriptCounts = useMemo(() => {
    const counts: Record<TranscriptFilter, number> = {
      all: messages.length,
      chat: 0,
      tools: 0,
      approvals: 0
    };

    for (const message of messages) {
      const category = messageCategory(message);
      if (category === "chat") {
        counts.chat += 1;
      } else if (category === "tools") {
        counts.tools += 1;
      } else {
        counts.approvals += 1;
      }
    }

    return counts;
  }, [messages]);

  const allTurnGroups = useMemo(() => {
    const byTurnId = new Map<string, Array<ChatMessage>>();

    for (const message of messages) {
      const turnKey = message.turnId?.trim().length > 0 ? message.turnId : `turn-${message.id}`;
      const bucket = byTurnId.get(turnKey);
      if (bucket) {
        bucket.push(message);
      } else {
        byTurnId.set(turnKey, [message]);
      }
    }

    const groups: Array<TurnMessageGroup> = [];
    for (const [turnId, groupedMessages] of byTurnId.entries()) {
      groups.push({
        turnId,
        messages: groupedMessages
      });
    }
    return groups;
  }, [messages]);
  const visibleTurnGroups = useMemo(() => {
    if (transcriptFilter === "all") {
      return allTurnGroups;
    }

    return allTurnGroups.filter((group) =>
      group.messages.some((message) => {
        const category = messageCategory(message);
        return category === transcriptFilter;
      })
    );
  }, [allTurnGroups, transcriptFilter]);
  const inspectTurnGroupState = (group: TurnMessageGroup): {
    responseMessages: Array<ChatMessage>;
    thoughtMessages: Array<ChatMessage>;
    finalAssistantMessage: ChatMessage | null;
    thinkingActive: boolean;
    pendingSignature: string;
    hasPending: boolean;
  } => {
    const responseMessages = group.messages.filter((message) => message.role !== "user");
    const finalAssistantIndex = (() => {
      for (let index = responseMessages.length - 1; index >= 0; index -= 1) {
        if (responseMessages[index].role === "assistant") {
          return index;
        }
      }
      return -1;
    })();
    const finalAssistantMessage = finalAssistantIndex >= 0 ? responseMessages[finalAssistantIndex] : null;
    const thoughtMessages = responseMessages.filter((_message, index) => index !== finalAssistantIndex);
    const thinkingActive = activeTurnId === group.turnId;
    const pendingIds = new Set<string>();
    for (const message of thoughtMessages) {
      const approvalId = approvalIdFromMessage(message);
      if (approvalId && pendingApprovalsById.has(approvalId)) {
        pendingIds.add(`approval:${approvalId}`);
      }

      const toolInputRequestId = toolInputRequestIdFromMessage(message);
      if (toolInputRequestId && pendingToolInputsById.has(toolInputRequestId)) {
        pendingIds.add(`tool-input:${toolInputRequestId}`);
      }
    }
    const pendingSignature = Array.from(pendingIds).sort().join("|");

    return {
      responseMessages,
      thoughtMessages,
      finalAssistantMessage,
      thinkingActive,
      pendingSignature,
      hasPending: pendingIds.size > 0
    };
  };

  useEffect(() => {
    setThoughtPanelStateByTurnId((current) => {
      const next: Record<string, ThoughtPanelState> = {};
      let changed = false;

      for (const group of visibleTurnGroups) {
        const { thinkingActive, pendingSignature, hasPending } = inspectTurnGroupState(group);
        const existing = current[group.turnId];
        if (!existing) {
          next[group.turnId] = {
            open: thinkingActive || hasPending,
            mode: hasPending && !thinkingActive ? "pending-only" : "full",
            lastPendingSignature: pendingSignature
          };
          changed = true;
          continue;
        }

        let open = existing.open;
        let mode = existing.mode;
        let lastPendingSignature = existing.lastPendingSignature;

        if (pendingSignature !== existing.lastPendingSignature) {
          lastPendingSignature = pendingSignature;
          if (pendingSignature.length > 0 && !existing.open) {
            // If the panel is closed when a new pending interaction arrives, auto-open a focused view.
            open = true;
            mode = "pending-only";
          }
        }

        if (pendingSignature.length === 0 && mode === "pending-only") {
          mode = "full";
        }

        next[group.turnId] = {
          open,
          mode,
          lastPendingSignature
        };
        if (open !== existing.open || mode !== existing.mode || lastPendingSignature !== existing.lastPendingSignature) {
          changed = true;
        }
      }

      if (Object.keys(current).length !== Object.keys(next).length) {
        changed = true;
      }

      return changed ? next : current;
    });
  }, [visibleTurnGroups, pendingApprovalsById, pendingToolInputsById, activeTurnId]);

  const upsertMessage = (nextMessage: ChatMessage): void => {
    setMessages((current) => {
      const existingIndex = current.findIndex((entry) => entry.id === nextMessage.id);
      if (existingIndex === -1) {
        return [...current, nextMessage];
      }

      const next = [...current];
      next[existingIndex] = {
        ...next[existingIndex],
        ...nextMessage
      };
      return next;
    });
  };

  const upsertPendingApprovalMessage = (approval: PendingApproval): void => {
    const detailsRecord = asRecord(approval.details);
    const command = typeof detailsRecord?.command === "string" ? detailsRecord.command.trim() : "";
    const reason = typeof detailsRecord?.reason === "string" ? detailsRecord.reason.trim() : "";
    const fileChangeCount =
      detailsRecord && Array.isArray(detailsRecord.changes)
        ? detailsRecord.changes.length
        : detailsRecord && typeof detailsRecord.changeCount === "number" && Number.isFinite(detailsRecord.changeCount)
          ? detailsRecord.changeCount
          : extractCountFromSummaryLine(approval.summary);
    const isCommandApproval = approval.method === "item/commandExecution/requestApproval" || command.length > 0;
    const isFileChangeApproval = approval.method === "item/fileChange/requestApproval";

    const compactDetails: Record<string, unknown> = {
      method: approval.method,
      createdAt: approval.createdAt,
      itemId: approval.itemId
    };
    if (command.length > 0) {
      compactDetails.command = command;
    }
    if (reason.length > 0) {
      compactDetails.reason = reason;
    }
    if (isFileChangeApproval && fileChangeCount !== null) {
      compactDetails.changeCount = fileChangeCount;
    }

    const fileChangeLabel = formatFileChangeLabel(fileChangeCount);
    const content = isCommandApproval && command.length > 0
      ? `Approval required to run: ${command}`
      : isFileChangeApproval
        ? `Approval required to apply: ${fileChangeLabel}`
        : approval.summary;

    upsertMessage({
      id: approvalMessageId(approval.approvalId),
      turnId: approval.turnId ?? "approval",
      role: "system",
      type: "approval.request",
      content,
      details: safePrettyJson(compactDetails),
      status: "streaming"
    });
  };

  const resolveApprovalMessage = (payload: {
    approvalId: string;
    status?: string;
    decision?: "accept" | "decline" | "cancel";
    scope?: "turn" | "session";
  }): void => {
    setMessages((current) => {
      const messageId = approvalMessageId(payload.approvalId);
      const existingIndex = current.findIndex((entry) => entry.id === messageId);
      const summary = approvalResolutionSummary(payload);

      if (existingIndex === -1) {
        return [
          ...current,
          {
            id: messageId,
            turnId: "approval",
            role: "system",
            type: "approval.resolved",
            content: summary,
            details: safePrettyJson(payload),
            status: approvalResolutionStatus(payload)
          }
        ];
      }

      const next = [...current];
      const existing = next[existingIndex];
      const method = extractApprovalMethod(existing);
      const command = extractApprovalCommand(existing);
      const isCommandApproval = method === "item/commandExecution/requestApproval" || Boolean(command);
      const isFileChangeApproval = method === "item/fileChange/requestApproval";
      const fileChangeCount = extractApprovalFileChangeCount(existing);
      const fileChangeLabel = formatFileChangeLabel(fileChangeCount);
      const resolvedSummary =
        isCommandApproval && command
          ? commandApprovalResolutionSummary(payload, command)
          : isFileChangeApproval
            ? fileChangeApprovalResolutionSummary(payload, fileChangeLabel)
            : summary;
      const compactDetails: Record<string, unknown> = {
        approvalId: payload.approvalId,
        status: payload.status ?? "resolved"
      };
      if (payload.decision) {
        compactDetails.decision = payload.decision;
      }
      if (payload.scope) {
        compactDetails.scope = payload.scope;
      }
      if (method) {
        compactDetails.method = method;
      }
      if (command) {
        compactDetails.command = command;
      }
      if (isFileChangeApproval && fileChangeCount !== null) {
        compactDetails.changeCount = fileChangeCount;
      }
      next[existingIndex] = {
        ...existing,
        type: "approval.resolved",
        content: resolvedSummary,
        details: safePrettyJson(compactDetails),
        status: approvalResolutionStatus(payload)
      };
      return next;
    });
  };

  const upsertPendingToolInputMessage = (request: PendingToolInput): void => {
    upsertMessage({
      id: toolInputMessageId(request.requestId),
      turnId: request.turnId ?? "tool-input",
      role: "system",
      type: "tool_input.request",
      content: request.summary,
      details: safePrettyJson({
        method: request.method,
        createdAt: request.createdAt,
        questions: request.questions,
        ...request.details
      }),
      status: "streaming"
    });
  };

  const resolveToolInputMessage = (payload: {
    requestId: string;
    status?: string;
    decision?: "accept" | "decline" | "cancel";
  }): void => {
    setMessages((current) => {
      const messageId = toolInputMessageId(payload.requestId);
      const existingIndex = current.findIndex((entry) => entry.id === messageId);
      const summary = toolInputResolutionSummary(payload);

      if (existingIndex === -1) {
        return [
          ...current,
          {
            id: messageId,
            turnId: "tool-input",
            role: "system",
            type: "tool_input.resolved",
            content: summary,
            details: safePrettyJson(payload),
            status: toolInputResolutionStatus(payload)
          }
        ];
      }

      const next = [...current];
      const existing = next[existingIndex];
      const mergedContent = existing.content.includes(summary) ? existing.content : `${existing.content}\n${summary}`.trim();
      next[existingIndex] = {
        ...existing,
        type: "tool_input.resolved",
        content: mergedContent,
        details: safePrettyJson({
          previous: existing.details ?? null,
          resolution: payload
        }),
        status: toolInputResolutionStatus(payload)
      };
      return next;
    });
  };

  const upsertSystemErrorMessage = (id: string, turnId: string, content: string): void => {
    setMessages((current) => {
      const existingIndex = current.findIndex((entry) => entry.id === id);
      const next: ChatMessage = {
        id,
        turnId,
        role: "system",
        type: "error",
        content,
        status: "error"
      };

      if (existingIndex === -1) {
        return [...current, next];
      }

      const copy = [...current];
      copy[existingIndex] = next;
      return copy;
    });
  };

  const applyDeletedSessionState = (payload: SessionDeletedPayload): void => {
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : null;
    if (!sessionId) {
      return;
    }

    const title = typeof payload.title === "string" ? payload.title : undefined;
    const message =
      typeof payload.message === "string" && payload.message.trim().length > 0
        ? payload.message.trim()
        : "This chat is no longer available.";

    setSessions((current) => current.filter((session) => session.sessionId !== sessionId));
    setPendingApprovals((current) => current.filter((approval) => approval.threadId !== sessionId));
    setPendingToolInputs((current) => current.filter((request) => request.threadId !== sessionId));
    setActiveTurnIdBySession((current) => {
      if (!(sessionId in current)) {
        return current;
      }

      const { [sessionId]: _removed, ...rest } = current;
      return rest;
    });
    setSessionModelById((current) => {
      if (!(sessionId in current)) {
        return current;
      }
      const { [sessionId]: _deleted, ...rest } = current;
      return rest;
    });
    setSessionReasoningEffortById((current) => {
      if (!(sessionId in current)) {
        return current;
      }
      const { [sessionId]: _deleted, ...rest } = current;
      return rest;
    });
    setSessionMenuSessionId((current) => {
      if (current === sessionId) {
        setSessionMenuPosition(null);
        setSessionMenuAnchor(null);
        sessionMenuTriggerRef.current = null;
        return null;
      }

      return current;
    });
    setSessionActionSessionId((current) => (current === sessionId ? null : current));
    setRenamingSessionId((current) => (current === sessionId ? null : current));

    if (selectedSessionId === sessionId) {
      setSelectedSessionId(null);
      setMessages([]);
      setMessageTimingById({});
      setThoughtPanelStateByTurnId({});
      setPendingApprovals([]);
      setStreaming(false);
      setDraft("");
      setRetryPrompt(null);
      setFollowTranscriptTail(true);
      setShowJumpToBottom(false);
      setRequireSessionReselection(true);
      setDeletedSessionNotice({
        sessionId,
        title,
        message
      });
    }
  };

  const handleDeletedSessionResponse = async (response: Response, fallbackSessionId: string): Promise<boolean> => {
    if (response.status !== 410) {
      return false;
    }

    let payload: SessionDeletedPayload = {};
    try {
      payload = (await response.json()) as SessionDeletedPayload;
    } catch {
      payload = { sessionId: fallbackSessionId };
    }

    if (typeof payload.sessionId !== "string") {
      payload.sessionId = fallbackSessionId;
    }

    applyDeletedSessionState(payload);
    return true;
  };

  const loadSessions = async (
    archived = showArchived,
    preferredSessionId?: string | null,
    pagination?: { append?: boolean; cursor?: string | null; limit?: number }
  ): Promise<void> => {
    const append = pagination?.append ?? false;
    const cursor = append ? pagination?.cursor ?? sessionsNextCursor : null;
    const limit = pagination?.limit ?? 100;

    if (append) {
      setLoadingMoreSessions(true);
    } else {
      setLoadingSessions(true);
    }

    try {
      const query = new URLSearchParams();
      if (archived) {
        query.set("archived", "true");
      }
      if (cursor) {
        query.set("cursor", cursor);
      }
      query.set("limit", String(limit));
      const suffix = query.toString();

      const response = await fetch(`${apiBase}/sessions${suffix ? `?${suffix}` : ""}`);
      if (!response.ok) {
        throw new Error(`failed to load sessions (${response.status})`);
      }

      const payload = (await response.json()) as { data: Array<SessionSummary>; nextCursor: string | null };
      setSessionsNextCursor(payload.nextCursor);

      if (append) {
        setSessions((current) => {
          const byId = new Map(current.map((session) => [session.sessionId, session]));
          for (const session of payload.data) {
            byId.set(session.sessionId, session);
          }
          return Array.from(byId.values());
        });
      } else {
        setSessions(payload.data);
        setSelectedSessionId((current) => {
          const target = preferredSessionId ?? current ?? readPersistedSelectedSessionId();
          if (target && payload.data.some((session) => session.sessionId === target)) {
            return target;
          }

          if (requireSessionReselection) {
            return null;
          }

          return payload.data[0]?.sessionId ?? null;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load sessions");
    } finally {
      if (append) {
        setLoadingMoreSessions(false);
      } else {
        setLoadingSessions(false);
      }
    }
  };

  const loadSessionTranscript = async (sessionId: string): Promise<void> => {
    setLoadingTranscript(true);
    setError(null);

    try {
      const response = await fetch(`${apiBase}/sessions/${encodeURIComponent(sessionId)}`);
      if (!response.ok) {
        if (await handleDeletedSessionResponse(response, sessionId)) {
          setMessages([]);
          setThoughtPanelStateByTurnId({});
          return;
        }
        throw new Error(`failed to load session (${response.status})`);
      }

      const payload = (await response.json()) as SessionDetailResponse;
      const nextTranscriptMessages: Array<ChatMessage> = payload.transcript.map((entry) => ({
        id: entry.messageId,
        turnId: entry.turnId,
        role: entry.role,
        type: entry.type,
        content: entry.content,
        details: entry.details,
        status: entry.status
      }));
      setMessages((current) => {
        const optimistic = current.filter((message) => message.id.startsWith("local-user-"));
        if (optimistic.length === 0) {
          return nextTranscriptMessages;
        }

        const byId = new Map(nextTranscriptMessages.map((message) => [message.id, message]));
        for (const message of optimistic) {
          if (!byId.has(message.id)) {
            byId.set(message.id, message);
          }
        }
        return Array.from(byId.values());
      });
      setMessageTimingById(() => {
        const next: Record<string, MessageTiming> = {};
        for (const entry of payload.transcript) {
          const startedAt = toEpochMs(entry.startedAt);
          const completedAt = toEpochMs(entry.completedAt);
          if (startedAt !== null || completedAt !== null) {
            if (startedAt !== null && completedAt !== null) {
              next[entry.messageId] = completedAt >= startedAt ? { startedAt, completedAt } : { startedAt };
            } else if (startedAt !== null) {
              next[entry.messageId] = { startedAt };
            } else if (completedAt !== null) {
              next[entry.messageId] = { startedAt: completedAt, completedAt };
            }
            continue;
          }

          const timing = parseMessageTimingFromDetails(entry.details);
          if (timing) {
            next[entry.messageId] = timing;
          }
        }
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load transcript");
      setMessages([]);
      setMessageTimingById({});
      setThoughtPanelStateByTurnId({});
    } finally {
      setLoadingTranscript(false);
    }
  };

  const loadSessionApprovals = async (sessionId: string): Promise<void> => {
    try {
      const response = await fetch(`${apiBase}/sessions/${encodeURIComponent(sessionId)}/approvals`);
      if (!response.ok) {
        if (await handleDeletedSessionResponse(response, sessionId)) {
          setPendingApprovals([]);
          return;
        }
        throw new Error(`failed to load approvals (${response.status})`);
      }

      const payload = (await response.json()) as { data: Array<PendingApproval> };
      setPendingApprovals(payload.data);
      for (const approval of payload.data) {
        upsertPendingApprovalMessage(approval);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load approvals");
      setPendingApprovals([]);
    }
  };

  const loadSessionToolInputs = async (sessionId: string): Promise<void> => {
    try {
      const response = await fetch(`${apiBase}/sessions/${encodeURIComponent(sessionId)}/tool-input`);
      if (!response.ok) {
        if (await handleDeletedSessionResponse(response, sessionId)) {
          setPendingToolInputs([]);
          return;
        }
        throw new Error(`failed to load tool input requests (${response.status})`);
      }

      const payload = (await response.json()) as { data: Array<PendingToolInput> };
      setPendingToolInputs(payload.data);
      for (const request of payload.data) {
        upsertPendingToolInputMessage(request);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load tool input requests");
      setPendingToolInputs([]);
    }
  };

  const loadCapabilities = async (refresh = false): Promise<void> => {
    setLoadingCapabilities(true);
    try {
      const response = await fetch(`${apiBase}/capabilities${refresh ? "?refresh=true" : ""}`);
      if (!response.ok) {
        throw new Error(`failed to load capabilities (${response.status})`);
      }

      const payload = (await response.json()) as CapabilitiesResponse;
      setCapabilities(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load capabilities");
      setCapabilities(null);
    } finally {
      setLoadingCapabilities(false);
    }
  };

  const loadSettingsData = async (): Promise<void> => {
    setSettingsError(null);
    setSettingsActionResult(null);
    try {
      const [accountResponse, rateLimitsResponse, appsResponse, skillsResponse, modesResponse, featuresResponse, configResponse, requirementsResponse] =
        await Promise.all([
          fetch(`${apiBase}/account`),
          fetch(`${apiBase}/account/rate-limits`),
          fetch(`${apiBase}/apps?limit=100`),
          fetch(`${apiBase}/skills`),
          fetch(`${apiBase}/collaboration/modes?limit=100`),
          fetch(`${apiBase}/features/experimental?limit=100`),
          fetch(`${apiBase}/config?includeLayers=true`),
          fetch(`${apiBase}/config/requirements`)
        ]);

      if (accountResponse.ok) {
        setAccountStatus((await accountResponse.json()) as AccountStatus);
      }

      if (rateLimitsResponse.ok) {
        setAccountRateLimits(await rateLimitsResponse.json());
      }

      if (appsResponse.ok) {
        const payload = (await appsResponse.json()) as { data?: Array<Record<string, unknown>> };
        setAppsCatalog(Array.isArray(payload.data) ? payload.data : []);
      }

      if (skillsResponse.ok) {
        const payload = (await skillsResponse.json()) as { data?: Array<Record<string, unknown>> };
        setSkillsCatalog(Array.isArray(payload.data) ? payload.data : []);
      }

      if (modesResponse.ok) {
        const payload = (await modesResponse.json()) as { data?: Array<Record<string, unknown>> };
        setCollaborationModes(Array.isArray(payload.data) ? payload.data : []);
      }

      if (featuresResponse.ok) {
        const payload = (await featuresResponse.json()) as { data?: Array<Record<string, unknown>> };
        setExperimentalFeatures(Array.isArray(payload.data) ? payload.data : []);
      }

      if (configResponse.ok) {
        setConfigSnapshot((await configResponse.json()) as Record<string, unknown>);
      }

      if (requirementsResponse.ok) {
        setConfigRequirements((await requirementsResponse.json()) as Record<string, unknown>);
      }
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "failed to load settings data");
    }
  };

  const loadModels = async (): Promise<void> => {
    setLoadingModels(true);

    try {
      const response = await fetch(`${apiBase}/models?limit=100`);
      if (!response.ok) {
        throw new Error(`failed to load models (${response.status})`);
      }

      const payload = (await response.json()) as { data?: Array<unknown> };
      const normalized = Array.isArray(payload.data)
        ? payload.data.map((entry) => normalizeModelOption(entry)).filter((entry): entry is ModelOption => entry !== null)
        : [];
      setModels(normalized);

      if (normalized.length > 0) {
        setSelectedModelId((current) => {
          if (current && normalized.some((model) => model.id === current)) {
            return current;
          }

          return preferredModelIdFromList(normalized);
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load models");
      setModels([]);
    } finally {
      setLoadingModels(false);
    }
  };

  const loadMcpServers = async (): Promise<void> => {
    setLoadingMcpServers(true);

    try {
      const response = await fetch(`${apiBase}/mcp/servers?limit=100`);
      if (!response.ok) {
        throw new Error(`failed to load MCP servers (${response.status})`);
      }

      const payload = (await response.json()) as { data?: Array<unknown> };
      const normalized = Array.isArray(payload.data)
        ? payload.data
            .map((entry) => normalizeMcpServerSummary(entry))
            .filter((entry): entry is McpServerSummary => entry !== null)
            .sort((left, right) => left.name.localeCompare(right.name))
        : [];

      setMcpServers(normalized);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load MCP servers");
      setMcpServers([]);
    } finally {
      setLoadingMcpServers(false);
    }
  };

  const loadProjects = async (): Promise<void> => {
    setLoadingProjects(true);

    try {
      const response = await fetch(`${apiBase}/projects`);
      if (!response.ok) {
        throw new Error(`failed to load projects (${response.status})`);
      }

      const payload = (await response.json()) as { data?: Array<unknown> };
      const sortedProjects = Array.isArray(payload.data)
        ? payload.data
            .map((entry) => normalizeProjectSummary(entry))
            .filter((entry): entry is ProjectSummary => entry !== null)
            .sort((left, right) => left.name.localeCompare(right.name))
        : [];
      setProjects(sortedProjects);
      setExpandedProjectsById((current) => {
        const next: Record<string, boolean> = {};
        for (const project of sortedProjects) {
          next[project.projectId] = current[project.projectId] ?? true;
        }
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load projects");
      setProjects([]);
    } finally {
      setLoadingProjects(false);
    }
  };

  const assignSessionToProject = async (sessionId: string, projectId: string | null): Promise<void> => {
    setError(null);
    closeSessionMenu();
    setSessionActionSessionId(sessionId);

    try {
      const response = await fetch(`${apiBase}/sessions/${encodeURIComponent(sessionId)}/project`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ projectId })
      });

      if (!response.ok) {
        if (await handleDeletedSessionResponse(response, sessionId)) {
          return;
        }

        if (response.status === 404) {
          const payload = (await response.json()) as { status?: string };
          if (payload.status === "project_not_found") {
            await loadProjects();
            throw new Error("Project was not found. Refreshing project list.");
          }
        }

        throw new Error(`failed to update project assignment (${response.status})`);
      }

      const payload = (await response.json()) as {
        sessionId: string;
        projectId: string | null;
      };
      setSessions((current) =>
        current.map((session) =>
          session.sessionId === payload.sessionId ? { ...session, projectId: payload.projectId ?? null } : session
        )
      );

      if (payload.projectId) {
        setExpandedProjectsById((current) => ({
          ...current,
          [payload.projectId as string]: true
        }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to update project assignment");
    } finally {
      setSessionActionSessionId(null);
    }
  };

  const createProject = async (projectName: string): Promise<ProjectSummary | null> => {
    const trimmedName = projectName.trim();
    if (!trimmedName) {
      setError("project name cannot be empty");
      return null;
    }

    setError(null);

    const response = await fetch(`${apiBase}/projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ name: trimmedName })
    });

    if (!response.ok) {
      if (response.status === 409) {
        throw new Error("A project with this name already exists.");
      }
      throw new Error(`failed to create project (${response.status})`);
    }

    const payload = (await response.json()) as { project: unknown; orchestrationSession?: SessionSummary | null };
    const project = normalizeProjectSummary(payload.project);
    if (!project) {
      throw new Error("invalid project response payload");
    }
    setProjects((current) => {
      const byId = new Map(current.map((entry) => [entry.projectId, entry]));
      byId.set(project.projectId, project);
      return Array.from(byId.values()).sort((left, right) => left.name.localeCompare(right.name));
    });
    setExpandedProjectsById((current) => ({
      ...current,
      [project.projectId]: true
    }));
    setShowProjects(true);

    const orchestrationSession = payload.orchestrationSession ?? null;
    if (orchestrationSession) {
      setSessions((current) => {
        const byId = new Map(current.map((entry) => [entry.sessionId, entry]));
        byId.set(orchestrationSession.sessionId, orchestrationSession);
        return Array.from(byId.values()).sort((left, right) => {
          if (left.updatedAt !== right.updatedAt) {
            return right.updatedAt - left.updatedAt;
          }
          return right.createdAt - left.createdAt;
        });
      });
    }

    return project;
  };

  const createProjectFromPrompt = async (sessionIdToAssign?: string): Promise<void> => {
    const projectName = window.prompt("Project name");
    if (projectName === null) {
      return;
    }

    const trimmed = projectName.trim();
    if (!trimmed) {
      setError("project name cannot be empty");
      return;
    }

    try {
      const project = await createProject(trimmed);
      if (!project || !sessionIdToAssign) {
        return;
      }

      await assignSessionToProject(sessionIdToAssign, project.projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create project");
    }
  };

  const toggleProjectExpansion = (projectId: string): void => {
    setExpandedProjectsById((current) => ({
      ...current,
      [projectId]: !(current[projectId] ?? true)
    }));
  };

  const deleteProject = async (project: ProjectSummary): Promise<void> => {
    const confirmed = window.confirm(
      `Delete project "${project.name}"?\n\nThe project must be empty first. If chats remain assigned, delete will be blocked until they are moved or deleted.`
    );
    if (!confirmed) {
      return;
    }

    setError(null);
    closeProjectMenu();
    setProjectActionProjectId(project.projectId);

    try {
      const response = await fetch(`${apiBase}/projects/${encodeURIComponent(project.projectId)}`, {
        method: "DELETE"
      });
      if (!response.ok) {
        if (response.status === 409) {
          const payload = (await response.json()) as { status?: string; sessionCount?: number };
          if (payload.status === "project_not_empty") {
            throw new Error(
              `Project still has ${payload.sessionCount ?? 0} chat${(payload.sessionCount ?? 0) === 1 ? "" : "s"}. Move or delete them first.`
            );
          }
        }
        throw new Error(`failed to delete project (${response.status})`);
      }

      setProjects((current) => current.filter((entry) => entry.projectId !== project.projectId));
      setExpandedProjectsById((current) => {
        const { [project.projectId]: _removed, ...rest } = current;
        return rest;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to delete project");
    } finally {
      setProjectActionProjectId(null);
    }
  };

  const updateProjectWorkingDirectory = async (project: ProjectSummary): Promise<void> => {
    const currentValue = project.workingDirectory ?? "";
    const nextValue = window.prompt(
      `Working directory for "${project.name}"\n\nLeave blank to clear project-specific directory.`,
      currentValue
    );
    if (nextValue === null) {
      return;
    }

    const normalized = nextValue.trim();
    setError(null);
    closeProjectMenu();
    setProjectActionProjectId(project.projectId);

    try {
      const response = await fetch(`${apiBase}/projects/${encodeURIComponent(project.projectId)}/rename`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: project.name,
          workingDirectory: normalized.length > 0 ? normalized : null
        })
      });

      if (!response.ok) {
        throw new Error(`failed to update project working directory (${response.status})`);
      }

      const payload = (await response.json()) as { project: unknown };
      const incoming = normalizeProjectSummary(payload.project);
      if (!incoming) {
        throw new Error("invalid project response payload");
      }
      setProjects((current) => {
        const byId = new Map(current.map((entry) => [entry.projectId, entry]));
        byId.set(incoming.projectId, incoming);
        return Array.from(byId.values()).sort((left, right) => left.name.localeCompare(right.name));
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to update project working directory");
    } finally {
      setProjectActionProjectId(null);
    }
  };

  const moveAllProjectChats = async (project: ProjectSummary, destination: MoveProjectChatsDestination): Promise<void> => {
    const projectSessions = sessionsByProjectId.get(project.projectId) ?? [];
    const destinationLabel = destination === "archive" ? "Archive" : "Your Chats";
    const countLabel = projectSessions.length > 0 ? `${projectSessions.length} chat${projectSessions.length === 1 ? "" : "s"}` : "all chats";
    const confirmed = window.confirm(
      `Move ${countLabel} from "${project.name}" to ${destinationLabel}?\n\nThis updates every chat currently assigned to this project.`
    );
    if (!confirmed) {
      return;
    }

    setError(null);
    closeProjectMenu();
    setProjectActionProjectId(project.projectId);

    try {
      const response = await fetch(`${apiBase}/projects/${encodeURIComponent(project.projectId)}/chats/move-all`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ destination })
      });

      if (!response.ok) {
        if (response.status === 409) {
          const payload = (await response.json()) as { status?: string; sessionIds?: Array<string> };
          if (payload.status === "not_materialized_sessions") {
            const count = Array.isArray(payload.sessionIds) ? payload.sessionIds.length : 0;
            throw new Error(
              `${count} chat${count === 1 ? "" : "s"} cannot be archived yet because no rollout exists. Send a first message first, or move to Your Chats.`
            );
          }
        }

        throw new Error(`failed to move project chats (${response.status})`);
      }

      await loadSessions(showArchived, selectedSessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to move project chats");
    } finally {
      setProjectActionProjectId(null);
    }
  };

  const deleteAllProjectChats = async (project: ProjectSummary): Promise<void> => {
    const projectSessions = sessionsByProjectId.get(project.projectId) ?? [];
    const countLabel = projectSessions.length > 0 ? `${projectSessions.length} chat${projectSessions.length === 1 ? "" : "s"}` : "all chats";
    const confirmed = window.confirm(
      `Delete ${countLabel} in "${project.name}" permanently?\n\nThis cannot be undone and removes chat artifacts from disk.`
    );
    if (!confirmed) {
      return;
    }

    setError(null);
    closeProjectMenu();
    setProjectActionProjectId(project.projectId);

    try {
      const response = await fetch(`${apiBase}/projects/${encodeURIComponent(project.projectId)}/chats/delete-all`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({})
      });
      if (!response.ok) {
        throw new Error(`failed to delete project chats (${response.status})`);
      }

      await loadSessions(showArchived, selectedSessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to delete project chats");
    } finally {
      setProjectActionProjectId(null);
    }
  };

  const createSession = async (projectId: string | null = null): Promise<void> => {
    setError(null);
    closeProjectMenu();
    if (projectId) {
      setProjectActionProjectId(projectId);
    }
    const project = projectId ? projects.find((entry) => entry.projectId === projectId) ?? null : null;
    const projectWorkingDirectory = project?.workingDirectory ?? null;

    try {
      const response = await fetch(`${apiBase}/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: selectedModelId || undefined,
          cwd: projectWorkingDirectory ?? undefined
        })
      });

      if (!response.ok) {
        throw new Error(`failed to create session (${response.status})`);
      }

      const payload = (await response.json()) as { session: SessionSummary };
      if (projectId) {
        const assignResponse = await fetch(`${apiBase}/sessions/${encodeURIComponent(payload.session.sessionId)}/project`, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ projectId })
        });

        if (!assignResponse.ok) {
          if (assignResponse.status === 404) {
            const assignPayload = (await assignResponse.json()) as { status?: string };
            if (assignPayload.status === "project_not_found") {
              await loadProjects();
              throw new Error("Project was not found. Refreshing project list.");
            }
          }

          throw new Error(`failed to assign new chat to project (${assignResponse.status})`);
        }
      }
      setShowArchived(false);
      await loadSessions(false, payload.session.sessionId);
      if (selectedModelId) {
        setSessionModelById((current) => ({
          ...current,
          [payload.session.sessionId]: selectedModelId
        }));
      }
      if (selectedReasoningEffort) {
        setSessionReasoningEffortById((current) => ({
          ...current,
          [payload.session.sessionId]: selectedReasoningEffort
        }));
      }
      setMessages([]);
      setThoughtPanelStateByTurnId({});
      setPendingApprovals([]);
      setRenamingSessionId(null);
      setRenameDraft("");
      closeSessionMenu();
      setRequireSessionReselection(false);
      setDeletedSessionNotice(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create session");
    } finally {
      if (projectId) {
        setProjectActionProjectId(null);
      }
    }
  };

  const beginRenameSession = (session: SessionSummary): void => {
    closeSessionMenu();
    setRenamingSessionId(session.sessionId);
    setRenameDraft(session.title);
    setError(null);
  };

  const cancelRenameSession = (): void => {
    setRenamingSessionId(null);
    setRenameDraft("");
  };

  const toMenuAnchor = (trigger: HTMLElement): SessionMenuAnchor => {
    const rect = trigger.getBoundingClientRect();
    return {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left
    };
  };

  const resolveSessionMenuPosition = (
    anchor: SessionMenuAnchor,
    menuSize?: {
      width: number;
      height: number;
    }
  ): SessionMenuPosition => {
    const gap = 8;
    const viewportMargin = 8;
    const menuWidth = menuSize?.width ?? 0;
    const menuHeight = menuSize?.height ?? 0;
    const maxLeft = window.innerWidth - menuWidth - viewportMargin;
    const maxTop = window.innerHeight - menuHeight - viewportMargin;
    const preferredTop = anchor.top;
    const preferredLeft = anchor.right + gap;

    const top = menuHeight > 0 ? Math.max(viewportMargin, Math.min(preferredTop, maxTop)) : Math.max(viewportMargin, preferredTop);

    let left = Math.max(viewportMargin, preferredLeft);
    if (menuWidth > 0) {
      const rightLimit = window.innerWidth - viewportMargin;
      const fitsRight = preferredLeft + menuWidth <= rightLimit;
      if (fitsRight) {
        left = Math.max(viewportMargin, Math.min(preferredLeft, maxLeft));
      } else {
        const fallbackLeft = anchor.left - gap - menuWidth;
        left = Math.max(viewportMargin, Math.min(fallbackLeft, maxLeft));
      }
    }

    return {
      top,
      left
    };
  };

  const closeSessionMenu = (): void => {
    setSessionMenuSessionId(null);
    setSessionMenuPosition(null);
    setSessionMenuAnchor(null);
    sessionMenuTriggerRef.current = null;
  };

  const closeProjectMenu = (): void => {
    setProjectMenuProjectId(null);
    setProjectMenuPosition(null);
    setProjectMenuAnchor(null);
    projectMenuTriggerRef.current = null;
  };

  const closeProjectsHeaderMenu = (): void => {
    setShowProjectsHeaderMenu(false);
    setProjectsHeaderMenuPosition(null);
    setProjectsHeaderMenuAnchor(null);
    projectsHeaderMenuTriggerRef.current = null;
  };

  const closeModelMenu = (): void => {
    setModelMenuOpen(false);
    setModelMenuPosition(null);
    setModelMenuAnchor(null);
    modelMenuTriggerRef.current = null;
  };

  const toggleSessionMenu = (sessionId: string, trigger: HTMLButtonElement): void => {
    if (sessionMenuSessionId === sessionId) {
      closeSessionMenu();
      return;
    }

    closeProjectMenu();
    closeProjectsHeaderMenu();
    closeModelMenu();
    const anchor = toMenuAnchor(trigger);

    sessionMenuTriggerRef.current = trigger;
    setSessionMenuAnchor(anchor);
    setSessionMenuPosition(resolveSessionMenuPosition(anchor));
    setSessionMenuSessionId(sessionId);
  };

  const toggleProjectsHeaderMenu = (trigger: HTMLButtonElement): void => {
    if (showProjectsHeaderMenu) {
      closeProjectsHeaderMenu();
      return;
    }

    closeProjectMenu();
    closeSessionMenu();
    closeModelMenu();
    const anchor = toMenuAnchor(trigger);
    projectsHeaderMenuTriggerRef.current = trigger;
    setProjectsHeaderMenuAnchor(anchor);
    setProjectsHeaderMenuPosition(resolveSessionMenuPosition(anchor));
    setShowProjectsHeaderMenu(true);
  };

  const toggleProjectMenu = (projectId: string, trigger: HTMLButtonElement): void => {
    if (projectMenuProjectId === projectId) {
      closeProjectMenu();
      return;
    }

    closeSessionMenu();
    closeProjectsHeaderMenu();
    closeModelMenu();
    const anchor = toMenuAnchor(trigger);
    projectMenuTriggerRef.current = trigger;
    setProjectMenuAnchor(anchor);
    setProjectMenuPosition(resolveSessionMenuPosition(anchor));
    setProjectMenuProjectId(projectId);
  };

  const toggleModelMenu = (trigger: HTMLButtonElement): void => {
    if (modelMenuOpen) {
      closeModelMenu();
      return;
    }

    closeSessionMenu();
    closeProjectMenu();
    closeProjectsHeaderMenu();
    setThreadMenuOpen(false);
    const anchor = toMenuAnchor(trigger);
    modelMenuTriggerRef.current = trigger;
    setModelMenuAnchor(anchor);
    setModelMenuPosition(resolveSessionMenuPosition(anchor));
    setModelMenuOpen(true);
  };

  const submitRenameSession = async (sessionId: string): Promise<void> => {
    const nextTitle = renameDraft.trim();
    if (!nextTitle) {
      setError("session title cannot be empty");
      return;
    }

    setError(null);
    setSessionActionSessionId(sessionId);

    try {
      const response = await fetch(`${apiBase}/sessions/${encodeURIComponent(sessionId)}/rename`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ title: nextTitle })
      });

      if (!response.ok) {
        if (await handleDeletedSessionResponse(response, sessionId)) {
          cancelRenameSession();
          return;
        }
        throw new Error(`failed to rename session (${response.status})`);
      }

      const payload = (await response.json()) as { status: string; session: SessionSummary };
      setSessions((current) =>
        current.map((session) => (session.sessionId === sessionId ? { ...session, ...payload.session } : session))
      );
      cancelRenameSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to rename session");
    } finally {
      setSessionActionSessionId(null);
    }
  };

  const toggleArchiveStatus = async (sessionId: string, archivedView: boolean): Promise<void> => {
    setError(null);
    closeSessionMenu();
    setSessionActionSessionId(sessionId);

    try {
      const response = await fetch(
        `${apiBase}/sessions/${encodeURIComponent(sessionId)}/${archivedView ? "unarchive" : "archive"}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({})
        }
      );

      if (!response.ok) {
        if (await handleDeletedSessionResponse(response, sessionId)) {
          return;
        }
        if (!archivedView && response.status === 409) {
          const payload = (await response.json()) as { status?: string };
          if (payload.status === "not_materialized") {
            throw new Error("Session can be archived after its first message is sent.");
          }
        }
        throw new Error(`failed to ${archivedView ? "restore" : "archive"} session (${response.status})`);
      }

      if (renamingSessionId === sessionId) {
        cancelRenameSession();
      }

      const fallbackSessionId = selectedSessionId === sessionId ? null : selectedSessionId;
      await loadSessions(archivedView, fallbackSessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : `failed to ${archivedView ? "restore" : "archive"} session`);
    } finally {
      setSessionActionSessionId(null);
    }
  };

  const deleteSession = async (session: SessionSummary): Promise<void> => {
    const confirmed = window.confirm(
      `Delete "${session.title}" permanently?\n\nThis action cannot be undone and will remove the chat from disk.`
    );
    if (!confirmed) {
      return;
    }

    setError(null);
    closeSessionMenu();
    setSessionActionSessionId(session.sessionId);

    try {
      const response = await fetch(`${apiBase}/sessions/${encodeURIComponent(session.sessionId)}`, {
        method: "DELETE"
      });

      if (!response.ok) {
        if (await handleDeletedSessionResponse(response, session.sessionId)) {
          return;
        }
        throw new Error(`failed to delete session (${response.status})`);
      }

      const payload = (await response.json()) as SessionDeletedPayload & { sessionId?: string };
      applyDeletedSessionState({
        ...payload,
        sessionId: payload.sessionId ?? session.sessionId,
        title: payload.title ?? session.title
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to delete session");
    } finally {
      setSessionActionSessionId(null);
    }
  };

  const runThreadAction = async (label: string, action: () => Promise<void>): Promise<void> => {
    setThreadActionPending(label);
    setError(null);
    setThreadMenuOpen(false);

    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : `failed to ${label.toLowerCase()}`);
    } finally {
      setThreadActionPending(null);
    }
  };

  const forkSession = async (): Promise<void> => {
    if (!selectedSessionId) {
      return;
    }

    await runThreadAction("Fork", async () => {
      const response = await fetch(`${apiBase}/sessions/${encodeURIComponent(selectedSessionId)}/fork`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({})
      });
      if (!response.ok) {
        throw new Error(`failed to fork session (${response.status})`);
      }

      const payload = (await response.json()) as { session?: SessionSummary };
      const nextSessionId = payload.session?.sessionId;
      await loadSessions(showArchived, nextSessionId ?? selectedSessionId);
      if (nextSessionId) {
        setSelectedSessionId(nextSessionId);
      }
    });
  };

  const compactSession = async (): Promise<void> => {
    if (!selectedSessionId) {
      return;
    }

    await runThreadAction("Compact", async () => {
      const response = await fetch(`${apiBase}/sessions/${encodeURIComponent(selectedSessionId)}/compact`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({})
      });
      if (!response.ok) {
        throw new Error(`failed to compact context (${response.status})`);
      }
    });
  };

  const rollbackSession = async (): Promise<void> => {
    if (!selectedSessionId) {
      return;
    }

    const raw = window.prompt("Rollback how many turns?", "1");
    if (raw === null) {
      return;
    }

    const numTurns = Number(raw);
    if (!Number.isFinite(numTurns) || numTurns < 1 || !Number.isInteger(numTurns)) {
      setError("rollback value must be an integer >= 1");
      return;
    }

    const confirmed = window.confirm(`Rollback ${numTurns} turn${numTurns === 1 ? "" : "s"} from this chat?`);
    if (!confirmed) {
      return;
    }

    await runThreadAction("Rollback", async () => {
      const response = await fetch(`${apiBase}/sessions/${encodeURIComponent(selectedSessionId)}/rollback`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ numTurns })
      });
      if (!response.ok) {
        throw new Error(`failed to rollback session (${response.status})`);
      }

      await loadSessionTranscript(selectedSessionId);
    });
  };

  const startReview = async (): Promise<void> => {
    if (!selectedSessionId) {
      return;
    }

    const instructions = window.prompt("Review instructions", "Review uncommitted changes for correctness and risks.");
    if (instructions === null) {
      return;
    }

    await runThreadAction("Review", async () => {
      const response = await fetch(`${apiBase}/sessions/${encodeURIComponent(selectedSessionId)}/review`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          targetType: "custom",
          instructions,
          delivery: "inline"
        })
      });
      if (!response.ok) {
        throw new Error(`failed to start review (${response.status})`);
      }
    });
  };

  const cleanBackgroundTerminals = async (): Promise<void> => {
    if (!selectedSessionId) {
      return;
    }

    await runThreadAction("Clean Terminals", async () => {
      const response = await fetch(`${apiBase}/sessions/${encodeURIComponent(selectedSessionId)}/background-terminals/clean`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({})
      });
      if (!response.ok) {
        throw new Error(`failed to clean background terminals (${response.status})`);
      }
    });
  };

  const submitToolInputDecision = async (
    request: PendingToolInput,
    decision: "accept" | "decline" | "cancel"
  ): Promise<void> => {
    setError(null);
    setToolInputActionRequestId(request.requestId);
    try {
      const draftAnswers = toolInputDraftById[request.requestId] ?? {};
      const answerMap: Record<string, ToolInputAnswer> = {};
      for (const question of request.questions) {
        const value = (draftAnswers[question.id] ?? "").trim();
        if (!value) {
          continue;
        }

        answerMap[question.id] = {
          answers: [value]
        };
      }

      const response = await fetch(`${apiBase}/tool-input/${encodeURIComponent(request.requestId)}/decision`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          decision,
          answers: decision === "accept" ? answerMap : undefined
        })
      });
      if (!response.ok) {
        throw new Error(`failed to submit tool input decision (${response.status})`);
      }

      setPendingToolInputs((current) => current.filter((entry) => entry.requestId !== request.requestId));
      setToolInputDraftById((current) => {
        if (!(request.requestId in current)) {
          return current;
        }
        const { [request.requestId]: _removed, ...rest } = current;
        return rest;
      });
      resolveToolInputMessage({
        requestId: request.requestId,
        status: "resolved",
        decision
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to submit tool input decision");
    } finally {
      setToolInputActionRequestId(null);
    }
  };

  const dispatchMessage = async (text: string): Promise<void> => {
    if (!selectedSessionId) {
      setError("create or select a session first");
      return;
    }

    setError(null);
    setRetryPrompt(text);

    const optimisticId = `local-user-${Date.now()}`;
    const optimisticMessage: ChatMessage = {
      id: optimisticId,
      turnId: "pending",
      role: "user",
      type: "userMessage",
      content: text,
      status: "complete"
    };

    setMessages((current) => [...current, optimisticMessage]);
    const optimisticStartedAt = Date.now();
    setMessageTimingById((current) => ({
      ...current,
      [optimisticId]: {
        startedAt: optimisticStartedAt,
        completedAt: optimisticStartedAt
      }
    }));
    setStreaming(true);
    if (selectedModelId) {
      setSessionModelById((current) => ({
        ...current,
        [selectedSessionId]: selectedModelId
      }));
    }
    if (selectedReasoningEffort) {
      setSessionReasoningEffortById((current) => ({
        ...current,
        [selectedSessionId]: selectedReasoningEffort
      }));
    }

    try {
      const response = await fetch(`${apiBase}/sessions/${encodeURIComponent(selectedSessionId)}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          text,
          model: selectedModelId || undefined,
          effort: selectedReasoningEffort || undefined
        })
      });

      if (!response.ok) {
        if (await handleDeletedSessionResponse(response, selectedSessionId)) {
          setStreaming(false);
          setMessages((current) => current.filter((message) => message.id !== optimisticId));
          return;
        }
        throw new Error(`failed to send message (${response.status})`);
      }

      const payload = (await response.json()) as { turnId?: string };
      if (typeof payload.turnId === "string") {
        setActiveTurnIdBySession((current) => ({
          ...current,
          [selectedSessionId]: payload.turnId as string
        }));
        setMessages((current) =>
          current.map((message) =>
            message.id === optimisticId
              ? {
                  ...message,
                  turnId: payload.turnId as string
                }
              : message
          )
        );
      }
      startPendingSendAck(selectedSessionId, typeof payload.turnId === "string" ? payload.turnId : null);
    } catch (err) {
      setStreaming(false);
      setMessages((current) => current.filter((message) => message.id !== optimisticId));
      setMessageTimingById((current) => {
        if (!(optimisticId in current)) {
          return current;
        }
        const { [optimisticId]: _removed, ...rest } = current;
        return rest;
      });
      setDraft(text);
      clearPendingSendAck();
      setError(err instanceof Error ? err.message : "failed to send message");
    }
  };

  const sendMessage = async (): Promise<void> => {
    const text = draft.trim();
    if (!text) {
      return;
    }

    setDraft("");
    await dispatchMessage(text);
  };

  const retryLastMessage = async (): Promise<void> => {
    if (!retryPrompt) {
      return;
    }

    setDraft("");
    await dispatchMessage(retryPrompt);
  };

  const loadSuggestedReply = async (): Promise<void> => {
    if (!selectedSessionId) {
      setError("create or select a session first");
      return;
    }

    const sessionIdAtStart = selectedSessionId;
    const draftAtStart = draft.trim();
    suggestedReplyAbortRef.current?.abort();
    const controller = new AbortController();
    suggestedReplyAbortRef.current = controller;
    const requestId = suggestedReplyRequestIdRef.current + 1;
    suggestedReplyRequestIdRef.current = requestId;

    setError(null);
    setLoadingSuggestedReply(true);
    try {
      const response = await fetch(`${apiBase}/sessions/${encodeURIComponent(sessionIdAtStart)}/suggested-reply`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: selectedModelId || undefined,
          effort: selectedReasoningEffort || undefined,
          draft: draftAtStart || undefined
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        if (await handleDeletedSessionResponse(response, sessionIdAtStart)) {
          return;
        }
        throw new Error(`failed to load suggested reply (${response.status})`);
      }

      const payload = (await response.json()) as { suggestion?: string };
      const suggestion = typeof payload.suggestion === "string" ? payload.suggestion.trim() : "";
      if (suggestion) {
        if (controller.signal.aborted || suggestedReplyRequestIdRef.current !== requestId) {
          return;
        }
        if (selectedSessionIdRef.current !== sessionIdAtStart) {
          return;
        }
        if (draftRef.current.trim() !== draftAtStart) {
          return;
        }
        setDraft(suggestion);
      }
    } catch (err) {
      if (controller.signal.aborted) {
        return;
      }
      setError(err instanceof Error ? err.message : "failed to load suggested reply");
    } finally {
      if (suggestedReplyRequestIdRef.current === requestId) {
        setLoadingSuggestedReply(false);
        suggestedReplyAbortRef.current = null;
      }
    }
  };

  const handleComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (!(event.ctrlKey && event.key === "Enter")) {
      return;
    }
    event.preventDefault();
    if (!selectedSessionId || !draft.trim()) {
      return;
    }
    void sendMessage();
  };

  const applyModelReasoningSelection = (modelId: string, effort: ReasoningEffort): void => {
    const targetModel = models.find((model) => model.id === modelId) ?? null;
    if (!targetModel) {
      return;
    }

    if (!isReasoningEffortSupportedByModel(targetModel, effort)) {
      return;
    }

    setSelectedModelId(modelId);
    setSelectedReasoningEffort(effort);
    closeModelMenu();

    if (!selectedSessionId || !modelId) {
      return;
    }

    setSessionModelById((current) => ({
      ...current,
      [selectedSessionId]: modelId
    }));

    setSessionReasoningEffortById((current) => ({
      ...current,
      [selectedSessionId]: effort
    }));
  };

  const interruptTurn = async (): Promise<void> => {
    if (!selectedSessionId) {
      return;
    }

    setError(null);

    try {
      const response = await fetch(`${apiBase}/sessions/${encodeURIComponent(selectedSessionId)}/interrupt`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({})
      });

      if (!response.ok) {
        if (await handleDeletedSessionResponse(response, selectedSessionId)) {
          return;
        }
        throw new Error(`failed to interrupt turn (${response.status})`);
      }

      setStreaming(false);
      setSteerDraft("");
      setActiveTurnIdBySession((current) => {
        if (!(selectedSessionId in current)) {
          return current;
        }

        const { [selectedSessionId]: _removed, ...rest } = current;
        return rest;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to interrupt turn");
    }
  };

  const submitSteer = async (): Promise<void> => {
    if (!selectedSessionId || !activeTurnId) {
      setError("No active turn is available to steer.");
      return;
    }

    const input = steerDraft.trim();
    if (!input) {
      return;
    }

    setSubmittingSteer(true);
    setError(null);
    try {
      const response = await fetch(
        `${apiBase}/sessions/${encodeURIComponent(selectedSessionId)}/turns/${encodeURIComponent(activeTurnId)}/steer`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ input })
        }
      );

      if (!response.ok) {
        throw new Error(`failed to steer turn (${response.status})`);
      }

      setSteerDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to steer turn");
    } finally {
      setSubmittingSteer(false);
    }
  };

  const submitApprovalDecision = async (
    approvalId: string,
    decision: "accept" | "decline" | "cancel",
    scope: "turn" | "session" = "turn"
  ): Promise<void> => {
    setError(null);

    try {
      const response = await fetch(`${apiBase}/approvals/${encodeURIComponent(approvalId)}/decision`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ decision, scope })
      });

      if (!response.ok) {
        throw new Error(`failed to submit approval (${response.status})`);
      }

      setPendingApprovals((current) => current.filter((approval) => approval.approvalId !== approvalId));
      resolveApprovalMessage({
        approvalId,
        status: "resolved",
        decision,
        scope
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to submit approval decision");
    }
  };

  const runSettingsAction = async (label: string, action: () => Promise<unknown>, reloadAfter = true): Promise<void> => {
    setSettingsError(null);
    setSettingsActionPending(label);
    try {
      const result = await action();
      setSettingsActionResult(result);
      if (reloadAfter) {
        await loadSettingsData();
      }
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : `failed to run ${label.toLowerCase()}`);
    } finally {
      setSettingsActionPending(null);
    }
  };

  const reloadMcpConfig = async (): Promise<void> => {
    await runSettingsAction("Reload MCP", async () => {
      const response = await fetch(`${apiBase}/mcp/reload`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({})
      });
      if (!response.ok) {
        throw new Error(`failed to reload mcp config (${response.status})`);
      }
      const payload = (await response.json()) as Record<string, unknown>;
      await loadMcpServers();
      return payload;
    });
  };

  const startMcpOauth = async (serverName: string): Promise<void> => {
    await runSettingsAction(`MCP OAuth (${serverName})`, async () => {
      const response = await fetch(`${apiBase}/mcp/servers/${encodeURIComponent(serverName)}/oauth/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({})
      });
      if (!response.ok) {
        throw new Error(`failed to start oauth login (${response.status})`);
      }
      const payload = (await response.json()) as { result?: { authUrl?: string } };
      const authUrl = payload?.result && typeof payload.result.authUrl === "string" ? payload.result.authUrl : null;
      if (authUrl) {
        window.open(authUrl, "_blank", "noopener,noreferrer");
      }
      return payload;
    });
  };

  const startAccountChatGptLogin = async (): Promise<void> => {
    await runSettingsAction("Start ChatGPT Login", async () => {
      const response = await fetch(`${apiBase}/account/login/start`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ type: "chatgpt" })
      });
      if (!response.ok) {
        throw new Error(`failed to start account login (${response.status})`);
      }
      const payload = (await response.json()) as { result?: { authUrl?: string } };
      const authUrl = payload?.result && typeof payload.result.authUrl === "string" ? payload.result.authUrl : null;
      if (authUrl) {
        window.open(authUrl, "_blank", "noopener,noreferrer");
      }
      return payload;
    });
  };

  const startAccountApiKeyLogin = async (): Promise<void> => {
    const apiKey = window.prompt("OpenAI API key");
    if (apiKey === null) {
      return;
    }
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setSettingsError("api key cannot be empty");
      return;
    }

    await runSettingsAction("Start API Key Login", async () => {
      const response = await fetch(`${apiBase}/account/login/start`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          type: "apiKey",
          apiKey: trimmed
        })
      });
      if (!response.ok) {
        throw new Error(`failed to start API-key login (${response.status})`);
      }
      return (await response.json()) as Record<string, unknown>;
    });
  };

  const cancelAccountLogin = async (): Promise<void> => {
    const defaultLoginId = extractLoginIdCandidate(accountStatus);
    const loginId = window.prompt("Login id to cancel", defaultLoginId);
    if (loginId === null) {
      return;
    }
    const trimmed = loginId.trim();
    if (!trimmed) {
      setSettingsError("login id cannot be empty");
      return;
    }

    await runSettingsAction("Cancel Login", async () => {
      const response = await fetch(`${apiBase}/account/login/cancel`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ loginId: trimmed })
      });
      if (!response.ok) {
        throw new Error(`failed to cancel account login (${response.status})`);
      }
      return (await response.json()) as Record<string, unknown>;
    });
  };

  const logoutAccount = async (): Promise<void> => {
    const confirmed = window.confirm("Log out of the current account?");
    if (!confirmed) {
      return;
    }

    await runSettingsAction("Logout", async () => {
      const response = await fetch(`${apiBase}/account/logout`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({})
      });
      if (!response.ok) {
        throw new Error(`failed to logout account (${response.status})`);
      }
      return (await response.json()) as Record<string, unknown>;
    });
  };

  const writeAllowlistedConfigValue = async (keyPath: string, value: unknown): Promise<void> => {
    await runSettingsAction(`Config Write (${keyPath})`, async () => {
      const response = await fetch(`${apiBase}/config/value`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          keyPath,
          mergeStrategy: "upsert",
          value
        })
      });
      if (!response.ok) {
        throw new Error(`failed to write config (${response.status})`);
      }
      return (await response.json()) as Record<string, unknown>;
    });
  };

  const writeConfigBatch = async (): Promise<void> => {
    const raw = window.prompt(
      "Config batch edits JSON",
      '[{"keyPath":"model","mergeStrategy":"upsert","value":"gpt-5.3-codex"}]'
    );
    if (raw === null) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      setSettingsError("config batch input must be valid JSON");
      return;
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      setSettingsError("config batch input must be a non-empty JSON array");
      return;
    }

    await runSettingsAction("Config Batch Write", async () => {
      const response = await fetch(`${apiBase}/config/batch`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          edits: parsed
        })
      });
      if (!response.ok) {
        throw new Error(`failed to batch write config (${response.status})`);
      }
      return (await response.json()) as Record<string, unknown>;
    });
  };

  const updateSkillEnabledState = async (enabled: boolean): Promise<void> => {
    const skillPath = window.prompt(enabled ? "Skill path to enable" : "Skill path to disable");
    if (skillPath === null) {
      return;
    }
    const trimmed = skillPath.trim();
    if (!trimmed) {
      setSettingsError("skill path cannot be empty");
      return;
    }

    await runSettingsAction(enabled ? "Enable Skill" : "Disable Skill", async () => {
      const response = await fetch(`${apiBase}/skills/config`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          path: trimmed,
          enabled
        })
      });
      if (!response.ok) {
        throw new Error(`failed to update skill config (${response.status})`);
      }
      return (await response.json()) as Record<string, unknown>;
    });
  };

  const writeRemoteSkillSetting = async (): Promise<void> => {
    const hazelnutId = window.prompt("Remote skill id (hazelnutId)");
    if (hazelnutId === null) {
      return;
    }
    const trimmed = hazelnutId.trim();
    if (!trimmed) {
      setSettingsError("remote skill id cannot be empty");
      return;
    }

    const preload = window.confirm("Enable preload for this remote skill?");

    await runSettingsAction("Remote Skill Config", async () => {
      const response = await fetch(`${apiBase}/skills/remote`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          hazelnutId: trimmed,
          isPreload: preload
        })
      });
      if (!response.ok) {
        throw new Error(`failed to update remote skill setting (${response.status})`);
      }
      return (await response.json()) as Record<string, unknown>;
    });
  };

  const executeOneOffCommand = async (): Promise<void> => {
    const input = window.prompt("Command argv (space-separated or JSON array)", "pwd");
    if (input === null) {
      return;
    }

    let command: Array<string>;
    try {
      command = parseShellLikeArgs(input);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "invalid command input");
      return;
    }

    if (command.length === 0) {
      setSettingsError("command cannot be empty");
      return;
    }

    await runSettingsAction("Command Exec", async () => {
      const response = await fetch(`${apiBase}/commands/exec`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          command
        })
      });
      if (!response.ok) {
        throw new Error(`failed to execute command (${response.status})`);
      }
      return (await response.json()) as Record<string, unknown>;
    }, false);
  };

  const uploadFeedback = async (): Promise<void> => {
    const classification = window.prompt("Feedback classification", "ux");
    if (classification === null) {
      return;
    }
    const trimmedClassification = classification.trim();
    if (!trimmedClassification) {
      setSettingsError("feedback classification cannot be empty");
      return;
    }

    const reason = window.prompt("Feedback reason (optional)");
    if (reason === null) {
      return;
    }

    const includeLogs = window.confirm("Include logs in feedback upload?");

    await runSettingsAction("Feedback Upload", async () => {
      const response = await fetch(`${apiBase}/feedback`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          classification: trimmedClassification,
          includeLogs,
          reason: reason.trim() ? reason.trim() : undefined,
          threadId: selectedSessionId ?? undefined
        })
      });
      if (!response.ok) {
        throw new Error(`failed to upload feedback (${response.status})`);
      }
      return (await response.json()) as Record<string, unknown>;
    }, false);
  };

  useEffect(() => {
    if (!modelMenuOpen) {
      return;
    }

    const handleClickOutside = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      const insideMenu = modelMenuRef.current?.contains(target) ?? false;
      const insideTrigger = modelMenuTriggerRef.current?.contains(target) ?? false;
      if (!insideMenu && !insideTrigger) {
        closeModelMenu();
      }
    };

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeModelMenu();
      }
    };

    const handleResize = (): void => {
      closeModelMenu();
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", handleResize);
    };
  }, [modelMenuOpen]);

  useEffect(() => {
    if (!sessionMenuSessionId) {
      return;
    }

    const handleClickOutside = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      const insideMenu = openSessionMenuRef.current?.contains(target) ?? false;
      const insideTrigger = sessionMenuTriggerRef.current?.contains(target) ?? false;
      if (!insideMenu && !insideTrigger) {
        closeSessionMenu();
      }
    };

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeSessionMenu();
      }
    };

    const handleResize = (): void => {
      closeSessionMenu();
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", handleResize);
    };
  }, [sessionMenuSessionId]);

  useEffect(() => {
    if (!projectMenuProjectId) {
      return;
    }

    const handleClickOutside = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      const insideMenu = projectMenuRef.current?.contains(target) ?? false;
      const insideTrigger = projectMenuTriggerRef.current?.contains(target) ?? false;
      if (!insideMenu && !insideTrigger) {
        closeProjectMenu();
      }
    };

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeProjectMenu();
      }
    };

    const handleResize = (): void => {
      closeProjectMenu();
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", handleResize);
    };
  }, [projectMenuProjectId]);

  useEffect(() => {
    if (!showProjectsHeaderMenu) {
      return;
    }

    const handleClickOutside = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      const insideMenu = projectsHeaderMenuRef.current?.contains(target) ?? false;
      const insideTrigger = projectsHeaderMenuTriggerRef.current?.contains(target) ?? false;
      if (!insideMenu && !insideTrigger) {
        closeProjectsHeaderMenu();
      }
    };

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeProjectsHeaderMenu();
      }
    };

    const handleResize = (): void => {
      closeProjectsHeaderMenu();
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", handleResize);
    };
  }, [showProjectsHeaderMenu]);

  useEffect(() => {
    if (!threadMenuOpen) {
      return;
    }

    const handleClickOutside = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      const insideMenu = threadMenuRef.current?.contains(target) ?? false;
      const insideTrigger = threadMenuTriggerRef.current?.contains(target) ?? false;
      if (!insideMenu && !insideTrigger) {
        setThreadMenuOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setThreadMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [threadMenuOpen]);

  useEffect(() => {
    closeSessionMenu();
    closeProjectMenu();
    closeProjectsHeaderMenu();
    closeModelMenu();
    setThreadMenuOpen(false);
  }, [selectedSessionId, showArchived]);

  useEffect(() => {
    if (!modelMenuOpen || !modelMenuAnchor || !modelMenuRef.current) {
      return;
    }

    const measured = modelMenuRef.current.getBoundingClientRect();
    const next = resolveSessionMenuPosition(modelMenuAnchor, {
      width: measured.width,
      height: measured.height
    });

    setModelMenuPosition((current) => {
      if (current && Math.abs(current.top - next.top) < 0.5 && Math.abs(current.left - next.left) < 0.5) {
        return current;
      }
      return next;
    });
  }, [modelMenuOpen, modelMenuAnchor, models, selectedModelId, selectedReasoningEffort]);

  useEffect(() => {
    if (!sessionMenuSessionId || !sessionMenuAnchor || !openSessionMenuRef.current) {
      return;
    }

    const measured = openSessionMenuRef.current.getBoundingClientRect();
    const next = resolveSessionMenuPosition(sessionMenuAnchor, {
      width: measured.width,
      height: measured.height
    });

    setSessionMenuPosition((current) => {
      if (current && Math.abs(current.top - next.top) < 0.5 && Math.abs(current.left - next.left) < 0.5) {
        return current;
      }
      return next;
    });
  }, [sessionMenuSessionId, sessionMenuAnchor, showArchived, projects]);

  useEffect(() => {
    if (!projectMenuProjectId || !projectMenuAnchor || !projectMenuRef.current) {
      return;
    }

    const measured = projectMenuRef.current.getBoundingClientRect();
    const next = resolveSessionMenuPosition(projectMenuAnchor, {
      width: measured.width,
      height: measured.height
    });

    setProjectMenuPosition((current) => {
      if (current && Math.abs(current.top - next.top) < 0.5 && Math.abs(current.left - next.left) < 0.5) {
        return current;
      }
      return next;
    });
  }, [projectMenuProjectId, projectMenuAnchor, sessions, projects, showArchived]);

  useEffect(() => {
    if (!showProjectsHeaderMenu || !projectsHeaderMenuAnchor || !projectsHeaderMenuRef.current) {
      return;
    }

    const measured = projectsHeaderMenuRef.current.getBoundingClientRect();
    const next = resolveSessionMenuPosition(projectsHeaderMenuAnchor, {
      width: measured.width,
      height: measured.height
    });

    setProjectsHeaderMenuPosition((current) => {
      if (current && Math.abs(current.top - next.top) < 0.5 && Math.abs(current.left - next.left) < 0.5) {
        return current;
      }
      return next;
    });
  }, [showProjectsHeaderMenu, projectsHeaderMenuAnchor, loadingProjects]);

  useEffect(() => {
    if (!projectMenuProjectId) {
      return;
    }

    const exists = visibleProjects.some((project) => project.projectId === projectMenuProjectId);
    if (!exists) {
      closeProjectMenu();
    }
  }, [visibleProjects, projectMenuProjectId]);

  useEffect(() => {
    if (!showProjectsSection) {
      closeProjectsHeaderMenu();
    }
  }, [showProjectsSection]);

  useEffect(() => {
    if (modelMenuOpen && models.length === 0) {
      closeModelMenu();
    }
  }, [modelMenuOpen, models.length]);

  useEffect(() => {
    void loadSessions(showArchived);
  }, [showArchived]);

  useEffect(() => {
    void loadModels();
    void loadMcpServers();
    void loadProjects();
    void loadCapabilities();
  }, []);

  useEffect(() => {
    suggestedReplyAbortRef.current?.abort();
    suggestedReplyAbortRef.current = null;
    suggestedReplyRequestIdRef.current += 1;
    clearPendingSendAck();

    if (!selectedSessionId) {
      setMessages([]);
      setMessageTimingById({});
      setThoughtPanelStateByTurnId({});
      setPendingApprovals([]);
      setPendingToolInputs([]);
      setFollowTranscriptTail(true);
      setShowJumpToBottom(false);
      setRetryPrompt(null);
      setLoadingSuggestedReply(false);
      setSteerDraft("");
      return;
    }

    setFollowTranscriptTail(true);
    setShowJumpToBottom(false);
    setRetryPrompt(null);
    setLoadingSuggestedReply(false);
    void loadSessionTranscript(selectedSessionId);
    void loadSessionApprovals(selectedSessionId);
    void loadSessionToolInputs(selectedSessionId);
  }, [selectedSessionId]);

  useEffect(() => {
    return () => {
      suggestedReplyAbortRef.current?.abort();
      suggestedReplyAbortRef.current = null;
      suggestedReplyRequestIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!showSettings) {
      return;
    }

    void loadSettingsData();
  }, [showSettings]);

  useEffect(() => {
    if (selectedSessionId) {
      const sessionModel = sessionModelById[selectedSessionId];
      if (sessionModel && models.some((model) => model.id === sessionModel)) {
        setSelectedModelId(sessionModel);
        return;
      }

      setSelectedModelId(defaultModelId || "");
      return;
    }

    setSelectedModelId(defaultModelId || "");
  }, [selectedSessionId, sessionModelById, defaultModelId, models]);

  useEffect(() => {
    const fallbackEffort = preferredReasoningEffortForModel(selectedModelOption);
    if (!selectedSessionId) {
      setSelectedReasoningEffort((current) => {
        if (current && isReasoningEffortSupportedByModel(selectedModelOption, current)) {
          return current;
        }
        return current === fallbackEffort ? current : fallbackEffort;
      });
      return;
    }

    const sessionEffort = sessionReasoningEffortById[selectedSessionId];
    const nextEffort =
      sessionEffort && isReasoningEffortSupportedByModel(selectedModelOption, sessionEffort) ? sessionEffort : fallbackEffort;
    setSelectedReasoningEffort((current) => (current === nextEffort ? current : nextEffort));
  }, [selectedSessionId, sessionReasoningEffortById, selectedModelOption]);

  useEffect(() => {
    if (!selectedSessionId) {
      return;
    }

    setSessionReasoningEffortById((current) => {
      if (!selectedReasoningEffort) {
        if (!(selectedSessionId in current)) {
          return current;
        }

        const { [selectedSessionId]: _removed, ...rest } = current;
        return rest;
      }

      if (current[selectedSessionId] === selectedReasoningEffort) {
        return current;
      }

      return {
        ...current,
        [selectedSessionId]: selectedReasoningEffort
      };
    });
  }, [selectedSessionId, selectedReasoningEffort]);

  useEffect(() => {
    if (!deletedSessionNotice) {
      return;
    }

    if (selectedSessionId && selectedSessionId !== deletedSessionNotice.sessionId) {
      setDeletedSessionNotice(null);
      setRequireSessionReselection(false);
    }
  }, [selectedSessionId, deletedSessionNotice]);

  useEffect(() => {
    let disposed = false;
    let reconnectScheduled = false;

    const ws = new WebSocket(toWsUrl(apiBase, selectedSessionId));
    websocketRef.current = ws;
    setWsState("connecting");

    const scheduleReconnect = (): void => {
      if (disposed || reconnectScheduled) {
        return;
      }

      reconnectScheduled = true;
      setWsState("disconnected");
      const attempt = reconnectAttemptRef.current + 1;
      reconnectAttemptRef.current = attempt;
      const backoffMs = Math.min(10_000, 500 * 2 ** (attempt - 1));
      const jitterMs = Math.floor(Math.random() * 250);

      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }

      reconnectTimerRef.current = window.setTimeout(() => {
        if (!disposed) {
          setWsReconnectNonce((value) => value + 1);
        }
      }, backoffMs + jitterMs);
    };

    ws.addEventListener("open", () => {
      reconnectAttemptRef.current = 0;
      reconnectScheduled = false;
      setWsState("connected");
    });

    ws.addEventListener("close", () => {
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        return;
      }

      scheduleReconnect();
    });

    ws.addEventListener("message", (event) => {
      try {
        const envelope = JSON.parse(event.data as string) as NotificationEnvelope;

        if (envelope.type === "session_deleted") {
          const payload = envelope.payload as SessionDeletedPayload;
          if (typeof payload?.sessionId !== "string") {
            return;
          }

          applyDeletedSessionState(payload);
          return;
        }

        if (envelope.type === "project_upserted") {
          const payload = envelope.payload as ProjectUpsertedPayload;
          const incoming = normalizeProjectSummary(payload.project);
          if (!incoming) {
            return;
          }

          setProjects((current) => {
            const byId = new Map(current.map((entry) => [entry.projectId, entry]));
            byId.set(incoming.projectId, incoming);
            return Array.from(byId.values()).sort((left, right) => left.name.localeCompare(right.name));
          });
          setExpandedProjectsById((current) => ({
            ...current,
            [incoming.projectId]: current[incoming.projectId] ?? true
          }));
          return;
        }

        if (envelope.type === "project_deleted") {
          const payload = envelope.payload as ProjectDeletedPayload;
          if (typeof payload?.projectId !== "string") {
            return;
          }

          setProjects((current) => current.filter((project) => project.projectId !== payload.projectId));
          setExpandedProjectsById((current) => {
            const { [payload.projectId as string]: _deleted, ...rest } = current;
            return rest;
          });

          if (Array.isArray(payload.sessionIds) && payload.sessionIds.length > 0) {
            const unassigned = new Set(payload.sessionIds);
            setSessions((current) =>
              current.map((session) => (unassigned.has(session.sessionId) ? { ...session, projectId: null } : session))
            );
          }
          return;
        }

        if (envelope.type === "session_project_updated") {
          const payload = envelope.payload as SessionProjectUpdatedPayload;
          if (typeof payload?.sessionId !== "string") {
            return;
          }

          const nextProjectId = payload.projectId === null ? null : typeof payload.projectId === "string" ? payload.projectId : null;
          setSessions((current) =>
            current.map((session) =>
              session.sessionId === payload.sessionId ? { ...session, projectId: nextProjectId } : session
            )
          );
          return;
        }

        if (envelope.type === "approval") {
          const approval = envelope.payload as PendingApproval;
          if (!approval || typeof approval.approvalId !== "string") {
            return;
          }

          setPendingApprovals((current) => {
            if (selectedSessionId && approval.threadId !== selectedSessionId) {
              return current;
            }

            const existingIndex = current.findIndex((entry) => entry.approvalId === approval.approvalId);
            if (existingIndex === -1) {
              return [...current, approval].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
            }

            const next = [...current];
            next[existingIndex] = approval;
            return next;
          });
          upsertPendingApprovalMessage(approval);
          return;
        }

        if (envelope.type === "approval_resolved") {
          const payload = envelope.payload as {
            approvalId?: string;
            status?: string;
            decision?: "accept" | "decline" | "cancel";
            scope?: "turn" | "session";
          };
          if (typeof payload?.approvalId !== "string") {
            return;
          }

          setPendingApprovals((current) => current.filter((approval) => approval.approvalId !== payload.approvalId));
          resolveApprovalMessage({
            approvalId: payload.approvalId,
            status: payload.status,
            decision: payload.decision,
            scope: payload.scope
          });
          return;
        }

        if (envelope.type === "tool_user_input_requested") {
          const request = envelope.payload as PendingToolInput;
          if (!request || typeof request.requestId !== "string") {
            return;
          }

          setPendingToolInputs((current) => {
            if (selectedSessionId && request.threadId !== selectedSessionId) {
              return current;
            }

            const existingIndex = current.findIndex((entry) => entry.requestId === request.requestId);
            if (existingIndex === -1) {
              return [...current, request].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
            }

            const next = [...current];
            next[existingIndex] = request;
            return next;
          });
          upsertPendingToolInputMessage(request);
          return;
        }

        if (envelope.type === "tool_user_input_resolved") {
          const payload = envelope.payload as {
            requestId?: string;
            status?: string;
            decision?: "accept" | "decline" | "cancel";
          };
          if (typeof payload?.requestId !== "string") {
            return;
          }

          setPendingToolInputs((current) => current.filter((request) => request.requestId !== payload.requestId));
          setToolInputDraftById((current) => {
            if (!(payload.requestId as string in current)) {
              return current;
            }
            const { [payload.requestId as string]: _removed, ...rest } = current;
            return rest;
          });
          resolveToolInputMessage({
            requestId: payload.requestId,
            status: payload.status,
            decision: payload.decision
          });
          return;
        }

        if (envelope.type === "turn_plan_updated") {
          const threadId = envelope.threadId;
          if (!threadId) {
            return;
          }

          const payload = asRecord(envelope.payload) ?? { raw: envelope.payload };
          setPlanBySession((current) => ({
            ...current,
            [threadId]: [...(current[threadId] ?? []), payload].slice(-100)
          }));
          return;
        }

        if (envelope.type === "turn_diff_updated") {
          const threadId = envelope.threadId;
          if (!threadId) {
            return;
          }

          const payload = asRecord(envelope.payload) ?? { raw: envelope.payload };
          setDiffBySession((current) => ({
            ...current,
            [threadId]: [...(current[threadId] ?? []), payload].slice(-100)
          }));
          return;
        }

        if (envelope.type === "thread_token_usage_updated") {
          const threadId = envelope.threadId;
          if (!threadId) {
            return;
          }

          const payload = asRecord(envelope.payload) ?? { raw: envelope.payload };
          setUsageBySession((current) => ({
            ...current,
            [threadId]: [...(current[threadId] ?? []), payload].slice(-100)
          }));
          return;
        }

        if (envelope.type === "app_list_updated") {
          void loadSettingsData();
          return;
        }

        if (
          envelope.type === "mcp_oauth_completed" ||
          envelope.type === "account_updated" ||
          envelope.type === "account_login_completed" ||
          envelope.type === "account_rate_limits_updated"
        ) {
          void loadSettingsData();
          return;
        }

        if (envelope.type === "server_request") {
          const payload = envelope.payload as { method?: string };
          if (payload?.method === "account/chatgptAuthTokens/refresh") {
            setError(
              "Codex requested auth token refresh. Configure valid OpenAI credentials (for example OPENAI_API_KEY) and restart the API."
            );
            return;
          }

          setError(`unsupported server request: ${payload?.method ?? "unknown"}`);
          return;
        }

        if (envelope.type === "error") {
          setError(envelope.message ?? "websocket error");
          return;
        }

        if (envelope.type !== "notification" || !envelope.payload) {
          return;
        }

        const payload = envelope.payload as {
          method?: string;
          params?: unknown;
        };

        const method = payload.method;
        const params = payload.params;

        if (method === "thread/name/updated") {
          const namePayload = params as {
            threadId?: string;
            threadName?: string;
          };

          if (
            typeof namePayload.threadId === "string" &&
            typeof namePayload.threadName === "string" &&
            namePayload.threadName.trim().length > 0
          ) {
            const nextTitle = namePayload.threadName.trim();
            setSessions((current) =>
              current.map((session) =>
                session.sessionId === namePayload.threadId ? { ...session, title: nextTitle } : session
              )
            );
          }
          return;
        }

        if (method === "turn/started") {
          const turnPayload = params as {
            threadId?: string;
            turn?: { id?: string };
          };
          if (typeof turnPayload.threadId === "string" && typeof turnPayload.turn?.id === "string") {
            setActiveTurnIdBySession((current) => ({
              ...current,
              [turnPayload.threadId as string]: turnPayload.turn?.id as string
            }));
          }
          if (typeof turnPayload.threadId === "string") {
            markSendActivityObserved(turnPayload.threadId, typeof turnPayload.turn?.id === "string" ? turnPayload.turn.id : undefined);
          }
          setStreaming(true);
          return;
        }

        if (method === "turn/completed" || method === "turn/failed") {
          setStreaming(false);
          setSteerDraft("");

          const completedPayload = params as {
            threadId?: string;
            turn?: {
              id?: string;
              status?: string;
              error?: {
                message?: string;
                additionalDetails?: string | null;
              } | null;
            };
            error?: {
              message?: string;
              additionalDetails?: string | null;
            } | null;
          };

          const status = completedPayload.turn?.status ?? (method === "turn/failed" ? "failed" : undefined);
          if (typeof completedPayload.threadId === "string") {
            markSendActivityObserved(
              completedPayload.threadId,
              typeof completedPayload.turn?.id === "string" ? completedPayload.turn.id : undefined
            );
            setActiveTurnIdBySession((current) => {
              if (!(completedPayload.threadId as string in current)) {
                return current;
              }

              const { [completedPayload.threadId as string]: _removed, ...rest } = current;
              return rest;
            });
          }
          if (status === "failed") {
            const turnId = completedPayload.turn?.id ?? "turn";
            const errorMessage =
              completedPayload.turn?.error?.message ??
              completedPayload.turn?.error?.additionalDetails ??
              completedPayload.error?.message ??
              completedPayload.error?.additionalDetails ??
              "Turn failed";
            const normalized = normalizeRuntimeErrorMessage(errorMessage);
            setError(normalized);
            upsertSystemErrorMessage(`turn-failure-${turnId}`, turnId, `Turn failed: ${normalized}`);
          }

          return;
        }

        if (method === "error") {
          const errorPayload = params as {
            error?: {
              message?: string;
              additionalDetails?: string | null;
            };
            willRetry?: boolean;
            turnId?: string;
          };

          const rawMessage =
            errorPayload.error?.message ??
            errorPayload.error?.additionalDetails ??
            "Codex reported an error";
          const normalized = normalizeRuntimeErrorMessage(rawMessage);
          setError(errorPayload.willRetry ? `${normalized} (retrying)` : normalized);

          if (!errorPayload.willRetry) {
            upsertSystemErrorMessage(
              `runtime-error-${errorPayload.turnId ?? Date.now().toString()}`,
              errorPayload.turnId ?? "runtime",
              normalized
            );
          }
          return;
        }

        if (method === "item/agentMessage/delta") {
          const deltaPayload = params as {
            itemId?: string;
            turnId?: string;
            delta?: string;
          };

          if (typeof deltaPayload.itemId !== "string") {
            return;
          }
          const deltaThreadId = envelope.threadId;
          const deltaTurnId = deltaPayload.turnId;
          if (typeof deltaThreadId === "string" && typeof deltaTurnId === "string") {
            setActiveTurnIdBySession((current) => {
              if (current[deltaThreadId] === deltaTurnId) {
                return current;
              }

              return {
                ...current,
                [deltaThreadId]: deltaTurnId
              };
            });
            setStreaming(true);
          }
          const itemId = deltaPayload.itemId;
          const now = Date.now();

          setMessageTimingById((current) => {
            const existing = current[itemId];
            if (existing?.startedAt) {
              return current;
            }
            return {
              ...current,
              [itemId]: {
                startedAt: now
              }
            };
          });

          setMessages((current) => {
            const existingIndex = current.findIndex((message) => message.id === itemId);
            if (existingIndex === -1) {
              return [
                ...current,
                {
                  id: itemId,
                  turnId: typeof deltaPayload.turnId === "string" ? deltaPayload.turnId : "stream",
                  role: "assistant",
                  type: "agentMessage",
                  content: deltaPayload.delta ?? "",
                  status: "streaming"
                }
              ];
            }

            const next = [...current];
            const existing = next[existingIndex];
            next[existingIndex] = {
              ...existing,
              content: `${existing.content}${deltaPayload.delta ?? ""}`,
              status: "streaming"
            };
            return next;
          });
          const ackSessionId = selectedSessionIdRef.current;
          if (ackSessionId) {
            markSendActivityObserved(ackSessionId, typeof deltaPayload.turnId === "string" ? deltaPayload.turnId : undefined);
          }
          return;
        }

        if (method === "item/started" || method === "item/completed") {
          const itemPayload = params as {
            item?: Record<string, unknown>;
            turnId?: string;
          };

          if (!itemPayload.item || typeof itemPayload.item.id !== "string") {
            return;
          }

          const item = itemPayload.item;
          const itemId = item.id as string;
          const itemType = typeof item.type === "string" ? item.type : "event";
          const turnId = typeof itemPayload.turnId === "string" ? itemPayload.turnId : "turn";
          const itemThreadId = envelope.threadId;
          const itemTurnId = itemPayload.turnId;
          if (method === "item/started" && typeof itemThreadId === "string" && typeof itemTurnId === "string") {
            setActiveTurnIdBySession((current) => {
              if (current[itemThreadId] === itemTurnId) {
                return current;
              }

              return {
                ...current,
                [itemThreadId]: itemTurnId
              };
            });
            setStreaming(true);
          }

          if (itemType === "userMessage") {
            return;
          }

          const ackSessionId = typeof envelope.threadId === "string" ? envelope.threadId : selectedSessionIdRef.current;
          if (ackSessionId) {
            markSendActivityObserved(ackSessionId, typeof itemPayload.turnId === "string" ? itemPayload.turnId : undefined);
          }

          if (itemType === "agentMessage" && method === "item/completed") {
            const text = typeof item.text === "string" ? item.text : "";
            const now = Date.now();

            setMessageTimingById((current) => {
              const existing = current[itemId];
              const startedAt = existing?.startedAt ?? now;
              const completedAt = now;
              if (existing && existing.startedAt === startedAt && existing.completedAt === completedAt) {
                return current;
              }
              return {
                ...current,
                [itemId]: {
                  startedAt,
                  completedAt
                }
              };
            });

            setMessages((current) => {
              const existingIndex = current.findIndex((message) => message.id === itemId);
              if (existingIndex === -1) {
                return [
                  ...current,
                  {
                    id: itemId,
                    turnId,
                    role: "assistant",
                    type: "agentMessage",
                    content: text,
                    status: "complete"
                  }
                ];
              }

              const next = [...current];
              next[existingIndex] = {
                ...next[existingIndex],
                content: text || next[existingIndex].content,
                status: "complete"
              };
              return next;
            });
            return;
          }

          if (itemType !== "agentMessage") {
            const described = summarizeToolEvent(item);
            const nextStatus = method === "item/started" ? "streaming" : "complete";
            const now = Date.now();

            setMessageTimingById((current) => {
              const existing = current[itemId];
              if (method === "item/started") {
                if (existing?.startedAt && existing.completedAt === undefined) {
                  return current;
                }
                return {
                  ...current,
                  [itemId]: {
                    startedAt: existing?.startedAt ?? now
                  }
                };
              }

              const startedAt = existing?.startedAt ?? now;
              const completedAt = existing?.completedAt ?? now;
              if (existing && existing.startedAt === startedAt && existing.completedAt === completedAt) {
                return current;
              }

              return {
                ...current,
                [itemId]: {
                  startedAt,
                  completedAt
                }
              };
            });

            setMessages((current) => {
              const existingIndex = current.findIndex((message) => message.id === itemId);
              const nextMessage: ChatMessage = {
                id: itemId,
                turnId,
                role: "system",
                type: itemType,
                content: described.summary,
                details: described.details,
                status: nextStatus
              };

              if (existingIndex === -1) {
                return [...current, nextMessage];
              }

              const next = [...current];
              next[existingIndex] = {
                ...next[existingIndex],
                ...nextMessage
              };
              return next;
            });
          }
        }
      } catch {
        setError("received invalid websocket payload");
      }
    });

    return () => {
      disposed = true;
      clearPendingSendAck();
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      ws.close();
      websocketRef.current = null;
    };
  }, [apiBase, selectedSessionId, wsReconnectNonce]);

  const handleTranscriptScroll = (): void => {
    const element = transcriptRef.current;
    if (!element) {
      return;
    }

    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    const atBottom = distanceFromBottom < 64;
    setFollowTranscriptTail(atBottom);
    setShowJumpToBottom(!atBottom);
  };

  const jumpToBottom = (): void => {
    const element = transcriptRef.current;
    if (!element) {
      return;
    }

    element.scrollTo({
      top: element.scrollHeight,
      behavior: "smooth"
    });
    setFollowTranscriptTail(true);
    setShowJumpToBottom(false);
  };

  useEffect(() => {
    if (!followTranscriptTail) {
      return;
    }

    const element = transcriptRef.current;
    if (!element) {
      return;
    }

    element.scrollTo({
      top: element.scrollHeight
    });
  }, [visibleTurnGroups, followTranscriptTail, loadingTranscript, selectedSessionId]);

  const renderTurnGroup = (group: TurnMessageGroup) => {
    const userMessages = group.messages.filter((message) => message.role === "user");
    const { responseMessages, thoughtMessages, finalAssistantMessage, thinkingActive } = inspectTurnGroupState(group);

    const resolveMessageTiming = (message: ChatMessage): MessageTiming | null => {
      return messageTimingById[message.id] ?? parseMessageTimingFromDetails(message.details);
    };

    const thoughtHeader = (() => {
      if (thinkingActive) {
        for (let index = thoughtMessages.length - 1; index >= 0; index -= 1) {
          const message = thoughtMessages[index];
          if (message.type === "agentMessage") {
            const trimmed = message.content.trim();
            if (trimmed.length > 0) {
              return {
                text: trimmed,
                tone: "agent" as const
              };
            }
            continue;
          }

          if (message.type === "reasoning") {
            const { summaryLines, contentLines } = parseReasoningLines(message.details, message.content);
            const previewLines = [...summaryLines, ...contentLines].map((line) => line.trim()).filter((line) => line.length > 0);
            if (previewLines.length > 0) {
              return {
                text: previewLines.join(" "),
                tone: "reasoning" as const
              };
            }
          }
        }

        return {
          text: "Working...",
          tone: "meta" as const
        };
      }

      const userStartCandidates = userMessages
        .map((message) => {
          const timing = resolveMessageTiming(message);
          return timing?.startedAt ?? timing?.completedAt ?? null;
        })
        .filter((value): value is number => typeof value === "number");

      const allStartCandidates =
        userStartCandidates.length > 0
          ? userStartCandidates
          : group.messages
              .map((message) => {
                const timing = resolveMessageTiming(message);
                return timing?.startedAt ?? timing?.completedAt ?? null;
              })
              .filter((value): value is number => typeof value === "number");

      const startAt = allStartCandidates.length > 0 ? Math.min(...allStartCandidates) : null;

      const finalTiming = finalAssistantMessage ? resolveMessageTiming(finalAssistantMessage) : null;
      const endCandidates: Array<number> = [];
      if (finalTiming?.completedAt) {
        endCandidates.push(finalTiming.completedAt);
      } else if (finalTiming?.startedAt && finalAssistantMessage?.status !== "streaming") {
        endCandidates.push(finalTiming.startedAt);
      }

      if (endCandidates.length === 0) {
        for (const message of thoughtMessages) {
          const timing = resolveMessageTiming(message);
          if (timing?.completedAt) {
            endCandidates.push(timing.completedAt);
          }
        }
      }

      const endAt = endCandidates.length > 0 ? Math.max(...endCandidates) : null;
      if (startAt !== null && endAt !== null && endAt >= startAt) {
        return {
          text: `Worked for ${formatElapsedLabel(endAt - startAt)}`,
          tone: "meta" as const
        };
      }

      return {
        text: "Worked for <1s",
        tone: "meta" as const
      };
    })();

    const thoughtRows: Array<ReactNode> = [];
    const pendingThoughtRows: Array<ReactNode> = [];
    const queuedApprovalRows: Array<{ row: ReactNode; requestedAt: number; sequence: number }> = [];
    const queuedPendingApprovalRows: Array<{ row: ReactNode; requestedAt: number; sequence: number }> = [];
    let approvalSequence = 0;
    const finalAssistantText = finalAssistantMessage?.content.trim() ?? "";
    const finalAssistantHasContent = finalAssistantText.length > 0;
    const finalAssistantSettled = Boolean(finalAssistantMessage && finalAssistantMessage.status !== "streaming");
    const approvalRequestedAt = (approval?: PendingApproval): number => {
      if (!approval) {
        return Number.MAX_SAFE_INTEGER;
      }

      const parsed = Date.parse(approval.createdAt);
      return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
    };
    const reasoningLinesByMessageId = new Map<string, { summaryLines: Array<string>; contentLines: Array<string> }>();
    const fileChangeMessagesById = new Map<string, ChatMessage>();
    for (const thoughtMessage of thoughtMessages) {
      if (thoughtMessage.type === "reasoning") {
        reasoningLinesByMessageId.set(
          thoughtMessage.id,
          parseReasoningLines(thoughtMessage.details, thoughtMessage.content)
        );
      }
      if (thoughtMessage.type === "fileChange") {
        fileChangeMessagesById.set(thoughtMessage.id, thoughtMessage);
      }
    }
    const hasMeaningfulFutureEvent = new Array<boolean>(thoughtMessages.length).fill(false);
    let seenMeaningfulEvent = false;
    for (let index = thoughtMessages.length - 1; index >= 0; index -= 1) {
      hasMeaningfulFutureEvent[index] = seenMeaningfulEvent;
      const message = thoughtMessages[index];
      const isReasoning = message.type === "reasoning";
      const reasoningLines = isReasoning ? reasoningLinesByMessageId.get(message.id) : undefined;
      const reasoningLineCount = reasoningLines ? reasoningLines.summaryLines.length + reasoningLines.contentLines.length : 0;
      const isMeaningfulEvent = !isReasoning || reasoningLineCount > 0;
      if (isMeaningfulEvent) {
        seenMeaningfulEvent = true;
      }
    }
    for (const [messageIndex, message] of thoughtMessages.entries()) {
      if (message.type === "reasoning") {
        const { summaryLines, contentLines } =
          reasoningLinesByMessageId.get(message.id) ?? parseReasoningLines(message.details, message.content);
        const mergedLines = [...summaryLines, ...contentLines];

        if (mergedLines.length === 0) {
          const reasoningTiming = resolveMessageTiming(message);
          const hasReasoningCompletedTimestamp = Boolean(reasoningTiming?.completedAt);
          const hasLaterMeaningfulEvent = hasMeaningfulFutureEvent[messageIndex] === true;
          const shouldHideEmptyReasoning =
            !thinkingActive ||
            message.status !== "streaming" ||
            hasReasoningCompletedTimestamp ||
            hasLaterMeaningfulEvent ||
            finalAssistantSettled ||
            finalAssistantHasContent;
          if (shouldHideEmptyReasoning) {
            continue;
          }

          thoughtRows.push(
            <div key={`reasoning-empty-${message.id}`} className="thought-row-line summary" data-thought-collapse="true">
              <span>thinking</span>
              <span className="thinking-ellipsis" aria-label="thinking">
                ...
              </span>
            </div>
          );
          continue;
        }

        for (const [index, line] of summaryLines.entries()) {
          thoughtRows.push(
            <div key={`reasoning-summary-${message.id}-${index}`} className="thought-row-line summary" data-thought-collapse="true">
              {line}
            </div>
          );
        }

        for (const [index, line] of contentLines.entries()) {
          thoughtRows.push(
            <div key={`reasoning-content-${message.id}-${index}`} className="thought-row-line content" data-thought-collapse="true">
              {line}
            </div>
          );
        }
        continue;
      }

      const maybeApprovalId = approvalIdFromMessage(message);
      const pendingApproval = maybeApprovalId ? pendingApprovalsById.get(maybeApprovalId) : undefined;
      const maybeToolInputId = toolInputRequestIdFromMessage(message);
      const pendingToolInput = maybeToolInputId ? pendingToolInputsById.get(maybeToolInputId) : undefined;

      if (message.type === "commandExecution") {
        const { command, aggregatedOutput, exitCode, cwd } = summarizeCommandExecutionMessage(message);
        const terminalLine = formatTerminalCommandLine({
          command,
          cwd,
          projectRoot: selectedSession?.cwd ?? null
        });
        const eventRow = (
          <div key={`event-${message.id}`} className="thought-row-event inline" data-thought-no-collapse="true">
            <div className="thought-command-output">
              <p className="thought-command-line">
                <span className="thought-command-prompt">{terminalLine.promptPath}$</span>{" "}
                <span className="thought-command-text">{terminalLine.commandText}</span>
              </p>
              {aggregatedOutput ? <pre className="thought-command-result">{aggregatedOutput}</pre> : null}
            </div>
            {exitCode !== null && exitCode !== 0 ? <p className="thought-row-meta error">Exit code {exitCode}</p> : null}
          </div>
        );
        thoughtRows.push(eventRow);
        continue;
      }

      if (message.type === "fileChange") {
        const pendingFileChangeApproval = pendingFileChangeApprovalsByItemId.get(message.id);
        if (pendingFileChangeApproval) {
          // Approval row is the source of truth while file changes are pending.
          continue;
        }

        const { status, changeCount, files, diffs } = summarizeFileChangeMessage(message);
        const fileChangeLabel = formatFileChangeLabel(changeCount);
        const actionText =
          status === "streaming"
            ? `Applying: ${fileChangeLabel}`
            : status === "completed"
              ? null
            : status === "failed"
                ? `Failed to apply: ${fileChangeLabel}`
                : null;
        const fileListPreview =
          diffs.length === 0 && files.length > 0
            ? `${files
                .slice(0, 3)
                .map((path) => toProjectRelativePath(path, selectedSession?.cwd ?? null))
                .join(", ")}${files.length > 3 ? ` (+${files.length - 3} more)` : ""}`
            : null;

        const eventRow = (
          <div key={`event-${message.id}`} className="thought-row-event inline" data-thought-no-collapse="true">
            {actionText ? <p className="thought-row-text">{actionText}</p> : null}
            {fileListPreview ? <p className="thought-row-meta">{fileListPreview}</p> : null}
            {diffs.map((diffEntry, diffIndex) => (
              <div key={`diff-${message.id}-${diffIndex}`} className="thought-diff-section">
                <pre className="thought-diff-block">
                  {diffEntry.path ? (
                    <span className="thought-diff-line hunk">{toProjectRelativePath(diffEntry.path, selectedSession?.cwd ?? null)}</span>
                  ) : null}
                  {diffEntry.lines.map((line, lineIndex) => (
                    <span key={`diff-line-${message.id}-${diffIndex}-${lineIndex}`} className={`thought-diff-line ${classifyDiffLineTone(line)}`}>
                      {line.length > 0 ? replaceDisplayHomePath(line, selectedSession?.cwd ?? null) : " "}
                    </span>
                  ))}
                </pre>
              </div>
            ))}
          </div>
        );
        thoughtRows.push(eventRow);
        continue;
      }

      if (message.type.startsWith("approval.")) {
        if (!pendingApproval) {
          // Keep approval rows visible only while action is still pending.
          continue;
        }

        const method = extractApprovalMethod(message, pendingApproval);
        const command = extractApprovalCommand(message, pendingApproval) ?? "(unknown command)";
        const fileChangeCount = extractApprovalFileChangeCount(message, pendingApproval);
        const fileChangeLabel = formatFileChangeLabel(fileChangeCount);
        const decision = extractApprovalDecision(message);
        const resolutionStatus = extractApprovalStatus(message);
        const lowerContent = message.content.toLowerCase();
        const isCommandApproval =
          method === "item/commandExecution/requestApproval" ||
          method === "commandExecution/requestApproval" ||
          lowerContent.includes("command approval required") ||
          lowerContent.includes("approval required to run:");
        const isFileChangeApproval =
          method === "item/fileChange/requestApproval" ||
          lowerContent.includes("file change approval required") ||
          lowerContent.includes("approval required to apply:");
        const pendingFileChangePreview = pendingApproval && isFileChangeApproval ? summarizePendingFileChangeApproval(pendingApproval) : null;
        const linkedFileChangeMessage =
          pendingApproval && isFileChangeApproval && pendingApproval.itemId ? fileChangeMessagesById.get(pendingApproval.itemId) ?? null : null;
        const linkedFileChangePreview = linkedFileChangeMessage ? summarizeFileChangeMessage(linkedFileChangeMessage) : null;
        const effectiveFileChangePreview = (() => {
          if (!isFileChangeApproval) {
            return null;
          }

          const pendingHasRenderablePreview =
            pendingFileChangePreview !== null && (pendingFileChangePreview.diffs.length > 0 || pendingFileChangePreview.files.length > 0);
          if (pendingHasRenderablePreview) {
            return pendingFileChangePreview;
          }

          if (linkedFileChangePreview) {
            return {
              files: linkedFileChangePreview.files,
              diffs: linkedFileChangePreview.diffs,
              entries: linkedFileChangePreview.entries,
              changeCount: linkedFileChangePreview.changeCount
            };
          }

          return pendingFileChangePreview;
        })();

        if (isCommandApproval || isFileChangeApproval) {
          const acceptedUpdate =
            !pendingApproval &&
            (decision === "accept" ||
              lowerContent.includes("approved for") ||
              lowerContent.includes("approved to run") ||
              lowerContent.includes("approved file changes") ||
              lowerContent.includes("approved to apply"));

          // Keep approval timeline lean: once accepted, downstream execution/file-change rows own visible outcome.
          if (acceptedUpdate) {
            continue;
          }

          const approvalText = (() => {
            if (isCommandApproval) {
              return pendingApproval
                ? `Approval required to run: ${command}`
                : commandApprovalResolutionSummary(
                    {
                      status: resolutionStatus ?? undefined,
                      decision: decision ?? undefined
                    },
                    command
                  );
            }

            return pendingApproval
              ? effectiveFileChangePreview
                ? summarizePendingFileChangeApprovalText({
                    ...effectiveFileChangePreview,
                    projectRoot: selectedSession?.cwd ?? null
                  })
                : `Approval required to apply: ${fileChangeLabel}`
              : fileChangeApprovalResolutionSummary(
                  {
                    status: resolutionStatus ?? undefined,
                    decision: decision ?? undefined
                  },
                  fileChangeLabel
                );
          })();

          const eventRow = (
            <div key={`event-${message.id}`} className="thought-row-event" data-thought-no-collapse="true">
              <p className="thought-row-text">{approvalText}</p>
              {pendingApproval ? <p className="approval-time">Requested: {formatApprovalDate(pendingApproval.createdAt)}</p> : null}
              {pendingApproval && isFileChangeApproval && effectiveFileChangePreview ? (
                effectiveFileChangePreview.diffs.length > 0 ? (
                  effectiveFileChangePreview.diffs.map((diffEntry, diffIndex) => (
                    <div key={`approval-diff-${message.id}-${diffIndex}`} className="thought-diff-section">
                      <pre className="thought-diff-block">
                        {diffEntry.path && !shouldHidePathHeaderForCreatePreview(effectiveFileChangePreview) ? (
                          <span className="thought-diff-line hunk">{toProjectRelativePath(diffEntry.path, selectedSession?.cwd ?? null)}</span>
                        ) : null}
                        {diffEntry.lines.map((line, lineIndex) => (
                          <span
                            key={`approval-diff-line-${message.id}-${diffIndex}-${lineIndex}`}
                            className={`thought-diff-line ${classifyDiffLineTone(line)}`}
                          >
                            {line.length > 0 ? replaceDisplayHomePath(line, selectedSession?.cwd ?? null) : " "}
                          </span>
                        ))}
                      </pre>
                    </div>
                  ))
                ) : effectiveFileChangePreview.files.length > 0 ? (
                  <p className="thought-row-meta">
                    {effectiveFileChangePreview.files
                      .slice(0, 3)
                      .map((path) => toProjectRelativePath(path, selectedSession?.cwd ?? null))
                      .join(", ")}
                    {effectiveFileChangePreview.files.length > 3 ? ` (+${effectiveFileChangePreview.files.length - 3} more)` : ""}
                  </p>
                ) : null
              ) : null}
              {pendingApproval ? (
                <div className="approval-actions">
                  <button type="button" onClick={() => void submitApprovalDecision(pendingApproval.approvalId, "accept", "turn")}>
                    Approve
                  </button>
                  <button type="button" onClick={() => void submitApprovalDecision(pendingApproval.approvalId, "accept", "session")}>
                    Approve for Session
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => void submitApprovalDecision(pendingApproval.approvalId, "decline", "turn")}
                  >
                    Deny
                  </button>
                </div>
              ) : null}
            </div>
          );
          const queuedApprovalRow = {
            row: eventRow,
            requestedAt: approvalRequestedAt(pendingApproval),
            sequence: approvalSequence
          };
          approvalSequence += 1;
          queuedApprovalRows.push(queuedApprovalRow);
          if (pendingApproval) {
            queuedPendingApprovalRows.push(queuedApprovalRow);
          }
          continue;
        }
      }

      const title = message.type.startsWith("tool_input.")
        ? message.type === "tool_input.request"
          ? "Input Required"
          : "Input Update"
        : message.type.startsWith("approval.")
          ? message.type === "approval.request"
            ? "Approval Required"
            : "Approval Update"
          : message.type;
      const showEventTitle = message.type !== "agentMessage";
      const showDetails = Boolean(message.details) && !message.type.startsWith("approval.");

      const eventRow = (
        <div key={`event-${message.id}`} className="thought-row-event" data-thought-no-collapse="true">
          {showEventTitle ? <p className="thought-row-title">{title}</p> : null}
          <p className="thought-row-text">{message.content}</p>
          {pendingApproval ? <p className="approval-time">Requested: {formatApprovalDate(pendingApproval.createdAt)}</p> : null}
          {pendingToolInput ? <p className="approval-time">Requested: {formatApprovalDate(pendingToolInput.createdAt)}</p> : null}
          {showDetails ? (
            <details className="bubble-details">
              <summary>Details</summary>
              <pre>{message.details}</pre>
            </details>
          ) : null}
          {pendingApproval ? (
            <div className="approval-actions">
              <button type="button" onClick={() => void submitApprovalDecision(pendingApproval.approvalId, "accept", "turn")}>
                Approve
              </button>
              <button type="button" onClick={() => void submitApprovalDecision(pendingApproval.approvalId, "accept", "session")}>
                Approve for Session
              </button>
              <button type="button" className="danger" onClick={() => void submitApprovalDecision(pendingApproval.approvalId, "decline", "turn")}>
                Deny
              </button>
            </div>
          ) : null}
          {pendingToolInput ? (
            <div className="tool-input-form">
              {pendingToolInput.questions.map((question) => (
                <label key={question.id}>
                  <span>{question.header}</span>
                  <small>{question.question}</small>
                  <input
                    type={question.isSecret ? "password" : "text"}
                    value={toolInputDraftById[pendingToolInput.requestId]?.[question.id] ?? ""}
                    onChange={(event) =>
                      setToolInputDraftById((current) => ({
                        ...current,
                        [pendingToolInput.requestId]: {
                          ...(current[pendingToolInput.requestId] ?? {}),
                          [question.id]: event.target.value
                        }
                      }))
                    }
                    placeholder={question.options?.[0]?.label ?? "Answer"}
                  />
                </label>
              ))}
              <div className="approval-actions">
                <button
                  type="button"
                  onClick={() => void submitToolInputDecision(pendingToolInput, "accept")}
                  disabled={toolInputActionRequestId === pendingToolInput.requestId}
                >
                  {toolInputActionRequestId === pendingToolInput.requestId ? "Submitting..." : "Submit"}
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void submitToolInputDecision(pendingToolInput, "cancel")}
                  disabled={toolInputActionRequestId === pendingToolInput.requestId}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => void submitToolInputDecision(pendingToolInput, "decline")}
                  disabled={toolInputActionRequestId === pendingToolInput.requestId}
                >
                  Decline
                </button>
              </div>
            </div>
          ) : null}
        </div>
      );
      if (message.type.startsWith("approval.")) {
        const queuedApprovalRow = {
          row: eventRow,
          requestedAt: approvalRequestedAt(pendingApproval),
          sequence: approvalSequence
        };
        approvalSequence += 1;
        queuedApprovalRows.push(queuedApprovalRow);
        if (pendingApproval) {
          queuedPendingApprovalRows.push(queuedApprovalRow);
        }
      } else {
        thoughtRows.push(eventRow);
        if (pendingApproval || pendingToolInput) {
          pendingThoughtRows.push(eventRow);
        }
      }
    }

    const sortedApprovalRows = queuedApprovalRows
      .sort((left, right) => left.requestedAt - right.requestedAt || left.sequence - right.sequence)
      .map((entry) => entry.row);
    thoughtRows.push(...sortedApprovalRows);

    const sortedPendingApprovalRows = queuedPendingApprovalRows
      .sort((left, right) => left.requestedAt - right.requestedAt || left.sequence - right.sequence)
      .map((entry) => entry.row);
    pendingThoughtRows.push(...sortedPendingApprovalRows);

    const panelState = thoughtPanelStateByTurnId[group.turnId];
    const thoughtMode = panelState?.mode ?? (pendingThoughtRows.length > 0 && !thinkingActive ? "pending-only" : "full");
    const thoughtsOpen = panelState?.open ?? (thinkingActive || pendingThoughtRows.length > 0);
    const showingPendingOnly = thoughtMode === "pending-only" && pendingThoughtRows.length > 0;
    const displayedThoughtRows = showingPendingOnly ? pendingThoughtRows : thoughtRows;
    const canShowPriorActivity = showingPendingOnly && thoughtRows.length > pendingThoughtRows.length;
    const collapseThoughtPanel = (): void => {
      setThoughtPanelStateByTurnId((current) => ({
        ...current,
        [group.turnId]: {
          open: false,
          mode: current[group.turnId]?.mode ?? "full",
          lastPendingSignature: current[group.turnId]?.lastPendingSignature ?? ""
        }
      }));
    };
    const handleThoughtDetailsClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (target.closest("button, input, textarea, select, a, summary, details, [role='button']")) {
        return;
      }

      if (target.closest("[data-thought-no-collapse='true']")) {
        return;
      }

      if (target === event.currentTarget || target.closest("[data-thought-collapse='true']")) {
        collapseThoughtPanel();
      }
    };

    return (
      <section key={`turn-${group.turnId}`} className="turn-group">
        {userMessages.map((message) => (
          <article key={message.id} className={`bubble ${message.role}`}>
            <pre>{message.content || "(empty)"}</pre>
          </article>
        ))}
        {responseMessages.length > 0 ? (
          <article className={`response-card${thinkingActive ? " streaming" : ""}`}>
            {thoughtMessages.length > 0 ? (
              <div className={`response-thoughts${thoughtsOpen ? " open" : ""}`}>
                {!thoughtsOpen ? (
                  <button
                    type="button"
                    className={`response-thought-summary ${thoughtHeader.tone}`}
                    onClick={() => {
                      setThoughtPanelStateByTurnId((current) => ({
                        ...current,
                        [group.turnId]: {
                          open: true,
                          mode: "full",
                          lastPendingSignature: current[group.turnId]?.lastPendingSignature ?? ""
                        }
                      }));
                    }}
                  >
                    {thoughtHeader.text}
                  </button>
                ) : null}
                {thoughtsOpen ? (
                  <div className="response-thought-details" onClick={handleThoughtDetailsClick}>
                    {showingPendingOnly ? (
                      <p className={`response-thought-preview ${thoughtHeader.tone}`} data-thought-collapse="true">
                        {thoughtHeader.text}
                      </p>
                    ) : null}
                    {canShowPriorActivity ? (
                      <button
                        type="button"
                        className="thought-preview-expand"
                        onClick={() =>
                          setThoughtPanelStateByTurnId((current) => ({
                            ...current,
                            [group.turnId]: {
                              open: true,
                              mode: "full",
                              lastPendingSignature: current[group.turnId]?.lastPendingSignature ?? ""
                            }
                          }))
                        }
                      >
                        Show prior activity
                      </button>
                    ) : null}
                    {displayedThoughtRows}
                  </div>
                ) : null}
              </div>
            ) : null}
            {finalAssistantMessage ? (
              <div className="response-body">
                <pre>{finalAssistantMessage.content || "(empty)"}</pre>
              </div>
            ) : null}
          </article>
        ) : null}
      </section>
    );
  };

  const renderSessionRow = (session: SessionSummary) => {
    const isSelected = session.sessionId === selectedSessionId;
    const isMenuOpen = session.sessionId === sessionMenuSessionId;
    const projectName = session.projectId ? projectNameById[session.projectId] : null;

    return (
      <li
        key={session.sessionId}
        data-session-id={session.sessionId}
        className={`session-row${isSelected ? " selected" : ""}${isMenuOpen ? " menu-open" : ""}`}
      >
        {renamingSessionId === session.sessionId ? (
          <form
            className="session-rename-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitRenameSession(session.sessionId);
            }}
          >
            <input
              type="text"
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              maxLength={200}
              autoFocus
            />
            <div className="session-rename-actions">
              <button type="submit" disabled={sessionActionSessionId === session.sessionId || !renameDraft.trim()}>
                Save
              </button>
              <button
                type="button"
                className="ghost"
                onClick={cancelRenameSession}
                disabled={sessionActionSessionId === session.sessionId}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <button
              type="button"
              className={isSelected ? "session-btn selected" : "session-btn"}
              onClick={() => {
                closeSessionMenu();
                setRequireSessionReselection(false);
                setDeletedSessionNotice(null);
                setSelectedSessionId(session.sessionId);
              }}
              title={`${session.title} • Updated ${formatSessionDate(session.updatedAt)}${projectName ? ` • ${projectName}` : ""}`}
            >
              <span className="session-title">{session.title}</span>
            </button>
            <button
              type="button"
              className="session-menu-trigger"
              aria-label={`Open actions for ${session.title}`}
              aria-expanded={isMenuOpen}
              onClick={(event) => {
                event.stopPropagation();
                toggleSessionMenu(session.sessionId, event.currentTarget);
              }}
            >
              …
            </button>
          </>
        )}
      </li>
    );
  };

  const sessionMenuSession = sessionMenuSessionId
    ? sessions.find((session) => session.sessionId === sessionMenuSessionId) ?? null
    : null;
  const projectMenuProject = projectMenuProjectId
    ? visibleProjects.find((project) => project.projectId === projectMenuProjectId) ?? null
    : null;
  const projectMenuSessionCount = projectMenuProject
    ? (sessionsByProjectId.get(projectMenuProject.projectId) ?? []).length
    : 0;
  const projectMenuHasChats = projectMenuSessionCount > 0;
  const requestReconnect = (): void => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    clearPendingSendAck();
    setWsState("connecting");
    setWsReconnectNonce((value) => value + 1);
  };

  return (
    <>
      <main className="app-shell">
      <aside className="sessions-pane">
        <header className="sessions-header">
          <h1>Codex Manager</h1>
          <button type="button" onClick={() => void createSession()}>
            New Chat
          </button>
        </header>

        <div className="sessions-meta">
          <span className={`ws-state ${wsState}`}>WebSocket {wsState}</span>
          <label className="archive-toggle">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => {
                setRenamingSessionId(null);
                setRenameDraft("");
                closeSessionMenu();
                setShowArchived(event.target.checked);
              }}
            />
            Show archived
          </label>
          <button type="button" onClick={() => void loadSessions(showArchived)} disabled={loadingSessions}>
            {loadingSessions ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        <div className="session-sections">
          {showProjectsSection ? (
            <section className="session-section">
              <div className={`session-section-header has-header-menu${showProjectsHeaderMenu ? " menu-open" : ""}`}>
                <button
                  type="button"
                  className="session-section-toggle"
                  onClick={() => setShowProjects((current) => !current)}
                  aria-expanded={showProjects}
                >
                  <span aria-hidden="true">{showProjects ? "▾" : "▸"}</span>
                  <span>Projects</span>
                  <span className="session-count">{visibleProjects.length}</span>
                </button>
                <button
                  type="button"
                  className={`section-menu-trigger${showProjectsHeaderMenu ? " menu-open" : ""}`}
                  aria-label="Open actions for Projects"
                  aria-expanded={showProjectsHeaderMenu}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleProjectsHeaderMenu(event.currentTarget);
                  }}
                >
                  …
                </button>
              </div>

              {showProjects ? (
                <div className="project-list">
                  {visibleProjects.map((project) => {
                    const projectSessions = sessionsByProjectId.get(project.projectId) ?? [];
                    const projectExpanded = expandedProjectsById[project.projectId] ?? true;
                    const projectMenuOpen = projectMenuProjectId === project.projectId;

                    return (
                      <div key={project.projectId} className={`project-group${projectMenuOpen ? " menu-open" : ""}`}>
                        <div className="project-row">
                          <button
                            type="button"
                            className="project-toggle"
                            onClick={() => {
                              closeProjectMenu();
                              toggleProjectExpansion(project.projectId);
                            }}
                            aria-expanded={projectExpanded}
                          >
                            <span aria-hidden="true">{projectExpanded ? "▾" : "▸"}</span>
                            <span className="project-name">{project.name}</span>
                            <span className="session-count">{projectSessions.length}</span>
                          </button>
                          <button
                            type="button"
                            className={`project-menu-trigger${projectMenuOpen ? " menu-open" : ""}`}
                            aria-label={`Open actions for ${project.name}`}
                            aria-expanded={projectMenuOpen}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleProjectMenu(project.projectId, event.currentTarget);
                            }}
                          >
                            …
                          </button>
                        </div>

                        {projectExpanded ? (
                          <ul className="session-list project-session-list">
                            {projectSessions.map((session) => renderSessionRow(session))}
                            {projectSessions.length === 0 ? <li className="empty-state">No chats in this project.</li> : null}
                          </ul>
                        ) : null}
                      </div>
                    );
                  })}
                  {!showArchived && projects.length === 0 ? <p className="empty-state">No projects yet.</p> : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {showYourChatsSection ? (
            <section className="session-section">
              <div className="session-section-header">
                <button
                  type="button"
                  className="session-section-toggle"
                  onClick={() => setShowSessionList((current) => !current)}
                  aria-expanded={showSessionList}
                >
                  <span aria-hidden="true">{showSessionList ? "▾" : "▸"}</span>
                  <span>Your chats</span>
                  <span className="session-count">{unassignedSessions.length}</span>
                </button>
              </div>

              {showSessionList ? (
                <ul className="session-list your-chats-list">
                  {unassignedSessions.map((session) => renderSessionRow(session))}

                  {unassignedSessions.length === 0 ? (
                    <li className="empty-state">{showArchived ? "No archived unassigned chats." : "No unassigned chats."}</li>
                  ) : null}
                </ul>
              ) : null}

              {showSessionList && sessionsNextCursor ? (
                <button
                  type="button"
                  className="ghost session-load-more"
                  onClick={() =>
                    void loadSessions(showArchived, selectedSessionId, {
                      append: true,
                      cursor: sessionsNextCursor
                    })
                  }
                  disabled={loadingMoreSessions}
                >
                  {loadingMoreSessions ? "Loading..." : "Load more"}
                </button>
              ) : null}
            </section>
          ) : null}

          {!showYourChatsSection && showArchived && sessionsNextCursor ? (
            <button
              type="button"
              className="ghost session-load-more"
              onClick={() =>
                void loadSessions(showArchived, selectedSessionId, {
                  append: true,
                  cursor: sessionsNextCursor
                })
              }
              disabled={loadingMoreSessions}
            >
              {loadingMoreSessions ? "Loading..." : "Load more"}
            </button>
          ) : null}
        </div>

        <section className="mcp-panel">
          <header>
            <strong>MCP Servers</strong>
            <button type="button" className="ghost" onClick={() => void loadMcpServers()} disabled={loadingMcpServers}>
              {loadingMcpServers ? "Loading..." : "Refresh"}
            </button>
          </header>
          {mcpServers.length === 0 ? <p className="empty-state">No MCP servers reported.</p> : null}
          <ul>
            {mcpServers.map((server) => (
              <li key={server.name}>
                <span>{server.name}</span>
                <span>{server.status}</span>
                <span>{server.toolCount} tools</span>
                <span>auth: {server.authStatus}</span>
              </li>
            ))}
          </ul>
        </section>
      </aside>

      <section className="chat-pane">
        <header className="chat-header">
          <h2>{selectedSession ? selectedSession.title : selectedSessionId ? `Session ${selectedSessionId}` : "No active session"}</h2>
          <div className="chat-actions">
            <button
              ref={modelMenuTriggerRef}
              type="button"
              className="model-combo-trigger"
              onClick={(event) => toggleModelMenu(event.currentTarget)}
              disabled={loadingModels || models.length === 0}
              aria-haspopup="menu"
              aria-expanded={modelMenuOpen}
            >
              <span className="model-combo-label">Model</span>
              <span className="model-combo-value">{selectedModelMenuLabel}</span>
            </button>
            <span className="state-pill">{runtimeStateLabel}</span>
            <button
              ref={threadMenuTriggerRef}
              type="button"
              className="ghost"
              onClick={() => setThreadMenuOpen((current) => !current)}
              disabled={!selectedSessionId}
            >
              Thread Actions
            </button>
            <button type="button" className="ghost" onClick={() => setInsightDrawerOpen((current) => !current)}>
              {insightDrawerOpen ? "Hide Insights" : "Insights"}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setShowSettings(true);
                void loadSettingsData();
              }}
            >
              Settings
            </button>
            <button type="button" onClick={() => void interruptTurn()} disabled={!streaming || !selectedSessionId}>
              Cancel Turn
            </button>
          </div>
          {threadMenuOpen ? (
            <div className="thread-menu" ref={threadMenuRef}>
              <button
                type="button"
                onClick={() => void forkSession()}
                disabled={!selectedSessionId || threadActionPending !== null || capabilityFlags.threadFork === false}
              >
                {threadActionPending === "Fork" ? "Forking..." : "Fork"}
              </button>
              <button
                type="button"
                onClick={() => void startReview()}
                disabled={!selectedSessionId || threadActionPending !== null || capabilityFlags.reviewStart === false}
              >
                {threadActionPending === "Review" ? "Starting..." : "Start Review"}
              </button>
              <button
                type="button"
                onClick={() => void compactSession()}
                disabled={!selectedSessionId || threadActionPending !== null || capabilityFlags.threadCompact === false}
              >
                {threadActionPending === "Compact" ? "Running..." : "Compact Context"}
              </button>
              <button
                type="button"
                onClick={() => void rollbackSession()}
                disabled={!selectedSessionId || threadActionPending !== null || capabilityFlags.threadRollback === false}
              >
                {threadActionPending === "Rollback" ? "Rolling back..." : "Rollback"}
              </button>
              <button
                type="button"
                onClick={() => void cleanBackgroundTerminals()}
                disabled={!selectedSessionId || threadActionPending !== null || capabilityFlags.threadBackgroundTerminalClean === false}
              >
                {threadActionPending === "Clean Terminals" ? "Cleaning..." : "Clean Background Terminals"}
              </button>
            </div>
          ) : null}
        </header>

        {deletedSessionNotice ? (
          <div className="chat-blocking-overlay" role="alertdialog" aria-modal="true" aria-live="assertive">
            <div className="chat-blocking-card">
              <h3>Chat Deleted</h3>
              <p>
                <strong>{deletedSessionNotice.title ?? "This chat"}</strong> is no longer available.
              </p>
              <p>{deletedSessionNotice.message}</p>
              <div className="chat-blocking-actions">
                <button type="button" onClick={() => void createSession()}>
                  Create New Chat
                </button>
                <span className="hint">Or select another chat from the left sidebar.</span>
              </div>
            </div>
          </div>
        ) : null}
        {showDisconnectedOverlay ? (
          <div className="chat-disconnected-overlay" role="alert" aria-live="polite">
            <div className="chat-disconnected-card">
              <h3>Connection Lost</h3>
              <p>Live updates are temporarily unavailable.</p>
              <button type="button" onClick={requestReconnect}>
                Reconnect
              </button>
            </div>
          </div>
        ) : null}

        <div className={`chat-body${insightDrawerOpen ? " with-drawer" : ""}`}>
          <div className="chat-transcript" ref={transcriptRef} onScroll={handleTranscriptScroll}>
            <div className="chat-transcript-inner">
            <div className="transcript-toolbar">
              <div className="filter-group" role="tablist" aria-label="Transcript filter">
                <button
                  type="button"
                  className={transcriptFilter === "all" ? "filter-btn active" : "filter-btn"}
                  onClick={() => setTranscriptFilter("all")}
                >
                  All ({transcriptCounts.all})
                </button>
                <button
                  type="button"
                  className={transcriptFilter === "chat" ? "filter-btn active" : "filter-btn"}
                  onClick={() => setTranscriptFilter("chat")}
                >
                  Chat ({transcriptCounts.chat})
                </button>
                <button
                  type="button"
                  className={transcriptFilter === "tools" ? "filter-btn active" : "filter-btn"}
                  onClick={() => setTranscriptFilter("tools")}
                >
                  Tools ({transcriptCounts.tools})
                </button>
                <button
                  type="button"
                  className={transcriptFilter === "approvals" ? "filter-btn active" : "filter-btn"}
                  onClick={() => setTranscriptFilter("approvals")}
                >
                  Approvals ({transcriptCounts.approvals})
                </button>
              </div>
            </div>

            {loadingTranscript ? <p className="hint">Loading transcript...</p> : null}

            {!loadingTranscript && visibleTurnGroups.length === 0 ? <p className="hint">No entries for this filter yet.</p> : null}

            {visibleTurnGroups.map((group) => renderTurnGroup(group))}
            </div>

            {showJumpToBottom ? (
              <button type="button" className="jump-to-bottom" onClick={jumpToBottom}>
                Jump to bottom
              </button>
            ) : null}
          </div>

          {insightDrawerOpen ? (
            <aside className="insight-drawer">
              <header>
                <strong>Insights</strong>
                <button type="button" className="ghost" onClick={() => setInsightDrawerOpen(false)}>
                  Close
                </button>
              </header>
              <div className="insight-tabs">
                <button
                  type="button"
                  className={insightTab === "plan" ? "active" : ""}
                  onClick={() => setInsightTab("plan")}
                >
                  Plan ({planEntries.length})
                </button>
                <button
                  type="button"
                  className={insightTab === "diff" ? "active" : ""}
                  onClick={() => setInsightTab("diff")}
                >
                  Diff ({diffEntries.length})
                </button>
                <button
                  type="button"
                  className={insightTab === "usage" ? "active" : ""}
                  onClick={() => setInsightTab("usage")}
                >
                  Usage ({usageEntries.length})
                </button>
                <button
                  type="button"
                  className={insightTab === "tools" ? "active" : ""}
                  onClick={() => setInsightTab("tools")}
                >
                  Tools ({messages.filter((message) => messageCategory(message) === "tools").length})
                </button>
              </div>
              <div className="insight-body">
                {insightTab === "plan" ? (
                  planEntries.length === 0 ? (
                    <p className="hint">No plan updates yet.</p>
                  ) : (
                    planEntries.map((entry, index) => (
                      <details key={`plan-${index}`} className="insight-entry" open={index === planEntries.length - 1}>
                        <summary>Plan update {index + 1}</summary>
                        <pre>{safePrettyJson(entry) ?? "(empty)"}</pre>
                      </details>
                    ))
                  )
                ) : null}
                {insightTab === "diff" ? (
                  diffEntries.length === 0 ? (
                    <p className="hint">No diff updates yet.</p>
                  ) : (
                    diffEntries.map((entry, index) => (
                      <details key={`diff-${index}`} className="insight-entry" open={index === diffEntries.length - 1}>
                        <summary>Diff update {index + 1}</summary>
                        <pre>{safePrettyJson(entry) ?? "(empty)"}</pre>
                      </details>
                    ))
                  )
                ) : null}
                {insightTab === "usage" ? (
                  usageEntries.length === 0 ? (
                    <p className="hint">No token usage updates yet.</p>
                  ) : (
                    usageEntries.map((entry, index) => (
                      <details key={`usage-${index}`} className="insight-entry" open={index === usageEntries.length - 1}>
                        <summary>Usage update {index + 1}</summary>
                        <pre>{safePrettyJson(entry) ?? "(empty)"}</pre>
                      </details>
                    ))
                  )
                ) : null}
                {insightTab === "tools" ? (
                  messages.filter((message) => messageCategory(message) === "tools").length === 0 ? (
                    <p className="hint">No tool activity yet.</p>
                  ) : (
                    messages
                      .filter((message) => messageCategory(message) === "tools")
                      .map((message) => (
                        <details key={`tool-${message.id}`} className="insight-entry">
                          <summary>
                            {message.type} ({statusLabel(message.status)})
                          </summary>
                          <pre>{message.details ?? message.content}</pre>
                        </details>
                      ))
                  )
                ) : null}
              </div>
            </aside>
          ) : null}
        </div>

        <footer className="composer">
          <div className="composer-inner">
            <textarea
              placeholder={selectedSessionId ? "Type your message..." : "Create a session to start chatting"}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              disabled={!selectedSessionId}
              rows={4}
            />
            {streaming && selectedSessionId ? (
              <div className="steer-controls">
                <input
                  type="text"
                  value={steerDraft}
                  onChange={(event) => setSteerDraft(event.target.value)}
                  placeholder="Steer active turn..."
                  disabled={submittingSteer || !activeTurnId}
                />
                <button type="button" className="ghost" onClick={() => void submitSteer()} disabled={!steerDraft.trim() || submittingSteer || !activeTurnId}>
                  {submittingSteer ? "Steering..." : "Steer"}
                </button>
              </div>
            ) : null}
            <div className="composer-actions">
              {error && retryPrompt && selectedSessionId ? (
                <button type="button" className="ghost" onClick={() => void retryLastMessage()}>
                  Retry Last Prompt
                </button>
              ) : null}
              <button type="button" className="ghost" onClick={() => void loadSuggestedReply()} disabled={!selectedSessionId || loadingSuggestedReply}>
                {loadingSuggestedReply ? "Suggesting..." : "Suggest Reply"}
              </button>
              <button type="button" onClick={() => void sendMessage()} disabled={!selectedSessionId || !draft.trim()}>
                Send
              </button>
            </div>
            {error ? <p className="error-line">{error}</p> : null}
          </div>
        </footer>
      </section>
      </main>
      {showSettings ? (
        <div className="settings-overlay" role="dialog" aria-modal="true">
          <div className="settings-modal">
            <header>
              <h3>Settings & Integrations</h3>
              <div>
                <button type="button" className="ghost" onClick={() => void loadCapabilities(true)} disabled={loadingCapabilities}>
                  {loadingCapabilities ? "Refreshing..." : "Refresh Capabilities"}
                </button>
                <button type="button" className="ghost" onClick={() => void loadSettingsData()}>
                  Refresh Data
                </button>
                <button type="button" onClick={() => setShowSettings(false)}>
                  Close
                </button>
              </div>
            </header>

            {settingsError ? <p className="error-line">{settingsError}</p> : null}

            <section className="settings-section">
              <h4>Capabilities</h4>
              {capabilities ? (
                <>
                  <p className="hint">
                    Last updated: {capabilities.runtime.capabilitiesLastUpdatedAt ?? "unknown"}.
                  </p>
                  <pre>{safePrettyJson(capabilities.features) ?? "(empty)"}</pre>
                </>
              ) : (
                <p className="hint">Capabilities unavailable.</p>
              )}
            </section>

            <section className="settings-section">
              <h4>Account</h4>
              <div className="settings-row">
                <button type="button" onClick={() => void startAccountChatGptLogin()} disabled={settingsActionPending !== null}>
                  Start ChatGPT Login
                </button>
                <button type="button" className="ghost" onClick={() => void startAccountApiKeyLogin()} disabled={settingsActionPending !== null}>
                  Start API Key Login
                </button>
                <button type="button" className="ghost" onClick={() => void cancelAccountLogin()} disabled={settingsActionPending !== null}>
                  Cancel Login
                </button>
                <button type="button" className="ghost" onClick={() => void logoutAccount()} disabled={settingsActionPending !== null}>
                  Logout
                </button>
              </div>
              <pre>{safePrettyJson(accountStatus) ?? "(empty)"}</pre>
              <pre>{safePrettyJson(accountRateLimits) ?? "(empty)"}</pre>
            </section>

            <section className="settings-section">
              <h4>MCP</h4>
              <div className="settings-row">
                <button type="button" onClick={() => void reloadMcpConfig()} disabled={settingsActionPending !== null}>
                  Reload MCP Config
                </button>
              </div>
              {mcpServers.length === 0 ? <p className="hint">No MCP servers reported.</p> : null}
              <ul className="settings-list">
                {mcpServers.map((server) => (
                  <li key={`settings-mcp-${server.name}`}>
                    <span>
                      {server.name} ({server.status}, auth: {server.authStatus})
                    </span>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => void startMcpOauth(server.name)}
                      disabled={settingsActionPending !== null}
                    >
                      Connect
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section className="settings-section">
              <h4>Config</h4>
              <div className="settings-row">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void writeAllowlistedConfigValue("model", selectedModelId)}
                  disabled={settingsActionPending !== null}
                >
                  Set model to selected
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void writeAllowlistedConfigValue("web_search", "live")}
                  disabled={settingsActionPending !== null}
                >
                  Set web_search=live
                </button>
                <button type="button" className="ghost" onClick={() => void writeConfigBatch()} disabled={settingsActionPending !== null}>
                  Write Config Batch
                </button>
              </div>
              <pre>{safePrettyJson(configSnapshot) ?? "(empty)"}</pre>
              <pre>{safePrettyJson(configRequirements) ?? "(empty)"}</pre>
            </section>

            <section className="settings-section">
              <h4>Integrations</h4>
              <div className="settings-row">
                <button type="button" className="ghost" onClick={() => void updateSkillEnabledState(true)} disabled={settingsActionPending !== null}>
                  Enable Skill
                </button>
                <button type="button" className="ghost" onClick={() => void updateSkillEnabledState(false)} disabled={settingsActionPending !== null}>
                  Disable Skill
                </button>
                <button type="button" className="ghost" onClick={() => void writeRemoteSkillSetting()} disabled={settingsActionPending !== null}>
                  Set Remote Skill
                </button>
              </div>
              <div className="settings-grid">
                <div>
                  <h5>Apps ({appsCatalog.length})</h5>
                  <pre>{safePrettyJson(appsCatalog) ?? "(empty)"}</pre>
                </div>
                <div>
                  <h5>Skills ({skillsCatalog.length})</h5>
                  <pre>{safePrettyJson(skillsCatalog) ?? "(empty)"}</pre>
                </div>
                <div>
                  <h5>Collaboration Modes ({collaborationModes.length})</h5>
                  <pre>{safePrettyJson(collaborationModes) ?? "(empty)"}</pre>
                </div>
                <div>
                  <h5>Experimental Features ({experimentalFeatures.length})</h5>
                  <pre>{safePrettyJson(experimentalFeatures) ?? "(empty)"}</pre>
                </div>
              </div>
            </section>

            <section className="settings-section">
              <h4>Operational Actions</h4>
              <div className="settings-row">
                <button type="button" className="ghost" onClick={() => void executeOneOffCommand()} disabled={settingsActionPending !== null}>
                  Run Command
                </button>
                <button type="button" className="ghost" onClick={() => void uploadFeedback()} disabled={settingsActionPending !== null}>
                  Send Feedback
                </button>
              </div>
              {settingsActionPending ? <p className="hint">Running: {settingsActionPending}...</p> : null}
              {settingsActionResult ? <pre>{safePrettyJson(settingsActionResult) ?? "(empty)"}</pre> : null}
            </section>
          </div>
        </div>
      ) : null}
      {modelMenuOpen && modelMenuPosition
        ? createPortal(
            <div
              ref={modelMenuRef}
              className="model-context-menu"
              role="menu"
              aria-label="Select model and reasoning effort"
              style={{
                top: `${modelMenuPosition.top}px`,
                left: `${modelMenuPosition.left}px`
              }}
            >
              {models.map((model) => {
                const efforts = reasoningEffortsForModel(model);
                const modelSelected = model.id === selectedModelOption?.id;
                return (
                  <div key={model.id} className="model-submenu-group" role="none">
                    <div className={`model-submenu-trigger${modelSelected ? " selected" : ""}`} role="menuitem" aria-haspopup="menu" tabIndex={0}>
                      <span>{modelDisplayLabel(model)}</span>
                    </div>
                    <div className="model-submenu" role="menu" aria-label={`Reasoning effort for ${model.label}`}>
                      {efforts.map((effort) => (
                        <button
                          key={`${model.id}:${effort}`}
                          type="button"
                          role="menuitem"
                          className={modelSelected && selectedReasoningEffort === effort ? "selected" : ""}
                          onClick={() => applyModelReasoningSelection(model.id, effort)}
                        >
                          {reasoningEffortLabel(effort)}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>,
            document.body
          )
        : null}
      {sessionMenuSession && sessionMenuPosition
        ? createPortal(
            <div
              ref={openSessionMenuRef}
              className="session-context-menu"
              role="menu"
              aria-label={`Actions for ${sessionMenuSession.title}`}
              style={{
                top: `${sessionMenuPosition.top}px`,
                left: `${sessionMenuPosition.left}px`
              }}
            >
              {!showArchived ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => beginRenameSession(sessionMenuSession)}
                  disabled={sessionActionSessionId === sessionMenuSession.sessionId}
                >
                  Rename
                </button>
              ) : null}
              <div className="session-submenu-group" role="none">
                <div className="session-submenu-trigger" role="menuitem" aria-haspopup="menu" tabIndex={0}>
                  <span>Move</span>
                </div>
                <div className="session-submenu" role="menu" aria-label={`Move ${sessionMenuSession.title} to project`}>
                  <div className="session-submenu-group" role="none">
                    <div className="session-submenu-trigger" role="menuitem" aria-haspopup="menu" tabIndex={0}>
                      <span>Projects</span>
                    </div>
                    <div className="session-submenu" role="menu" aria-label={`Projects for ${sessionMenuSession.title}`}>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => void createProjectFromPrompt(sessionMenuSession.sessionId)}
                        disabled={sessionActionSessionId === sessionMenuSession.sessionId}
                      >
                        New Project
                      </button>
                      <div className="session-submenu-label" role="presentation">
                        Projects
                      </div>
                      <div className="session-submenu-project-list" role="none">
                        {projects.length === 0 ? (
                          <p className="session-submenu-empty">No projects yet.</p>
                        ) : (
                          projects.map((project) => (
                            <button
                              key={project.projectId}
                              type="button"
                              role="menuitem"
                              onClick={() => void assignSessionToProject(sessionMenuSession.sessionId, project.projectId)}
                              disabled={
                                sessionActionSessionId === sessionMenuSession.sessionId || sessionMenuSession.projectId === project.projectId
                              }
                            >
                              {project.name}
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                  {sessionMenuSession.projectId ? (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => void assignSessionToProject(sessionMenuSession.sessionId, null)}
                        disabled={sessionActionSessionId === sessionMenuSession.sessionId}
                      >
                        Your Chats
                      </button>
                      {!showArchived ? (
                        <button
                          type="button"
                          role="menuitem"
                          className="danger"
                          onClick={() => void toggleArchiveStatus(sessionMenuSession.sessionId, false)}
                          disabled={sessionActionSessionId === sessionMenuSession.sessionId || !sessionMenuSession.materialized}
                          title={!sessionMenuSession.materialized ? "Available after first message" : undefined}
                        >
                          Archive
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
              {showArchived || !sessionMenuSession.projectId ? (
                <button
                  type="button"
                  role="menuitem"
                  className={showArchived ? "" : "danger"}
                  onClick={() => void toggleArchiveStatus(sessionMenuSession.sessionId, showArchived)}
                  disabled={sessionActionSessionId === sessionMenuSession.sessionId || (!showArchived && !sessionMenuSession.materialized)}
                  title={!showArchived && !sessionMenuSession.materialized ? "Available after first message" : undefined}
                >
                  {sessionActionSessionId === sessionMenuSession.sessionId ? "Working..." : showArchived ? "Restore" : "Archive"}
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => void deleteSession(sessionMenuSession)}
                disabled={sessionActionSessionId === sessionMenuSession.sessionId}
              >
                {sessionActionSessionId === sessionMenuSession.sessionId ? "Deleting..." : "Delete Permanently"}
              </button>
            </div>,
            document.body
          )
        : null}
      {projectMenuProject && projectMenuPosition
        ? createPortal(
            <div
              ref={projectMenuRef}
              className="session-context-menu"
              role="menu"
              aria-label={`Actions for project ${projectMenuProject.name}`}
              style={{
                top: `${projectMenuPosition.top}px`,
                left: `${projectMenuPosition.left}px`
              }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => void createSession(projectMenuProject.projectId)}
                disabled={projectActionProjectId === projectMenuProject.projectId}
              >
                {projectActionProjectId === projectMenuProject.projectId ? "Working..." : "New Chat"}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => void updateProjectWorkingDirectory(projectMenuProject)}
                disabled={projectActionProjectId === projectMenuProject.projectId}
                title={projectMenuProject.workingDirectory ?? undefined}
              >
                {projectActionProjectId === projectMenuProject.projectId
                  ? "Working..."
                  : projectMenuProject.workingDirectory
                    ? "Edit Working Directory"
                    : "Set Working Directory"}
              </button>
              {projectMenuHasChats ? (
                <div className="session-submenu-group" role="none">
                  <div className="session-submenu-trigger" role="menuitem" aria-haspopup="menu" tabIndex={0}>
                    <span>Move chats</span>
                  </div>
                  <div className="session-submenu" role="menu" aria-label={`Move chats from ${projectMenuProject.name}`}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void moveAllProjectChats(projectMenuProject, "unassigned")}
                      disabled={projectActionProjectId === projectMenuProject.projectId}
                    >
                      Your Chats
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void moveAllProjectChats(projectMenuProject, "archive")}
                      disabled={projectActionProjectId === projectMenuProject.projectId}
                    >
                      Archive
                    </button>
                  </div>
                </div>
              ) : null}
              {projectMenuHasChats ? (
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  onClick={() => void deleteAllProjectChats(projectMenuProject)}
                  disabled={projectActionProjectId === projectMenuProject.projectId}
                >
                  {projectActionProjectId === projectMenuProject.projectId ? "Working..." : "Delete chats"}
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => void deleteProject(projectMenuProject)}
                disabled={projectActionProjectId === projectMenuProject.projectId}
              >
                {projectActionProjectId === projectMenuProject.projectId ? "Working..." : "Delete Project"}
              </button>
            </div>,
            document.body
          )
        : null}
      {showProjectsHeaderMenu && projectsHeaderMenuPosition
        ? createPortal(
            <div
              ref={projectsHeaderMenuRef}
              className="session-context-menu"
              role="menu"
              aria-label="Projects actions"
              style={{
                top: `${projectsHeaderMenuPosition.top}px`,
                left: `${projectsHeaderMenuPosition.left}px`
              }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeProjectsHeaderMenu();
                  void createProjectFromPrompt();
                }}
                disabled={loadingProjects}
              >
                {loadingProjects ? "Loading..." : "New Project"}
              </button>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
