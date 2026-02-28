const SUPERVISOR_BOOTSTRAP_KEY = "supervisor.queue-runner.bootstrap.v1";

const DEFAULT_FILE_CHANGE_SUPERVISOR_CONFIG = {
  diffExplainability: true,
  autoActions: {
    approve: {
      enabled: false,
      threshold: "low"
    },
    reject: {
      enabled: false,
      threshold: "high"
    },
    steer: {
      enabled: false,
      threshold: "high"
    }
  }
};

function normalizeRiskLevel(value, fallback) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (normalized === "medium") {
    return "med";
  }
  if (normalized === "low" || normalized === "med" || normalized === "high") {
    return normalized;
  }
  return fallback;
}

function resolveAutoActionConfig(input, fallback) {
  return {
    enabled: input?.enabled === true,
    threshold: normalizeRiskLevel(input?.threshold, fallback.threshold)
  };
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function resolveFileChangeSupervisorConfig(settings) {
  const root = asObject(settings);
  const supervisor = asObject(root?.supervisor);
  const fileChange = asObject(supervisor?.fileChange);
  const autoActions = asObject(fileChange?.autoActions);
  const approveSource = autoActions?.approve ?? fileChange?.autoApprove;
  const rejectSource = autoActions?.reject ?? fileChange?.autoReject;
  const steerSource = autoActions?.steer ?? fileChange?.autoSteer;

  return {
    diffExplainability:
      typeof fileChange?.diffExplainability === "boolean"
        ? fileChange.diffExplainability
        : DEFAULT_FILE_CHANGE_SUPERVISOR_CONFIG.diffExplainability,
    autoActions: {
      approve: resolveAutoActionConfig(approveSource, DEFAULT_FILE_CHANGE_SUPERVISOR_CONFIG.autoActions.approve),
      reject: resolveAutoActionConfig(rejectSource, DEFAULT_FILE_CHANGE_SUPERVISOR_CONFIG.autoActions.reject),
      steer: resolveAutoActionConfig(steerSource, DEFAULT_FILE_CHANGE_SUPERVISOR_CONFIG.autoActions.steer)
    }
  };
}

function hasEnabledAutoAction(autoActions) {
  return autoActions.approve.enabled || autoActions.reject.enabled || autoActions.steer.enabled;
}

const SUPERVISOR_BOOTSTRAP_INSTRUCTION = [
  "# Extension Bootstrap: Supervisor Queue Runner",
  "",
  "Supervisor operating contract:",
  "- process one queue job at a time",
  "- supported job kinds: `file_change_supervisor_review`, `turn_supervisor_review`, `suggest_request`, `session_initial_rename`",
  "- file-change job order (when enabled): explainability, then supervisor insight, then optional auto actions",
  "- use CLI commands for side effects",
  "",
  "Respond with exactly `READY` and no additional text."
].join("\n");

function buildFileChangeInstruction(payload, settings) {
  const context = payload.context;
  const detailsText = JSON.stringify({
    anchorItemId: context.anchorItemId ?? context.itemId ?? null,
    approvalId: context.approvalId ?? null
  });

  const supervisorConfig = resolveFileChangeSupervisorConfig(settings);
  const autoActions = supervisorConfig.autoActions;
  const hasAutoActionsEnabled = hasEnabledAutoAction(autoActions);
  if (!supervisorConfig.diffExplainability && !hasAutoActionsEnabled) {
    return null;
  }

  const explainabilityId = `file-change-explain::${context.threadId}::${context.turnId}::${context.anchorItemId ?? context.itemId ?? "unknown-item"}`;
  const supervisorInsightId = `file-change-supervisor-insight::${context.threadId}::${context.turnId}::${context.anchorItemId ?? context.itemId ?? "unknown-item"}`;
  const approvalActionsEligible = payload.fileChangeStatus === "pending_approval" && Boolean(context.approvalId);
  const executionSteps = [];
  const requiredCommands = [];
  const autoActionRules = [];
  const enabledFunctions = [];
  const supplementalTargets = [];

  if (supervisorConfig.diffExplainability) {
    enabledFunctions.push("Diff explainability + supervisor insight are enabled.");
    executionSteps.push("Write/update diff explainability for this file change event.");
    executionSteps.push("Write/update supervisor insight for this same event using explainability + diff context.");
    requiredCommands.push(
      `pnpm --filter @repo/cli dev --json sessions transcript upsert --session-id ${context.sourceSessionId} --message-id ${explainabilityId} --turn-id ${context.turnId} --entry-role system --type fileChange.explainability --status streaming --content \"Analyzing proposed file change...\" --details '${detailsText}'`
    );
    requiredCommands.push(
      `pnpm --filter @repo/cli dev --json sessions transcript upsert --session-id ${context.sourceSessionId} --message-id ${supervisorInsightId} --turn-id ${context.turnId} --entry-role system --type fileChange.supervisorInsight --status streaming --content \"Supervisor analyzing diff...\" --details '${detailsText}'`
    );
    supplementalTargets.push(
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
    );
  }

  if (autoActions.approve.enabled) {
    enabledFunctions.push(`Auto-approve is enabled at threshold "${autoActions.approve.threshold}".`);
    autoActionRules.push(`If risk is at or below "${autoActions.approve.threshold}", approve condition is satisfied.`);
    if (approvalActionsEligible) {
      requiredCommands.push(
        `pnpm --filter @repo/cli dev --json approvals decide --approval-id ${context.approvalId} --decision accept --scope turn`
      );
    }
  }
  if (autoActions.reject.enabled) {
    enabledFunctions.push(`Auto-reject is enabled at threshold "${autoActions.reject.threshold}".`);
    autoActionRules.push(`If risk is at or above "${autoActions.reject.threshold}", reject condition is satisfied.`);
    if (approvalActionsEligible) {
      requiredCommands.push(
        `pnpm --filter @repo/cli dev --json approvals decide --approval-id ${context.approvalId} --decision decline --scope turn`
      );
    }
  }
  if (autoActions.steer.enabled) {
    enabledFunctions.push(`Auto-steer is enabled at threshold "${autoActions.steer.threshold}".`);
    autoActionRules.push(`If risk is at or above "${autoActions.steer.threshold}" and the turn is still active, send CLI steer guidance.`);
    requiredCommands.push(
      `pnpm --filter @repo/cli dev --json sessions steer --session-id ${context.sourceSessionId} --turn-id ${context.turnId} --input-file \"$STEER_FILE\"`
    );
  }

  if (hasAutoActionsEnabled) {
    executionSteps.push("Evaluate and execute only eligible auto actions.");
  }

  if (autoActionRules.length === 0) {
    autoActionRules.push("All auto actions are disabled for this session.");
  } else {
    autoActionRules.unshift(
      approvalActionsEligible
        ? "Approval actions are eligible in this job because fileChangeStatus is pending_approval and approvalId is present."
        : "Approval actions are not eligible in this job. Do not run CLI approval decisions."
    );
    if (autoActions.approve.enabled && autoActions.reject.enabled) {
      autoActionRules.push("If both approve and reject conditions match, reject wins.");
    }
    autoActionRules.push("If API indicates the request was already resolved, treat it as reconciled and continue.");
  }

  if (requiredCommands.length === 0) {
    return null;
  }

  return {
    supplementalTargets,
    instructionText: [
      "# Supervisor Job: file_change_supervisor_review",
      "",
      "## Context",
      `Project: ${context.projectId}`,
      `Source session: ${context.sourceSessionId}`,
      `Thread: ${context.threadId}`,
      `Turn: ${context.turnId}`,
      `ApprovalId: ${context.approvalId ?? "[not provided]"}`,
      `File change status: ${payload.fileChangeStatus}`,
      "",
      "## Summary",
      payload.summary,
      "",
      "## Details",
      "```details.txt",
      payload.details,
      "```",
      "",
      "## Enabled Supervisor Functions",
      ...(enabledFunctions.length > 0 ? enabledFunctions : ["No file-change supervisor functions are enabled."]),
      "",
      "## Auto Action Rules",
      ...autoActionRules,
      "",
      "## Mandatory Execution Order",
      ...executionSteps.map((step, index) => `${index + 1}. ${step}`),
      "",
      "## Required CLI Commands",
      ...requiredCommands
    ].join("\n")
  };
}

function buildTurnReviewInstruction(payload) {
  const context = payload.context;
  const reviewMessageId = `turn-supervisor-review::${context.threadId}::${context.turnId}`;
  const insights = (payload.insights ?? [])
    .map((entry, index) => `- Insight ${index + 1}: item=${entry.itemId}, risk=${entry.riskLevel}, change=${entry.change}, impact=${entry.impact}`)
    .join("\n");
  const detailsText = JSON.stringify({
    anchorItemId: context.anchorItemId ?? context.itemId ?? null,
    approvalId: context.approvalId ?? null
  });

  return {
    reviewMessageId,
    instructionText: [
      "# Supervisor Job: turn_supervisor_review",
      "",
      "## Context",
      `Project: ${context.projectId}`,
      `Source session: ${context.sourceSessionId}`,
      `Thread: ${context.threadId}`,
      `Turn: ${context.turnId}`,
      "",
      "## User Request",
      "```user-request.md",
      context.userRequest ?? "[not provided]",
      "```",
      "",
      "## Transcript",
      "```transcript.md",
      payload.turnTranscriptSnapshot,
      "```",
      "",
      "## Insights",
      insights || "- No per-file supervisor insights were provided.",
      "",
      "## Required CLI Commands",
      `pnpm --filter @repo/cli dev --json sessions transcript upsert --session-id ${context.sourceSessionId} --message-id ${reviewMessageId} --turn-id ${context.turnId} --entry-role system --type turn.supervisorReview --status streaming --content \"Supervisor reviewing completed turn...\" --details '${detailsText}'`,
      `pnpm --filter @repo/cli dev --json sessions transcript upsert --session-id ${context.sourceSessionId} --message-id ${reviewMessageId} --turn-id ${context.turnId} --entry-role system --type turn.supervisorReview --status complete --content-file \"$REVIEW_FILE\" --details '${detailsText}'`
    ].join("\n")
  };
}

function buildSuggestRequestInstruction(payload) {
  const context = {
    projectId: payload.projectId,
    sourceSessionId: payload.sessionId,
    threadId: payload.threadId,
    turnId: payload.turnId,
    userRequest: payload.userRequest,
    turnTranscript: payload.turnTranscript
  };

  return {
    context,
    instructionText: [
      "# Supervisor Job: suggest_request",
      "",
      "## Context",
      `Project: ${context.projectId}`,
      `Source session: ${context.sourceSessionId}`,
      `Thread: ${context.threadId}`,
      `Turn: ${context.turnId}`,
      `Request key: ${payload.requestKey}`,
      `Requested model: ${payload.model ?? "[not provided]"}`,
      `Requested effort: ${payload.effort ?? "[not provided]"}`,
      "",
      "## User Request",
      "```user-request.md",
      context.userRequest,
      "```",
      "",
      "## Transcript",
      "```transcript.md",
      context.turnTranscript,
      "```",
      "",
      "## Existing Composer Draft",
      payload.draft ?? "[not provided]",
      "",
      "## Required CLI Commands",
      `pnpm --filter @repo/cli dev --json sessions suggest-request upsert --session-id ${context.sourceSessionId} --request-key ${payload.requestKey} --status streaming`,
      `pnpm --filter @repo/cli dev --json sessions suggest-request upsert --session-id ${context.sourceSessionId} --request-key ${payload.requestKey} --status complete --suggestion-file \"$SUGGEST_FILE\"`,
      `pnpm --filter @repo/cli dev --json sessions suggest-request upsert --session-id ${context.sourceSessionId} --request-key ${payload.requestKey} --status error --error \"suggested request generation failed\"`
    ].join("\n")
  };
}

function buildRenameInstruction(input) {
  return [
    "# Supervisor Job: session_initial_rename",
    "",
    "A user started a new turn in this chat.",
    "Only rename when the current chat title is still exactly `New chat`.",
    "",
    "## Context",
    `Source session: ${input.sourceSessionId}`,
    `Thread: ${input.threadId}`,
    `Turn: ${input.turnId}`,
    "",
    "## Initial User Request",
    "```user-request.md",
    input.userRequest,
    "```",
    "",
    "## Required CLI Commands",
    `pnpm --filter @repo/cli dev --json sessions get --session-id ${input.sourceSessionId}`,
    `pnpm --filter @repo/cli dev --json sessions rename --session-id ${input.sourceSessionId} --title \"<short title>\"`
  ].join("\n");
}

function enqueueJob(tools, input) {
  const {
    projectId,
    sourceSessionId,
    sourceThreadId = sourceSessionId,
    turnId,
    jobKind,
    dedupeKey,
    instructionText,
    extraPayload = {}
  } = input;

  return tools.enqueueJob({
    type: "agent_instruction",
    projectId,
    sourceSessionId,
    payload: {
      agent: "supervisor",
      jobKind,
      projectId,
      sourceSessionId,
      threadId: sourceThreadId,
      turnId,
      ...extraPayload,
      dedupeKey,
      expectResponse: "none",
      bootstrapInstruction: {
        key: SUPERVISOR_BOOTSTRAP_KEY,
        instructionText: SUPERVISOR_BOOTSTRAP_INSTRUCTION
      },
      instructionText
    }
  });
}

export function registerAgentEvents(registry) {
  registry.on("file_change.approval_requested", async (event, tools) => {
    const payload = event.payload;
    const context = payload.context;
    let settings = {};
    if (typeof tools.getSessionSettings === "function") {
      try {
        settings = (await tools.getSessionSettings(context.sourceSessionId)) ?? {};
      } catch (error) {
        tools.logger?.warn?.(
          {
            error,
            sourceSessionId: context.sourceSessionId
          },
          "failed to load session settings for file-change supervisor workflow"
        );
      }
    }
    const built = buildFileChangeInstruction(payload, settings);
    if (!built) {
      return;
    }

    return enqueueJob(tools, {
      projectId: context.projectId,
      sourceSessionId: context.sourceSessionId,
      sourceThreadId: context.threadId,
      turnId: context.turnId,
      jobKind: "file_change_supervisor_review",
      dedupeKey: `file_change_supervisor_review:${context.threadId}:${context.turnId}:${context.itemId ?? context.approvalId ?? "na"}`,
      instructionText: built.instructionText,
      extraPayload: {
        ...(context.itemId ? { itemId: context.itemId } : {}),
        ...(context.approvalId ? { approvalId: context.approvalId } : {}),
        ...(context.anchorItemId ? { anchorItemId: context.anchorItemId } : {}),
        ...(built.supplementalTargets.length > 0 ? { supplementalTargets: built.supplementalTargets } : {})
      }
    });
  });

  registry.on("turn.completed", async (event, tools) => {
    const payload = event.payload;
    if (payload.hadFileChangeRequests !== true) {
      return;
    }

    const context = payload.context;
    const built = buildTurnReviewInstruction(payload);

    return enqueueJob(tools, {
      projectId: context.projectId,
      sourceSessionId: context.sourceSessionId,
      sourceThreadId: context.threadId,
      turnId: context.turnId,
      jobKind: "turn_supervisor_review",
      dedupeKey: `turn_supervisor_review:${context.threadId}:${context.turnId}`,
      instructionText: built.instructionText,
      extraPayload: {
        supplementalTargets: [
          {
            messageId: built.reviewMessageId,
            type: "turn.supervisorReview",
            placeholderTexts: ["Supervisor reviewing completed turn..."],
            completeFallback: "Turn supervisor review completed, but no detailed review text was produced.",
            errorFallback: "Turn supervisor review failed before detailed output was produced.",
            canceledFallback: "Turn supervisor review was canceled before detailed output was produced."
          }
        ]
      }
    });
  });

  registry.on("suggest_request.requested", async (event, tools) => {
    const payload = event.payload;
    const built = buildSuggestRequestInstruction(payload);

    return enqueueJob(tools, {
      projectId: payload.projectId,
      sourceSessionId: payload.sessionId,
      sourceThreadId: payload.threadId,
      turnId: payload.turnId,
      jobKind: "suggest_request",
      dedupeKey: `suggest_request:${payload.sessionId}`,
      instructionText: built.instructionText,
      extraPayload: {
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.effort ? { effort: payload.effort } : {}),
        ...(payload.draft ? { fallbackSuggestionDraft: payload.draft } : {}),
        completionSignal: {
          kind: "suggested_request",
          requestKey: payload.requestKey
        }
      }
    });
  });

  registry.on("app_server.item.started", async (event, tools) => {
    const payload = event.payload;
    const item = payload.params?.item;
    if (item?.type !== "userMessage") {
      return;
    }

    const sourceSessionId = payload.params.threadId ?? payload.context.threadId;
    const turnId = payload.params.turnId ?? payload.context.turnId;
    const userRequest = (Array.isArray(item.content) ? item.content : [])
      .map((entry) => entry?.text)
      .filter((text) => typeof text === "string" && text.trim().length > 0)
      .join("\n");

    const sessionTitle = payload.session?.title;
    if (sessionTitle && sessionTitle.trim().toLowerCase() !== "new chat") {
      return;
    }

    const queueOwnerId = payload.session?.projectId ?? `session:${sourceSessionId}`;

    return enqueueJob(tools, {
      projectId: queueOwnerId,
      sourceSessionId,
      turnId,
      jobKind: "session_initial_rename",
      dedupeKey: `session_initial_rename:${sourceSessionId}`,
      instructionText: buildRenameInstruction({
        sourceSessionId,
        threadId: sourceSessionId,
        turnId,
        userRequest
      })
    });
  });
}

export default {
  registerAgentEvents
};
