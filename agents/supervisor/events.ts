/**
 * Supervisor agent extension: subscribe to project events and enqueue queue jobs.
 *
 * This module focuses on writing clear, human-readable job instructions that are passed
 * to the supervisor worker through orchestrator jobs.
 */

import type { AgentEvent, AgentEventRegistry, AgentEventTools } from "../runtime/events.ts";
import { valueOrPlaceholder } from "../runtime/text.ts";

export type SupervisorJobType = "file_change_supervisor_review" | "turn_supervisor_review" | "suggest_request";
export type SupervisorRiskLevel = "none" | "low" | "med" | "high";

export type SupervisorJobContext = {
  projectId: string;
  sourceSessionId: string;
  threadId: string;
  turnId: string;
  itemId?: string;
  approvalId?: string;
  anchorItemId?: string;
  userRequest?: string;
  turnTranscript?: string;
};

export type AutoActionPolicy = {
  approve?: { enabled: boolean; threshold: SupervisorRiskLevel };
  reject?: { enabled: boolean; threshold: SupervisorRiskLevel };
  steer?: { enabled: boolean; threshold: SupervisorRiskLevel };
};

export type FileChangeSupervisorReviewJob = {
  jobType: "file_change_supervisor_review";
  context: SupervisorJobContext;
  summary: string;
  details: string;
  fileChangeStatus: "pending_approval" | "completed";
  sourceEvent: "approval_request" | "approvals_reconcile" | "item_completed";
  autoActions?: AutoActionPolicy;
};

export type TurnSupervisorReviewJob = {
  jobType: "turn_supervisor_review";
  context: SupervisorJobContext;
  turnTranscriptSnapshot: string;
  insights: Array<{
    itemId: string;
    change: string;
    impact: string;
    riskLevel: SupervisorRiskLevel;
    riskReason: string;
  }>;
};

export type SuggestRequestJob = {
  jobType: "suggest_request";
  context: SupervisorJobContext;
  draft?: string;
};

export type SupervisorJob = FileChangeSupervisorReviewJob | TurnSupervisorReviewJob | SuggestRequestJob;

function explainabilityMessageId(context: SupervisorJobContext): string {
  const anchor = context.anchorItemId ?? context.itemId ?? "unknown-item";
  return `file-change-explain::${context.threadId}::${context.turnId}::${anchor}`;
}

function supervisorInsightMessageId(context: SupervisorJobContext): string {
  const anchor = context.anchorItemId ?? context.itemId ?? "unknown-item";
  return `file-change-supervisor-insight::${context.threadId}::${context.turnId}::${anchor}`;
}

function turnSupervisorReviewMessageId(context: SupervisorJobContext): string {
  return `turn-supervisor-review::${context.threadId}::${context.turnId}`;
}

type FileChangeApprovalRequestedEventPayload = {
  context: SupervisorJobContext;
  summary: string;
  details: string;
  sourceEvent: "approval_request" | "approvals_reconcile";
  fileChangeStatus: "pending_approval";
  autoActions?: AutoActionPolicy;
};

type TurnCompletedEventPayload = {
  context: SupervisorJobContext;
  hadFileChangeRequests: boolean;
  turnTranscriptSnapshot: string;
  insights?: TurnSupervisorReviewJob["insights"];
};

type SuggestRequestRequestedEventPayload = {
  requestKey: string;
  sessionId: string;
  projectId: string;
  threadId: string;
  turnId: string;
  userRequest: string;
  turnTranscript: string;
  model?: string;
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  draft?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRiskLevel(value: unknown): SupervisorRiskLevel | null {
  if (value === "none" || value === "low" || value === "med" || value === "high") {
    return value;
  }
  return null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  return null;
}

function parseAutoActionPolicy(value: unknown): AutoActionPolicy {
  const fallback = readAutoActionPolicyFromEnv();
  if (!isRecord(value)) {
    return fallback;
  }

  const parseRule = (ruleValue: unknown): { enabled: boolean; threshold: SupervisorRiskLevel } | undefined => {
    if (!isRecord(ruleValue)) {
      return undefined;
    }
    const enabled = asBoolean(ruleValue.enabled);
    const threshold = asRiskLevel(ruleValue.threshold);
    if (enabled === null || threshold === null) {
      return undefined;
    }
    return { enabled, threshold };
  };

  return {
    approve: parseRule(value.approve) ?? fallback.approve,
    reject: parseRule(value.reject) ?? fallback.reject,
    steer: parseRule(value.steer) ?? fallback.steer
  };
}

function parseEnabledFlag(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return fallback;
}

function parseThreshold(value: string | undefined, fallback: SupervisorRiskLevel): SupervisorRiskLevel {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "none" || normalized === "low" || normalized === "med" || normalized === "high") {
    return normalized;
  }
  return fallback;
}

function readAutoActionPolicyFromEnv(): AutoActionPolicy {
  // Default policy: always auto-approve, steer on medium/high risk, never auto-reject.
  const approveEnabled = parseEnabledFlag(process.env.SUPERVISOR_AUTO_APPROVE_ENABLED, true);
  const rejectEnabled = parseEnabledFlag(process.env.SUPERVISOR_AUTO_REJECT_ENABLED, false);
  const steerEnabled = parseEnabledFlag(process.env.SUPERVISOR_AUTO_STEER_ENABLED, true);
  return {
    approve: {
      enabled: approveEnabled,
      threshold: parseThreshold(process.env.SUPERVISOR_AUTO_APPROVE_THRESHOLD, "high")
    },
    reject: {
      enabled: rejectEnabled,
      threshold: parseThreshold(process.env.SUPERVISOR_AUTO_REJECT_THRESHOLD, "high")
    },
    steer: {
      enabled: steerEnabled,
      threshold: parseThreshold(process.env.SUPERVISOR_AUTO_STEER_THRESHOLD, "med")
    }
  };
}

function parseSupervisorJobContext(value: unknown): SupervisorJobContext | null {
  if (!isRecord(value)) {
    return null;
  }

  const projectId = asString(value.projectId);
  const sourceSessionId = asString(value.sourceSessionId);
  const threadId = asString(value.threadId);
  const turnId = asString(value.turnId);
  if (!projectId || !sourceSessionId || !threadId || !turnId) {
    return null;
  }

  return {
    projectId,
    sourceSessionId,
    threadId,
    turnId,
    ...(asString(value.itemId) ? { itemId: asString(value.itemId) ?? undefined } : {}),
    ...(asString(value.approvalId) ? { approvalId: asString(value.approvalId) ?? undefined } : {}),
    ...(asString(value.anchorItemId) ? { anchorItemId: asString(value.anchorItemId) ?? undefined } : {}),
    ...(asString(value.userRequest) ? { userRequest: asString(value.userRequest) ?? undefined } : {}),
    ...(asString(value.turnTranscript) ? { turnTranscript: asString(value.turnTranscript) ?? undefined } : {})
  };
}

function parseFileChangeApprovalRequestedEventPayload(value: unknown): FileChangeApprovalRequestedEventPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  const context = parseSupervisorJobContext(value.context);
  const summary = asString(value.summary);
  const details = asString(value.details);
  const sourceEvent = value.sourceEvent === "approval_request" || value.sourceEvent === "approvals_reconcile" ? value.sourceEvent : null;
  const fileChangeStatus = value.fileChangeStatus === "pending_approval" ? value.fileChangeStatus : null;
  if (!context || !summary || !details || !sourceEvent || !fileChangeStatus) {
    return null;
  }

  return {
    context,
    summary,
    details,
    sourceEvent,
    fileChangeStatus,
    autoActions: parseAutoActionPolicy(value.autoActions)
  };
}

function parseTurnCompletedEventPayload(value: unknown): TurnCompletedEventPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  const context = parseSupervisorJobContext(value.context);
  const hadFileChangeRequests = asBoolean(value.hadFileChangeRequests);
  const turnTranscriptSnapshot = asString(value.turnTranscriptSnapshot);
  if (!context || hadFileChangeRequests === null || !turnTranscriptSnapshot) {
    return null;
  }

  const insights = Array.isArray(value.insights)
    ? value.insights
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .map((entry) => ({
          itemId: asString(entry.itemId) ?? "",
          change: asString(entry.change) ?? "",
          impact: asString(entry.impact) ?? "",
          riskLevel: asRiskLevel(entry.riskLevel) ?? "none",
          riskReason: asString(entry.riskReason) ?? ""
        }))
        .filter((entry) => entry.itemId.length > 0 && entry.change.length > 0 && entry.impact.length > 0)
    : [];

  return {
    context,
    hadFileChangeRequests,
    turnTranscriptSnapshot,
    insights
  };
}

function parseSuggestRequestRequestedEventPayload(value: unknown): SuggestRequestRequestedEventPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  const requestKey = asString(value.requestKey);
  const sessionId = asString(value.sessionId);
  const projectId = asString(value.projectId);
  const threadId = asString(value.threadId);
  const turnId = asString(value.turnId);
  const userRequest = asString(value.userRequest) ?? "User request unavailable.";
  const turnTranscript = asString(value.turnTranscript) ?? "Turn transcript unavailable.";
  if (!requestKey || !sessionId || !projectId || !threadId || !turnId) {
    return null;
  }

  const model = asString(value.model) ?? undefined;
  const draft = asString(value.draft) ?? undefined;
  const effortValue = asString(value.effort);
  const effort =
    effortValue === "none" ||
    effortValue === "minimal" ||
    effortValue === "low" ||
    effortValue === "medium" ||
    effortValue === "high" ||
    effortValue === "xhigh"
      ? effortValue
      : undefined;

  return {
    requestKey,
    sessionId,
    projectId,
    threadId,
    turnId,
    userRequest,
    turnTranscript,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(draft ? { draft } : {})
  };
}

function looksStructuredJsonText(input: string): boolean {
  const trimmed = input.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.length > 20) ||
    (trimmed.startsWith("[") && trimmed.length > 20)
  );
}

function stringifyScalar(value: unknown): string {
  if (value === null || value === undefined) {
    return "not provided";
  }
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : "not provided";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "provided";
}

function formatChangeList(changes: Array<unknown>): string {
  const lines: Array<string> = [];
  let index = 0;
  for (const raw of changes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const change = raw as Record<string, unknown>;
    index += 1;
    const kind = stringifyScalar(change.kind);
    const path = stringifyScalar(change.path);
    lines.push(`- Change ${index}: ${kind} ${path}`);
    const diff = typeof change.diff === "string" ? change.diff.trim() : "";
    if (diff.length > 0) {
      const preview = diff.split("\n").slice(0, 40).join("\n");
      lines.push("  Diff preview:");
      for (const line of preview.split("\n")) {
        lines.push(`  ${line}`);
      }
    }
  }

  if (lines.length === 0) {
    return "- No structured changes were available.";
  }
  return lines.join("\n");
}

function formatRecordAsReadableLines(record: Record<string, unknown>, prefix = ""): Array<string> {
  const lines: Array<string> = [];
  for (const [key, value] of Object.entries(record)) {
    const label = `${prefix}${key}`;
    if (value === null || value === undefined) {
      lines.push(`- ${label}: not provided`);
      continue;
    }
    if (Array.isArray(value)) {
      lines.push(`- ${label}: ${value.length} item(s)`);
      continue;
    }
    if (typeof value === "object") {
      lines.push(`- ${label}:`);
      lines.push(...formatRecordAsReadableLines(value as Record<string, unknown>, `${label}.`));
      continue;
    }
    lines.push(`- ${label}: ${String(value)}`);
  }
  return lines;
}

function formatHumanDetails(details: string): string {
  const trimmed = details.trim();
  if (trimmed.length === 0) {
    return "No details were provided.";
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (Array.isArray(record.changes)) {
        return formatChangeList(record.changes);
      }
      return formatRecordAsReadableLines(record).join("\n");
    }
    if (Array.isArray(parsed)) {
      return formatChangeList(parsed);
    }
  } catch {
    // Continue with plain-text fallback below.
  }

  if (looksStructuredJsonText(trimmed)) {
    return "Structured details were provided but could not be rendered as readable text. Use the summary and context to proceed.";
  }

  return trimmed;
}

function buildAutoActionSection(policy?: AutoActionPolicy): string {
  if (!policy) {
    return [
      "## Auto Actions",
      "No auto-action policy was provided for this job.",
      "You must produce explainability and insight only.",
      "You must not perform approval or steering actions."
    ].join("\n");
  }

  return [
    "## Auto Actions",
    policy.approve?.enabled
      ? `Auto-approve is enabled at threshold "${policy.approve.threshold}".`
      : "Auto-approve is disabled. You must not approve and must not call the approval decision route with accept.",
    policy.reject?.enabled
      ? `Auto-reject is enabled at threshold "${policy.reject.threshold}".`
      : "Auto-reject is disabled. You must not reject and must not call the approval decision route with decline.",
    policy.steer?.enabled
      ? `Auto-steer is enabled at threshold "${policy.steer.threshold}".`
      : "Auto-steer is disabled. You must not send steer and must not call the turn steer route."
  ].join("\n");
}

function buildDeterministicExecutionRules(input: {
  fileChangeStatus: "pending_approval" | "completed";
  approvalId?: string;
  autoActions?: AutoActionPolicy;
}): string {
  const hasApprovalId = typeof input.approvalId === "string" && input.approvalId.trim().length > 0;
  const approvalActionEligible = input.fileChangeStatus === "pending_approval" && hasApprovalId;
  const policy = input.autoActions;

  const approveEnabled = policy?.approve?.enabled === true;
  const rejectEnabled = policy?.reject?.enabled === true;
  const steerEnabled = policy?.steer?.enabled === true;

  const approveThreshold = policy?.approve?.threshold ?? "n/a";
  const rejectThreshold = policy?.reject?.threshold ?? "n/a";
  const steerThreshold = policy?.steer?.threshold ?? "n/a";

  return [
    "## Deterministic Execution Rules",
    approvalActionEligible
      ? "Approval actions are eligible in this job because fileChangeStatus is pending_approval and approvalId is present."
      : "Approval actions are not eligible in this job. You must not call the approval decision route.",
    approveEnabled
      ? `If risk is at or below "${approveThreshold}", approve condition is satisfied.`
      : "Approve policy is disabled. Do not approve.",
    rejectEnabled
      ? `If risk is at or above "${rejectThreshold}", reject condition is satisfied.`
      : "Reject policy is disabled. Do not reject.",
    approveEnabled && rejectEnabled
      ? "If both approve and reject conditions match, reject wins."
      : "Approve/reject conflict rule is inactive because one or both policies are disabled.",
    steerEnabled
      ? `If risk is at or above "${steerThreshold}" and the turn is still active, send steer guidance.`
      : "Steer policy is disabled. Do not send steer.",
    "User decisions are authoritative. If API indicates the request was already resolved, treat it as reconciled and continue."
  ].join("\n");
}

function buildFileChangeSupervisorReviewText(job: FileChangeSupervisorReviewJob): string {
  const explainabilityId = explainabilityMessageId(job.context);
  const supervisorInsightId = supervisorInsightMessageId(job.context);

  return [
    "# Supervisor Job: file_change_supervisor_review",
    "",
    "## Requested Action",
    "You are handling one file-change approval event inside an active chat turn.",
    "Process this event in strict order: diff explainability first, supervisor insight second, then auto-action checks.",
    "",
    "## Routing Context",
    `Project: ${job.context.projectId}`,
    `Source session: ${job.context.sourceSessionId}`,
    `Thread: ${job.context.threadId}`,
    `Turn: ${job.context.turnId}`,
    `ItemId: ${valueOrPlaceholder(job.context.itemId)}`,
    `ApprovalId: ${valueOrPlaceholder(job.context.approvalId)}`,
    `AnchorItemId: ${valueOrPlaceholder(job.context.anchorItemId)}`,
    `Source event: ${job.sourceEvent}`,
    `File change status: ${job.fileChangeStatus}`,
    `Summary: ${job.summary}`,
    "",
    "## Turn Context",
    "```user-request.md",
    valueOrPlaceholder(job.context.userRequest),
    "```",
    "",
    "```transcript.md",
    valueOrPlaceholder(job.context.turnTranscript),
    "```",
    "",
    "## Diff Details",
    formatHumanDetails(job.details),
    "",
    buildAutoActionSection(job.autoActions),
    "",
    buildDeterministicExecutionRules({
      fileChangeStatus: job.fileChangeStatus,
      approvalId: job.context.approvalId,
      autoActions: job.autoActions
    }),
    "",
    "## Mandatory Execution Order",
    "You must do the following in order:",
    "1. Write/update diff explainability for this file change event.",
    "2. Write/update supervisor insight for this same event using explainability + diff context.",
    "3. Evaluate auto-approve / auto-reject / auto-steer conditions and execute only what is enabled and eligible.",
    "4. If user already resolved approval/input, reconcile and continue without retry loops.",
    "",
    "## Required API Actions",
    "Before analysis, call transcript upsert for explainability with status `streaming` and content `Analyzing proposed file change...`.",
    `Use route: POST /api/sessions/${job.context.sourceSessionId}/transcript/upsert`,
    `Use messageId: ${explainabilityId}`,
    `Use turnId: ${job.context.turnId}`,
    "Use role: system",
    "Use type: fileChange.explainability",
    "Set details text to include anchorItemId and approvalId.",
    "",
    "After diff analysis, call transcript upsert for explainability with status `complete` and your final explainability text.",
    `Use same messageId: ${explainabilityId}`,
    "",
    "Then call transcript upsert for supervisor insight with status `streaming` and content `Supervisor analyzing diff...`.",
    `Use route: POST /api/sessions/${job.context.sourceSessionId}/transcript/upsert`,
    `Use messageId: ${supervisorInsightId}`,
    `Use turnId: ${job.context.turnId}`,
    "Use role: system",
    "Use type: fileChange.supervisorInsight",
    "Set details text to include anchorItemId and approvalId.",
    "",
    "After supervisor insight is complete, upsert supervisor insight with status `complete` and your final context-aware insight.",
    `Use same messageId: ${supervisorInsightId}`,
    "",
    "If auto-approve condition matches and approval actions are eligible, call:",
    `POST /api/approvals/${valueOrPlaceholder(job.context.approvalId)}/decision with decision accept and scope turn.`,
    "If auto-reject condition matches and approval actions are eligible, call:",
    `POST /api/approvals/${valueOrPlaceholder(job.context.approvalId)}/decision with decision decline and scope turn.`,
    "When auto-steer condition matches, call:",
    `POST /api/sessions/${job.context.sourceSessionId}/turns/${job.context.turnId}/steer`,
    "Provide steer input that references the risk reason and specific corrective behavior.",
    "If an approval decision returns not found because the user already resolved it, treat that as reconciled and continue.",
    "",
    "## Output Tone",
    "Use concise, context-aware, technically precise language. Focus on what changed, why it matters, and what action is appropriate right now."
  ].join("\n");
}

function formatInsightsReadable(insights: TurnSupervisorReviewJob["insights"]): string {
  if (insights.length === 0) {
    return "- No per-file supervisor insights were provided.";
  }

  const lines: Array<string> = [];
  let index = 0;
  for (const insight of insights) {
    index += 1;
    lines.push(`- Insight ${index} for item "${insight.itemId}"`);
    lines.push(`  Change: ${insight.change}`);
    lines.push(`  Impact: ${insight.impact}`);
    lines.push(`  Risk: ${insight.riskLevel}`);
    lines.push(`  Risk reason: ${insight.riskReason}`);
  }
  return lines.join("\n");
}

function buildTurnSupervisorReviewText(job: TurnSupervisorReviewJob): string {
  const reviewMessageId = turnSupervisorReviewMessageId(job.context);

  return [
    "# Supervisor Job: turn_supervisor_review",
    "",
    "## Requested Action",
    "Review the completed turn using all known file-change context from this turn.",
    "This is a single terminal review for this turn.",
    "",
    "## Routing Context",
    `Project: ${job.context.projectId}`,
    `Source session: ${job.context.sourceSessionId}`,
    `Thread: ${job.context.threadId}`,
    `Turn: ${job.context.turnId}`,
    "",
    "## Turn Context",
    "```user-request.md",
    valueOrPlaceholder(job.context.userRequest),
    "```",
    "",
    "```transcript.md",
    valueOrPlaceholder(job.turnTranscriptSnapshot),
    "```",
    "",
    "## Per-File Insights",
    formatInsightsReadable(job.insights),
    "",
    "## Output Requirements",
    "Provide a concise final review with:",
    "- overall change summary",
    "- highest risks still open (if any)",
    "- recommended next action for user progress",
    "- suggested next-request guidance for the next user message",
    "",
    "## Required API Actions",
    "Call transcript upsert with status `streaming` before you begin synthesis.",
    `Use route: POST /api/sessions/${job.context.sourceSessionId}/transcript/upsert`,
    `Use messageId: ${reviewMessageId}`,
    `Use turnId: ${job.context.turnId}`,
    "Use role: system",
    "Use type: turn.supervisorReview",
    "Then upsert the final turn review with status `complete` and the completed review text.",
    `Use same messageId: ${reviewMessageId}`
  ].join("\n");
}

function buildSuggestRequestText(job: SuggestRequestJob): string {
  return [
    "# Supervisor Job: suggest_request",
    "",
    "## Requested Action",
    "Draft one concise next user request that the user can send to the coding agent.",
    "",
    "## Routing Context",
    `Project: ${job.context.projectId}`,
    `Source session: ${job.context.sourceSessionId}`,
    `Thread: ${job.context.threadId}`,
    `Turn: ${job.context.turnId}`,
    "",
    "## Turn Context",
    "```user-request.md",
    valueOrPlaceholder(job.context.userRequest),
    "```",
    "",
    "```transcript.md",
    valueOrPlaceholder(job.context.turnTranscript),
    "```",
    "",
    "## Existing Composer Draft",
    valueOrPlaceholder(job.draft),
    "",
    "## Output Requirements",
    "Return exactly one user message and nothing else.",
    "Write in user-to-agent request voice, not assistant response voice.",
    "Do not answer the request yourself; draft only what the user should send.",
    "Keep the request concise and action-oriented with a clear next step.",
    "If an existing draft is present, refine it while preserving its intent.",
    "Do not include markdown, labels, bullet points, JSON, code fences, or surrounding quotes."
  ].join("\n");
}

export function buildSupervisorJobText(job: SupervisorJob): string {
  if (job.jobType === "file_change_supervisor_review") {
    return buildFileChangeSupervisorReviewText(job);
  }
  if (job.jobType === "turn_supervisor_review") {
    return buildTurnSupervisorReviewText(job);
  }
  return buildSuggestRequestText(job);
}

function contextFromSuggestRequest(payload: SuggestRequestRequestedEventPayload): SupervisorJobContext {
  return {
    projectId: payload.projectId,
    sourceSessionId: payload.sessionId,
    threadId: payload.threadId,
    turnId: payload.turnId,
    userRequest: payload.userRequest,
    turnTranscript: payload.turnTranscript
  };
}

async function handleFileChangeApprovalRequested(event: AgentEvent, tools: AgentEventTools): Promise<unknown> {
  const payload = parseFileChangeApprovalRequestedEventPayload(event.payload);
  if (!payload) {
    tools.logger.warn(
      {
        eventType: event.type
      },
      "supervisor events: invalid file-change approval payload"
    );
    return;
  }

  const job: FileChangeSupervisorReviewJob = {
    jobType: "file_change_supervisor_review",
    context: payload.context,
    summary: payload.summary,
    details: payload.details,
    sourceEvent: payload.sourceEvent,
    fileChangeStatus: payload.fileChangeStatus,
    autoActions: payload.autoActions
  };

  const jobText = buildSupervisorJobText(job);
  const explainabilityId = explainabilityMessageId(job.context);
  const supervisorInsightId = supervisorInsightMessageId(job.context);
  return tools.enqueueJob({
    type: "agent_instruction",
    projectId: job.context.projectId,
    sourceSessionId: job.context.sourceSessionId,
    payload: {
      agent: "supervisor",
      jobKind: "file_change_supervisor_review",
      projectId: job.context.projectId,
      sourceSessionId: job.context.sourceSessionId,
      threadId: job.context.threadId,
      turnId: job.context.turnId,
      ...(job.context.itemId ? { itemId: job.context.itemId } : {}),
      ...(job.context.approvalId ? { approvalId: job.context.approvalId } : {}),
      ...(job.context.anchorItemId ? { anchorItemId: job.context.anchorItemId } : {}),
      instructionText: jobText,
      supplementalTargets: [
        {
          messageId: explainabilityId,
          type: "fileChange.explainability",
          placeholderTexts: ["Analyzing proposed file change...", "Explainability pending..."],
          completeFallback: "Explainability completed, but no detailed summary text was produced.",
          errorFallback: "Explainability failed before detailed output was produced.",
          canceledFallback: "Explainability was canceled before detailed output was produced."
        },
        {
          messageId: supervisorInsightId,
          type: "fileChange.supervisorInsight",
          placeholderTexts: ["Supervisor analyzing diff...", "Supervisor insight queued..."],
          completeFallback: "Supervisor insight completed, but no detailed insight text was produced.",
          errorFallback: "Supervisor insight failed before detailed output was produced.",
          canceledFallback: "Supervisor insight was canceled before detailed output was produced."
        }
      ],
      dedupeKey: `file_change_supervisor_review:${job.context.threadId}:${job.context.turnId}:${job.context.itemId ?? job.context.approvalId ?? "na"}`,
      expectResponse: "none"
    }
  });
}

async function handleTurnCompleted(event: AgentEvent, tools: AgentEventTools): Promise<void> {
  const payload = parseTurnCompletedEventPayload(event.payload);
  if (!payload) {
    tools.logger.warn(
      {
        eventType: event.type
      },
      "supervisor events: invalid turn.completed payload"
    );
    return;
  }

  if (!payload.hadFileChangeRequests) {
    return;
  }

  const job: TurnSupervisorReviewJob = {
    jobType: "turn_supervisor_review",
    context: payload.context,
    turnTranscriptSnapshot: payload.turnTranscriptSnapshot,
    insights: payload.insights ?? []
  };
  const jobText = buildSupervisorJobText(job);
  const reviewMessageId = turnSupervisorReviewMessageId(job.context);
  await tools.enqueueJob({
    type: "agent_instruction",
    projectId: job.context.projectId,
    sourceSessionId: job.context.sourceSessionId,
    payload: {
      agent: "supervisor",
      jobKind: "turn_supervisor_review",
      projectId: job.context.projectId,
      sourceSessionId: job.context.sourceSessionId,
      threadId: job.context.threadId,
      turnId: job.context.turnId,
      instructionText: jobText,
      supplementalTargets: [
        {
          messageId: reviewMessageId,
          type: "turn.supervisorReview",
          placeholderTexts: ["Supervisor reviewing completed turn..."],
          completeFallback: "Turn supervisor review completed, but no detailed review text was produced.",
          errorFallback: "Turn supervisor review failed before detailed output was produced.",
          canceledFallback: "Turn supervisor review was canceled before detailed output was produced."
        }
      ],
      dedupeKey: `turn_supervisor_review:${job.context.threadId}:${job.context.turnId}`,
      expectResponse: "none"
    }
  });
}

async function handleSuggestRequestRequested(event: AgentEvent, tools: AgentEventTools): Promise<unknown> {
  const payload = parseSuggestRequestRequestedEventPayload(event.payload);
  if (!payload) {
    tools.logger.warn(
      {
        eventType: event.type
      },
      "supervisor events: invalid suggest_request.requested payload"
    );
    return null;
  }

  const job: SuggestRequestJob = {
    jobType: "suggest_request",
    context: contextFromSuggestRequest(payload),
    draft: payload.draft
  };
  const jobText = buildSupervisorJobText(job);
  return tools.enqueueJob({
    type: "suggest_request",
    projectId: payload.projectId,
    sourceSessionId: payload.sessionId,
    payload: {
      requestKey: payload.requestKey,
      sessionId: payload.sessionId,
      projectId: payload.projectId,
      agent: "supervisor",
      sourceThreadId: payload.threadId,
      sourceTurnId: payload.turnId,
      ...(payload.model ? { model: payload.model } : {}),
      ...(payload.effort ? { effort: payload.effort } : {}),
      ...(payload.draft ? { draft: payload.draft } : {}),
      instructionText: jobText
    }
  });
}

export function registerAgentEvents(registry: AgentEventRegistry): void {
  registry.on("file_change.approval_requested", handleFileChangeApprovalRequested);
  registry.on("turn.completed", handleTurnCompleted);
  registry.on("suggest_request.requested", handleSuggestRequestRequested);
}

export default {
  registerAgentEvents
};
