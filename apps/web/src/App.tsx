import { useEffect, useMemo, useRef, useState } from "react";
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
  project?: ProjectSummary;
};

type ProjectDeletedPayload = {
  projectId?: string;
  sessionIds?: Array<string>;
};

type MoveProjectChatsDestination = "unassigned" | "archive";

type ModelOption = {
  id: string;
  label: string;
  provider: string;
  isDefault: boolean;
};

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

function normalizeModelOption(input: unknown): ModelOption | null {
  const value = asRecord(input);
  if (!value || typeof value.id !== "string" || value.id.length === 0) {
    return null;
  }

  const provider = typeof value.provider === "string" ? value.provider : "unknown";
  const label =
    typeof value.name === "string" && value.name.trim().length > 0
      ? value.name.trim()
      : typeof value.displayName === "string" && value.displayName.trim().length > 0
        ? value.displayName.trim()
        : value.id;

  return {
    id: value.id,
    label,
    provider,
    isDefault: value.isDefault === true
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

function shortTurnId(turnId: string): string {
  if (turnId.length <= 12) {
    return turnId;
  }

  return `${turnId.slice(0, 8)}…`;
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
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
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
  const [pendingApprovals, setPendingApprovals] = useState<Array<PendingApproval>>([]);
  const [pendingToolInputs, setPendingToolInputs] = useState<Array<PendingToolInput>>([]);
  const [toolInputDraftById, setToolInputDraftById] = useState<Record<string, Record<string, string>>>({});
  const [toolInputActionRequestId, setToolInputActionRequestId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [steerDraft, setSteerDraft] = useState("");
  const [submittingSteer, setSubmittingSteer] = useState(false);
  const [activeTurnIdBySession, setActiveTurnIdBySession] = useState<Record<string, string>>({});
  const [retryPrompt, setRetryPrompt] = useState<string | null>(null);
  const [models, setModels] = useState<Array<ModelOption>>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [sessionModelById, setSessionModelById] = useState<Record<string, string>>({});
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
  const openSessionMenuRef = useRef<HTMLDivElement | null>(null);
  const sessionMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const projectMenuRef = useRef<HTMLDivElement | null>(null);
  const projectMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const projectsHeaderMenuRef = useRef<HTMLDivElement | null>(null);
  const projectsHeaderMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const threadMenuRef = useRef<HTMLDivElement | null>(null);
  const threadMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
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
  const defaultModelId = useMemo(() => {
    const preferred = models.find((model) => model.isDefault);
    return preferred?.id ?? models[0]?.id ?? "";
  }, [models]);
  const pendingApprovalsById = useMemo(() => {
    return new Map(pendingApprovals.map((approval) => [approval.approvalId, approval]));
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

  const visibleMessages = useMemo(() => {
    if (transcriptFilter === "all") {
      return messages;
    }

    return messages.filter((message) => {
      const category = messageCategory(message);
      return category === transcriptFilter;
    });
  }, [messages, transcriptFilter]);

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
    upsertMessage({
      id: approvalMessageId(approval.approvalId),
      turnId: approval.turnId ?? "approval",
      role: "system",
      type: "approval.request",
      content: approval.summary,
      details: safePrettyJson({
        method: approval.method,
        createdAt: approval.createdAt,
        ...approval.details
      }),
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
      const mergedContent = existing.content.includes(summary)
        ? existing.content
        : existing.type === "approval.request"
          ? `${existing.content}\n${summary}`.trim()
          : `${existing.content}\n${summary}`.trim();
      next[existingIndex] = {
        ...existing,
        type: "approval.resolved",
        content: mergedContent,
        details: safePrettyJson({
          previous: existing.details ?? null,
          resolution: payload
        }),
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
          const target = preferredSessionId ?? current;
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
          return;
        }
        throw new Error(`failed to load session (${response.status})`);
      }

      const payload = (await response.json()) as SessionDetailResponse;
      setMessages(
        payload.transcript.map((entry) => ({
          id: entry.messageId,
          turnId: entry.turnId,
          role: entry.role,
          type: entry.type,
          content: entry.content,
          details: entry.details,
          status: entry.status
        }))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load transcript");
      setMessages([]);
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

          const preferred = normalized.find((model) => model.isDefault);
          return preferred?.id ?? normalized[0].id;
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

      const payload = (await response.json()) as { data?: Array<ProjectSummary> };
      const sortedProjects = Array.isArray(payload.data)
        ? [...payload.data].sort((left, right) => left.name.localeCompare(right.name))
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

    const payload = (await response.json()) as { project: ProjectSummary };
    const project = payload.project;
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

    try {
      const response = await fetch(`${apiBase}/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: selectedModelId || undefined
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
      setMessages([]);
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

  const toggleSessionMenu = (sessionId: string, trigger: HTMLButtonElement): void => {
    if (sessionMenuSessionId === sessionId) {
      closeSessionMenu();
      return;
    }

    closeProjectMenu();
    closeProjectsHeaderMenu();
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
    const anchor = toMenuAnchor(trigger);
    projectMenuTriggerRef.current = trigger;
    setProjectMenuAnchor(anchor);
    setProjectMenuPosition(resolveSessionMenuPosition(anchor));
    setProjectMenuProjectId(projectId);
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
    setStreaming(true);
    if (selectedModelId) {
      setSessionModelById((current) => ({
        ...current,
        [selectedSessionId]: selectedModelId
      }));
    }

    try {
      const response = await fetch(`${apiBase}/sessions/${encodeURIComponent(selectedSessionId)}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ text, model: selectedModelId || undefined })
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
      }
    } catch (err) {
      setStreaming(false);
      setMessages((current) => current.filter((message) => message.id !== optimisticId));
      setDraft(text);
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

  const handleModelSelection = (modelId: string): void => {
    setSelectedModelId(modelId);

    if (selectedSessionId && modelId) {
      setSessionModelById((current) => ({
        ...current,
        [selectedSessionId]: modelId
      }));
    }
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
    setThreadMenuOpen(false);
  }, [selectedSessionId, showArchived]);

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
    void loadSessions(showArchived);
  }, [showArchived]);

  useEffect(() => {
    void loadModels();
    void loadMcpServers();
    void loadProjects();
    void loadCapabilities();
  }, []);

  useEffect(() => {
    if (!selectedSessionId) {
      setMessages([]);
      setPendingApprovals([]);
      setPendingToolInputs([]);
      setFollowTranscriptTail(true);
      setShowJumpToBottom(false);
      setRetryPrompt(null);
      setSteerDraft("");
      return;
    }

    setFollowTranscriptTail(true);
    setShowJumpToBottom(false);
    setRetryPrompt(null);
    void loadSessionTranscript(selectedSessionId);
    void loadSessionApprovals(selectedSessionId);
    void loadSessionToolInputs(selectedSessionId);
  }, [selectedSessionId]);

  useEffect(() => {
    if (!showSettings) {
      return;
    }

    void loadSettingsData();
  }, [showSettings]);

  useEffect(() => {
    if (selectedSessionId) {
      const sessionModel = sessionModelById[selectedSessionId];
      if (sessionModel) {
        setSelectedModelId(sessionModel);
        return;
      }

      setSelectedModelId(defaultModelId || "");
      return;
    }

    setSelectedModelId(defaultModelId || "");
  }, [selectedSessionId, sessionModelById, defaultModelId]);

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
          if (!payload.project || typeof payload.project.projectId !== "string") {
            return;
          }

          const incoming = payload.project;
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

          setInsightDrawerOpen(true);
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

          setInsightDrawerOpen(true);
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
          setStreaming(true);
          return;
        }

        if (method === "turn/completed") {
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
          };

          const status = completedPayload.turn?.status;
          if (typeof completedPayload.threadId === "string") {
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
          const itemId = deltaPayload.itemId;

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

          if (itemType === "userMessage") {
            return;
          }

          if (itemType === "agentMessage" && method === "item/completed") {
            const text = typeof item.text === "string" ? item.text : "";
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
  }, [visibleMessages, followTranscriptTail, loadingTranscript, selectedSessionId]);

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
            <label className="model-picker">
              <span>Model</span>
              <select
                value={selectedModelId}
                onChange={(event) => handleModelSelection(event.target.value)}
                disabled={loadingModels || models.length === 0}
              >
                {models.length === 0 ? <option value="">No models</option> : null}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label} ({model.provider})
                  </option>
                ))}
              </select>
            </label>
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

            {!loadingTranscript && visibleMessages.length === 0 ? <p className="hint">No entries for this filter yet.</p> : null}

            {visibleMessages.map((message, index) => {
              const category = messageCategory(message);
              const previous = index > 0 ? visibleMessages[index - 1] : null;
              const previousCategory = previous ? messageCategory(previous) : null;
              const showGroupLabel =
                category !== "chat" && (!previous || previousCategory !== category || previous.turnId !== message.turnId);

              const maybeApprovalId =
                message.type.startsWith("approval.") && message.id.startsWith("approval-")
                  ? message.id.slice("approval-".length)
                  : null;
              const pendingApproval = maybeApprovalId ? pendingApprovalsById.get(maybeApprovalId) : undefined;
              const maybeToolInputId =
                message.type.startsWith("tool_input.") && message.id.startsWith("tool-input-")
                  ? message.id.slice("tool-input-".length)
                  : null;
              const pendingToolInput = maybeToolInputId ? pendingToolInputsById.get(maybeToolInputId) : undefined;

              if (category === "chat") {
                return (
                  <article key={message.id} className={`bubble ${message.role}`}>
                    <header>
                      <strong>{message.role}</strong>
                      <span>{message.status}</span>
                    </header>
                    <pre>{message.content || "(empty)"}</pre>
                  </article>
                );
              }

              if (category === "approvals") {
                const title = message.type.startsWith("tool_input.")
                  ? message.type === "tool_input.request"
                    ? "Input Required"
                    : "Input Update"
                  : message.type === "approval.request"
                    ? "Approval Required"
                    : "Approval Update";
                return (
                  <div key={message.id}>
                    {showGroupLabel ? (
                      <p className="event-group-label">Action required activity for turn {shortTurnId(message.turnId)}</p>
                    ) : null}
                    <article className={`event-card approval ${message.status}`}>
                      <header>
                        <strong>{title}</strong>
                        <span className="event-status-chip">{statusLabel(message.status)}</span>
                      </header>
                      <p>{message.content}</p>
                      {pendingApproval ? <p className="approval-time">Requested: {formatApprovalDate(pendingApproval.createdAt)}</p> : null}
                      {pendingToolInput ? <p className="approval-time">Requested: {formatApprovalDate(pendingToolInput.createdAt)}</p> : null}
                      {message.details ? (
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
                          <button
                            type="button"
                            className="danger"
                            onClick={() => void submitApprovalDecision(pendingApproval.approvalId, "decline", "turn")}
                          >
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
                    </article>
                  </div>
                );
              }

              return (
                <div key={message.id}>
                  {showGroupLabel ? <p className="event-group-label">Tool activity for turn {shortTurnId(message.turnId)}</p> : null}
                  <article className={`event-card tool ${message.status}`}>
                    <header>
                      <strong>{message.type}</strong>
                      <span className="event-status-chip">{statusLabel(message.status)}</span>
                    </header>
                    <p>{message.content}</p>
                    {message.details ? (
                      <details className="bubble-details">
                        <summary>Details</summary>
                        <pre>{message.details}</pre>
                      </details>
                    ) : null}
                  </article>
                </div>
              );
            })}
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
