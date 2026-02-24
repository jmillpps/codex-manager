import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { env } from "./env.js";
import { CodexRuntimeClient } from "./codex-runtime-client.js";
import { OrchestratorQueue, OrchestratorQueueError } from "./orchestrator-queue.js";
import { FileOrchestratorQueueStore } from "./orchestrator-store.js";
import { createJobDefinitionsRegistry } from "./orchestrator-job-definitions.js";
import { AgentEventsRuntime } from "./agent-events-runtime.js";
import { AgentExtensionAuditStore } from "./agent-extension-audit-store.js";
import {
  hashAgentActionSignature,
  isReplayCacheableActionStatus,
  normalizeAgentActionSignature,
  normalizeActionTranscriptDetails,
  shouldPreserveSuccessfulSupplementalEntry
} from "./agent-runtime-action-policy.js";
import {
  normalizeHeaderValue,
  resolveRequestRole as resolveAgentExtensionRequestRole,
  roleAllowed,
  type AgentExtensionRole
} from "./agent-extension-rbac.js";
import { evaluateActionCapability, type AgentExtensionCapabilityDeclaration } from "./agent-extension-trust.js";
import type {
  AgentEventEmitResult,
  AgentEventEnqueueResult,
  AgentRuntimeActionRequest,
  AgentRuntimeActionResult
} from "@codex-manager/agent-runtime-sdk";
import { selectEnqueueResultFromAgentEvent, summarizeActionReconciliation } from "./agent-event-selection.js";
import {
  callCodexTurnSteer,
  createCodexManagerRuntimeProfileAdapter,
  type RuntimeProfileActionResult,
  type RuntimeProfileAdapter
} from "./runtime-profile-adapter.js";
import {
  agentInstructionActionIntentBatchSchema,
  agentInstructionJobPayloadSchema,
  agentInstructionJobResultSchema,
  type AgentInstructionActionIntent,
  type AgentInstructionJobPayload,
  type AgentInstructionJobResult,
  suggestRequestJobPayloadSchema,
  suggestRequestJobResultSchema,
  type SuggestRequestJobPayload,
  type SuggestRequestJobResult
} from "./orchestrator-processors.js";
import type { EnqueueJobInput, EnqueueJobResult, JobDefinitionsMap, JobRunContext } from "./orchestrator-types.js";

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

type JsonRpcServerRequest = {
  method: string;
  id: number | string;
  params?: unknown;
};

type WebSocketLike = {
  readyState: number;
  send: (payload: string) => void;
  close: () => void;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
};

type CodexThread = {
  id: string;
  preview: string;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  source: unknown;
  turns: Array<CodexTurn>;
};

type CodexTurn = {
  id: string;
  status: string;
  items: Array<CodexThreadItem>;
  startedAt?: unknown;
  started_at?: unknown;
  startTime?: unknown;
  start_time?: unknown;
  completedAt?: unknown;
  completed_at?: unknown;
  endTime?: unknown;
  end_time?: unknown;
};

type CodexThreadItem = { type: string; id: string; [key: string]: unknown };

type SessionSummary = {
  sessionId: string;
  title: string;
  materialized: boolean;
  modelProvider: string;
  approvalPolicy: ApprovalPolicy;
  sessionControls: SessionControlsTuple;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  source: string;
  projectId: string | null;
};

type ProjectRecord = {
  name: string;
  workingDirectory: string | null;
  createdAt: string;
  updatedAt: string;
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

type SupplementalTranscriptEntry = {
  sequence: number;
  entry: TranscriptEntry;
};

type TurnTimingRecord = {
  startedAt: number;
  completedAt?: number;
};

type ApprovalMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "execCommandApproval"
  | "applyPatchApproval";

type PendingApproval = {
  approvalId: string;
  method: ApprovalMethod;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
  status: "pending";
};

type PendingApprovalRecord = PendingApproval & {
  rpcId: string | number;
};

type ToolUserInputRequestMethod = "item/tool/requestUserInput" | "tool/requestUserInput";
type ToolUserInputDecisionInput = "accept" | "decline" | "cancel";

type ToolUserInputQuestionOption = {
  label: string;
  description: string;
};

type ToolUserInputQuestion = {
  id: string;
  header: string;
  question: string;
  options: Array<ToolUserInputQuestionOption> | null;
  isOther: boolean;
  isSecret: boolean;
};

type PendingToolUserInput = {
  requestId: string;
  method: ToolUserInputRequestMethod;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  summary: string;
  questions: Array<ToolUserInputQuestion>;
  details: Record<string, unknown>;
  createdAt: string;
  status: "pending";
};

type PendingToolUserInputRecord = PendingToolUserInput & {
  rpcId: string | number;
};

type CapabilityStatus = "available" | "disabled" | "unknown";

type CapabilityEntry = {
  status: CapabilityStatus;
  reason: string | null;
};

type CapabilityMethodProbe = {
  method: string;
  probeParams?: unknown;
};

type ApprovalDecisionInput = "accept" | "decline" | "cancel";
type DefaultSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
type SessionControlApprovalPolicy = ApprovalPolicy;
type NetworkAccess = "restricted" | "enabled";
type SessionControlsTuple = {
  model: string | null;
  approvalPolicy: SessionControlApprovalPolicy;
  networkAccess: NetworkAccess;
  filesystemSandbox: DefaultSandboxMode;
};
type AgentTurnPolicy = {
  sandbox: DefaultSandboxMode;
  networkAccess: NetworkAccess;
  approvalPolicy: ApprovalPolicy;
  effort: ReasoningEffort | null;
};
type AgentRuntimePolicyConfig = {
  orientationTurnPolicy: AgentTurnPolicy;
  instructionTurnPolicy: AgentTurnPolicy;
  threadStartSandbox: DefaultSandboxMode;
  threadStartApprovalPolicy: ApprovalPolicy;
  model: string | null;
};
type RuntimeObservedTurnStatus = "running" | "completed" | "failed";
type RuntimeObservedTurnState = {
  threadId: string;
  turnId: string;
  status: RuntimeObservedTurnStatus;
  assistantText: string;
  updatedAt: number;
};
type SuggestedRequestRuntimeStateStatus = "streaming" | "complete" | "error" | "canceled";
type SuggestedRequestRuntimeState = {
  sessionId: string;
  requestKey: string;
  status: SuggestedRequestRuntimeStateStatus;
  suggestion: string | null;
  error: string | null;
  updatedAt: number;
};
type SessionControlScope = "session" | "default";
type AuthStatus = {
  hasOpenAiApiKey: boolean;
  codexHomeAuthFile: boolean;
  likelyUnauthenticated: boolean;
};

type SessionMetadataStore = {
  titles: Record<string, string>;
  projects: Record<string, ProjectRecord>;
  sessionProjectById: Record<string, string>;
  sessionApprovalPolicyById: Record<string, ApprovalPolicy>;
  sessionControlsById: Record<string, SessionControlsTuple>;
  defaultSessionControls: SessionControlsTuple;
  projectAgentSessionByKey: Record<string, string>;
  systemOwnedSessionIds: Record<string, true>;
  turnTimingBySessionId: Record<string, Record<string, TurnTimingRecord>>;
};

type SupplementalTranscriptStore = {
  version: 1;
  sequence: number;
  byThreadId: Record<string, Array<SupplementalTranscriptEntry>>;
};

type DeletedSessionPayload = {
  status: "deleted";
  sessionId: string;
  title?: string;
  message: string;
  deletedAt: string;
};

type HardDeleteSessionOutcome =
  | {
      status: "deleted";
      sessionId: string;
      title: string | null;
      deletedFileCount: number;
      payload: DeletedSessionPayload;
    }
  | {
      status: "gone";
      payload: DeletedSessionPayload;
    }
  | {
      status: "not_found";
      sessionId: string;
    };

const createSessionBodySchema = z
  .object({
    cwd: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    approvalPolicy: z.enum(["untrusted", "on-failure", "on-request", "never"]).optional(),
    networkAccess: z.enum(["restricted", "enabled"]).optional(),
    filesystemSandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional()
  })
  .optional();

const reasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);
const approvalPolicySchema = z.enum(["untrusted", "on-failure", "on-request", "never"]);
const sessionControlApprovalPolicySchema = z.enum(["untrusted", "on-failure", "on-request", "never"]);
const networkAccessSchema = z.enum(["restricted", "enabled"]);
const filesystemSandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const sessionControlsTupleSchema = z.object({
  model: z.string().trim().min(1).nullable(),
  approvalPolicy: sessionControlApprovalPolicySchema,
  networkAccess: networkAccessSchema,
  filesystemSandbox: filesystemSandboxSchema
});
const applySessionControlsBodySchema = z.object({
  scope: z.enum(["session", "default"]),
  controls: sessionControlsTupleSchema,
  actor: z.string().trim().min(1).max(120).optional(),
  source: z.string().trim().min(1).max(64).optional()
});
const agentTurnPolicyOverrideSchema = z
  .object({
    sandbox: filesystemSandboxSchema.optional(),
    networkAccess: networkAccessSchema.optional(),
    approvalPolicy: approvalPolicySchema.optional(),
    effort: reasoningEffortSchema.optional()
  })
  .strict();
const agentRuntimePolicyFileSchema = z
  .object({
    model: z.string().trim().min(1).optional(),
    turnPolicy: agentTurnPolicyOverrideSchema.optional(),
    orientationTurnPolicy: agentTurnPolicyOverrideSchema.optional(),
    instructionTurnPolicy: agentTurnPolicyOverrideSchema.optional(),
    threadStartPolicy: z
      .object({
        sandbox: filesystemSandboxSchema.optional(),
        approvalPolicy: approvalPolicySchema.optional()
      })
      .strict()
      .optional()
  })
  .strict();

const sendMessageBodySchema = z.object({
  text: z.string().trim().min(1),
  model: z.string().min(1).optional(),
  effort: reasoningEffortSchema.optional(),
  approvalPolicy: approvalPolicySchema.optional(),
  networkAccess: networkAccessSchema.optional(),
  filesystemSandbox: filesystemSandboxSchema.optional()
});

const suggestedRequestBodySchema = z
  .object({
    model: z.string().min(1).optional(),
    effort: reasoningEffortSchema.optional(),
    draft: z.string().trim().min(1).max(4000).optional()
  })
  .optional();
const suggestedRequestUpsertBodySchema = z.object({
  requestKey: z.string().min(1),
  status: z.enum(["streaming", "complete", "error", "canceled"]),
  suggestion: z.string().trim().min(1).max(8_000).optional(),
  error: z.string().trim().min(1).max(4_000).optional()
});

const sessionApprovalPolicyBodySchema = z.object({
  approvalPolicy: approvalPolicySchema
});

const listSessionsQuerySchema = z.object({
  archived: z.enum(["true", "false"]).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  includeSystemOwned: z.enum(["true", "false"]).optional()
});

const listQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
});

const orchestratorJobsQuerySchema = z.object({
  state: z.enum(["queued", "running", "completed", "failed", "canceled"]).optional()
});

const interruptBodySchema = z
  .object({
    turnId: z.string().min(1).optional()
  })
  .optional();

const renameSessionBodySchema = z.object({
  title: z.string().trim().min(1).max(200)
});

const upsertProjectBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  workingDirectory: z.string().trim().min(1).max(2000).nullable().optional()
});

const setSessionProjectBodySchema = z.object({
  projectId: z.string().trim().min(1).max(200).nullable()
});

const moveProjectChatsBodySchema = z.object({
  destination: z.enum(["unassigned", "archive"])
});

const capabilityQuerySchema = z.object({
  refresh: z.enum(["true", "false"]).optional()
});

const approvalDecisionBodySchema = z.object({
  decision: z.enum(["accept", "decline", "cancel"]),
  scope: z.enum(["turn", "session"]).optional()
});

const toolUserInputDecisionBodySchema = z.object({
  decision: z.enum(["accept", "decline", "cancel"]),
  answers: z.record(z.string(), z.object({ answers: z.array(z.string()) })).optional(),
  response: z.unknown().optional()
});

const mcpOauthLoginBodySchema = z.object({
  scopes: z.array(z.string()).optional(),
  timeoutSecs: z.coerce.number().int().positive().optional()
});

const rollbackBodySchema = z
  .object({
    numTurns: z.coerce.number().int().min(1).default(1)
  })
  .default({ numTurns: 1 });

const steerBodySchema = z.object({
  input: z.string().trim().min(1)
});

const transcriptUpsertBodySchema = z.object({
  messageId: z.string().trim().min(1),
  turnId: z.string().trim().min(1),
  role: z.enum(["user", "assistant", "system"]),
  type: z.string().trim().min(1),
  content: z.string(),
  details: z.string().optional().nullable(),
  status: z.enum(["streaming", "complete", "canceled", "error"]),
  startedAt: z.number().int().nonnegative().optional(),
  completedAt: z.number().int().nonnegative().optional()
});

const agentActionEnvelopeSchema = z.object({
  kind: z.literal("action_request"),
  actionType: z.string().trim().min(1),
  payload: z.record(z.string(), z.unknown()),
  requestId: z.string().trim().min(1).max(200).optional(),
  idempotencyKey: z.string().trim().min(1).max(300).optional()
});

const agentActionTranscriptPayloadSchema = z.object({
  sessionId: z.string().trim().min(1),
  entry: z.object({
    messageId: z.string().trim().min(1),
    turnId: z.string().trim().min(1),
    role: z.enum(["user", "assistant", "system"]),
    type: z.string().trim().min(1),
    content: z.string(),
    details: z.unknown().optional().nullable(),
    status: z.enum(["streaming", "complete", "canceled", "error"]),
    startedAt: z.number().int().nonnegative().optional(),
    completedAt: z.number().int().nonnegative().optional()
  })
});

const agentActionApprovalPayloadSchema = z.object({
  approvalId: z.string().trim().min(1),
  decision: z.enum(["accept", "decline"]),
  scope: z.enum(["turn", "session"]).optional()
});

const agentActionSteerPayloadSchema = z.object({
  sessionId: z.string().trim().min(1),
  turnId: z.string().trim().min(1),
  input: z.string().trim().min(1)
});

const agentActionQueueEnqueuePayloadSchema = z.object({
  type: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
  sourceSessionId: z.string().trim().min(1).optional().nullable(),
  payload: z.record(z.string(), z.unknown())
});

const reviewBodySchema = z.object({
  delivery: z.enum(["inline", "detached"]).optional(),
  targetType: z.enum(["uncommittedChanges", "baseBranch", "commit", "custom"]).optional(),
  branch: z.string().trim().min(1).optional(),
  sha: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).max(300).optional(),
  instructions: z.string().trim().min(1).optional()
});

const accountLoginStartBodySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("apiKey"),
    apiKey: z.string().trim().min(1)
  }),
  z.object({
    type: z.literal("chatgpt")
  }),
  z.object({
    type: z.literal("chatgptAuthTokens"),
    accessToken: z.string().trim().min(1),
    chatgptAccountId: z.string().trim().min(1),
    chatgptPlanType: z.string().trim().min(1).optional()
  })
]);

const accountLoginCancelBodySchema = z.object({
  loginId: z.string().trim().min(1)
});

const configReadQuerySchema = z.object({
  cwd: z.string().trim().min(1).optional(),
  includeLayers: z.enum(["true", "false"]).optional()
});

const configValueWriteBodySchema = z.object({
  keyPath: z.string().trim().min(1),
  mergeStrategy: z.enum(["replace", "upsert"]),
  value: z.unknown(),
  expectedVersion: z.string().trim().min(1).optional(),
  filePath: z.string().trim().min(1).optional()
});

const configBatchWriteBodySchema = z.object({
  edits: z
    .array(
      z.object({
        keyPath: z.string().trim().min(1),
        mergeStrategy: z.enum(["replace", "upsert"]),
        value: z.unknown()
      })
    )
    .min(1),
  expectedVersion: z.string().trim().min(1).optional(),
  filePath: z.string().trim().min(1).optional()
});

const feedbackUploadBodySchema = z.object({
  classification: z.string().trim().min(1),
  includeLogs: z.boolean(),
  reason: z.string().trim().min(1).optional(),
  threadId: z.string().trim().min(1).optional()
});

const commandExecBodySchema = z.object({
  command: z.array(z.string().trim().min(1)).min(1),
  cwd: z.string().trim().min(1).optional(),
  timeoutMs: z.coerce.number().int().positive().optional()
});

const skillsListQuerySchema = z.object({
  forceReload: z.enum(["true", "false"]).optional(),
  cwd: z.string().trim().min(1).optional()
});

const skillsConfigWriteBodySchema = z.object({
  path: z.string().trim().min(1),
  enabled: z.boolean()
});

const skillsRemoteWriteBodySchema = z.object({
  hazelnutId: z.string().trim().min(1),
  isPreload: z.boolean()
});

const appsQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  threadId: z.string().trim().min(1).optional(),
  forceRefetch: z.enum(["true", "false"]).optional()
});

const wsCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), threadId: z.string().min(1) }),
  z.object({ type: z.literal("unsubscribe") }),
  z.object({ type: z.literal("ping") })
]);

const app = Fastify({
  logger: {
    level: env.LOG_LEVEL
  }
});

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof z.ZodError) {
    reply.code(400).send({
      status: "error",
      code: "invalid_request",
      message: "request validation failed",
      issues: error.issues
    });
    return;
  }

  const knownError = error as { statusCode?: unknown; message?: unknown };

  if (typeof knownError.statusCode === "number") {
    reply.code(knownError.statusCode).send({
      status: "error",
      code: "request_failed",
      message: typeof knownError.message === "string" ? knownError.message : "request failed"
    });
    return;
  }

  app.log.error({ err: error }, "unhandled request error");
  reply.code(500).send({
    status: "error",
    code: "internal_error",
    message: "internal server error"
  });
});

const dataLogDir = path.join(env.DATA_DIR, "logs");
await mkdir(dataLogDir, { recursive: true });

async function bootstrapCodexHomeAuth(): Promise<void> {
  if (!env.CODEX_HOME) {
    return;
  }

  const targetAuthPath = path.join(env.CODEX_HOME, "auth.json");
  if (existsSync(targetAuthPath)) {
    return;
  }

  const sourceAuthPath = path.join(homedir(), ".codex", "auth.json");
  if (!existsSync(sourceAuthPath)) {
    return;
  }

  await mkdir(env.CODEX_HOME, { recursive: true });
  await copyFile(sourceAuthPath, targetAuthPath);
  app.log.info(
    {
      sourceAuthPath,
      targetAuthPath
    },
    "bootstrapped CODEX_HOME auth.json from user codex auth store"
  );
}

await bootstrapCodexHomeAuth();

const codexRuntime = new CodexRuntimeClient({
  bin: env.CODEX_BIN,
  codeHome: env.CODEX_HOME,
  dataDir: env.DATA_DIR,
  cwd: env.WORKSPACE_ROOT,
  logger: app.log
});

const activeTurnByThread = new Map<string, string>();
const pendingApprovals = new Map<string, PendingApprovalRecord>();
const pendingToolUserInputs = new Map<string, PendingToolUserInputRecord>();
const purgedSessionIds = new Set<string>();
const supplementalTranscriptByThread = new Map<string, Map<string, SupplementalTranscriptEntry>>();
const fileChangeEventAnchorsByTurn = new Map<string, Set<string>>();
const turnCompletedEventDispatchInFlight = new Set<string>();
const coreQueueWorkerOrientationCompletedBySession = new Set<string>();
const agentExtensionBootstrapCompletedBySession = new Map<string, Set<string>>();
const coreQueueWorkerOrientationInFlightBySession = new Map<string, Promise<void>>();
const agentExtensionBootstrapInFlightByKey = new Map<string, Promise<void>>();
const runtimeObservedTurnsByKey = new Map<string, RuntimeObservedTurnState>();
const runtimeTurnSignalWaitersByKey = new Map<string, Set<() => void>>();
const suggestedRequestStateByRequestKey = new Map<string, SuggestedRequestRuntimeState>();
const MAX_SUGGESTED_REQUEST_STATE_ENTRIES = 2_000;
let supplementalTranscriptSequence = 1;
let supplementalTranscriptPersistTimer: NodeJS.Timeout | null = null;
let supplementalTranscriptPersistQueued = false;
let supplementalTranscriptPersistInFlight: Promise<void> | null = null;
const sockets = new Set<WebSocketLike>();
const socketThreadFilter = new Map<WebSocketLike, string | null>();
const codexHomeAuthFilePath = env.CODEX_HOME ? path.join(env.CODEX_HOME, "auth.json") : null;
const sessionMetadataPath = path.join(env.DATA_DIR, "session-metadata.json");
const supplementalTranscriptPath = path.join(env.DATA_DIR, "supplemental-transcript.json");
const orchestratorJobsPath = path.join(env.DATA_DIR, "orchestrator-jobs.json");
const agentExtensionAuditStore = new AgentExtensionAuditStore({
  dataDir: env.DATA_DIR,
  logger: app.log
});
const agentsRootPath = path.join(env.WORKSPACE_ROOT, "agents");
const configuredExtensionRoots = env.AGENT_EXTENSION_CONFIGURED_ROOTS.split(path.delimiter)
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0)
  .map((entry) => (path.isAbsolute(entry) ? entry : path.resolve(env.WORKSPACE_ROOT, entry)));
const installedExtensionRoots = env.AGENT_EXTENSION_PACKAGE_ROOTS.split(path.delimiter)
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0)
  .map((entry) => (path.isAbsolute(entry) ? entry : path.resolve(env.WORKSPACE_ROOT, entry)));
const syntheticTranscriptMessageIdPattern = /^item-\d+$/i;
const sessionMetadata = await loadSessionMetadata();
await loadSupplementalTranscriptStore();
const deletedSessionMessage = "This chat was permanently deleted and is no longer available.";
const capabilitiesByMethod = new Map<string, CapabilityEntry>();
let capabilitiesLastUpdatedAt: string | null = null;
let capabilitiesInitialized = false;
let capabilitiesRefreshInFlight: Promise<void> | null = null;
let experimentalRawEventsCapability: "unknown" | "supported" | "unsupported" = "unknown";
const projectAgentSessionEnsureInFlightByKey = new Map<string, Promise<string>>();
const agentActionResultByIdempotencyKey = new Map<
  string,
  {
    signature: string;
    result: AgentRuntimeActionResult;
  }
>();
let orchestratorQueue: OrchestratorQueue | null = null;

function classifyProfileActionFailureStatus(error: unknown): RuntimeProfileActionResult["status"] {
  if (!(error instanceof Error)) {
    return "failed";
  }
  const message = error.message.toLowerCase();
  if (message.includes("no active turn")) {
    return "conflict";
  }
  if (message.includes("already resolved") || message.includes("already handled") || message.includes("not found")) {
    return "already_resolved";
  }
  if (message.includes("not eligible")) {
    return "not_eligible";
  }
  if (message.includes("conflict")) {
    return "conflict";
  }
  return "failed";
}

const runtimeProfileAdapter: RuntimeProfileAdapter = createCodexManagerRuntimeProfileAdapter({
  codexRuntime,
  upsertTranscript: async (input) => {
    upsertSupplementalTranscriptEntry(input.sessionId, input.entry);
    publishTranscriptUpdated(input.sessionId, {
      turnId: input.entry.turnId,
      messageId: input.entry.messageId,
      type: input.entry.type,
      entry: input.entry
    });
    return {
      actionType: "transcript.upsert",
      status: "performed",
      details: {
        messageId: input.entry.messageId,
        turnId: input.entry.turnId
      }
    };
  },
  decideApproval: async (input) => {
    try {
      await codexRuntime.respond(input.rpcId, input.payload);
      return {
        actionType: input.actionType,
        status: "performed",
        details: {
          approvalId: input.approvalId,
          threadId: input.threadId
        }
      };
    } catch (error) {
      return {
        actionType: input.actionType,
        status: classifyProfileActionFailureStatus(error),
        details: {
          approvalId: input.approvalId,
          threadId: input.threadId,
          error: error instanceof Error ? error.message : String(error)
        }
      };
    }
  },
  steerTurn: async (input) => {
    try {
      await callCodexTurnSteer(codexRuntime, input);
      return {
        actionType: "turn.steer",
        status: "performed",
        details: {
          threadId: input.sessionId,
          turnId: input.turnId
        }
      };
    } catch (error) {
      return {
        actionType: "turn.steer",
        status: classifyProfileActionFailureStatus(error),
        details: {
          threadId: input.sessionId,
          turnId: input.turnId,
          error: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }
});

if (env.ORCHESTRATOR_QUEUE_ENABLED) {
  orchestratorQueue = new OrchestratorQueue({
    definitions: buildOrchestratorJobDefinitions(),
    store: new FileOrchestratorQueueStore(orchestratorJobsPath, app.log),
    hooks: {
      emitEvent: (event) => {
        publishToSockets(event.type, event.payload, event.threadId ?? undefined);
      },
      interruptTurn: async (threadId: string, turnId: string) => {
        await runtimeProfileAdapter.interruptTurn({
          threadId,
          turnId
        });
      }
    },
    logger: app.log,
    globalConcurrency: env.ORCHESTRATOR_QUEUE_GLOBAL_CONCURRENCY,
    maxPerProject: env.ORCHESTRATOR_QUEUE_MAX_PER_PROJECT,
    maxGlobal: env.ORCHESTRATOR_QUEUE_MAX_GLOBAL,
    defaultMaxAttempts: env.ORCHESTRATOR_QUEUE_MAX_ATTEMPTS,
    defaultTimeoutMs: env.ORCHESTRATOR_QUEUE_DEFAULT_TIMEOUT_MS,
    backgroundAgingMs: env.ORCHESTRATOR_QUEUE_BACKGROUND_AGING_MS,
    maxInteractiveBurst: env.ORCHESTRATOR_QUEUE_MAX_INTERACTIVE_BURST
  });
}

const runtimeProfileIdentity = runtimeProfileAdapter.identity();
const agentEventsRuntime = new AgentEventsRuntime({
  agentsRoot: agentsRootPath,
  logger: app.log,
  trustMode: env.AGENT_EXTENSION_TRUST_MODE,
  runtimeCompatibility: {
    coreVersion: runtimeProfileIdentity.coreVersion,
    runtimeProfileId: runtimeProfileIdentity.profileId,
    runtimeProfileVersion: runtimeProfileIdentity.profileVersion
  },
  extensionSources: [
    ...configuredExtensionRoots.map((entry) => ({
      type: "configured_root" as const,
      path: entry
    })),
    ...installedExtensionRoots.map((entry) => ({
      type: "installed_package" as const,
      path: entry
    }))
  ]
});
await agentEventsRuntime.load().catch((error) => {
  app.log.warn({ error, agentsRootPath }, "failed to load agent events runtime modules");
});

function resolveActionCapabilityContextForAgent(agentId: string): AgentRuntimeActionCapabilityContext {
  const modules = agentEventsRuntime.listLoadedModules();
  const matches = modules.filter((module) => module.agentId === agentId);
  const selected = matches.find((module) => module.moduleName === agentId) ?? matches[0];

  if (!selected) {
    return {
      extensionName: agentId,
      declaredCapabilities: null
    };
  }

  return {
    extensionName: selected.name,
    declaredCapabilities: {
      events: [...selected.capabilities.events],
      actions: [...selected.capabilities.actions]
    }
  };
}

const capabilityMethodProbes: Array<CapabilityMethodProbe> = [
  { method: "thread/fork", probeParams: {} },
  { method: "thread/compact/start", probeParams: {} },
  { method: "thread/rollback", probeParams: {} },
  { method: "thread/backgroundTerminals/clean", probeParams: {} },
  { method: "turn/steer", probeParams: {} },
  { method: "review/start", probeParams: {} },
  { method: "command/exec", probeParams: {} },
  { method: "experimentalFeature/list", probeParams: { limit: 1 } },
  { method: "collaborationMode/list", probeParams: {} },
  { method: "skills/list", probeParams: {} },
  { method: "skills/config/write", probeParams: {} },
  { method: "skills/remote/read", probeParams: {} },
  { method: "skills/remote/write", probeParams: {} },
  { method: "app/list", probeParams: { limit: 1 } },
  { method: "config/mcpServer/reload", probeParams: { _probe: true } },
  { method: "mcpServer/oauth/login", probeParams: {} },
  { method: "item/tool/requestUserInput", probeParams: {} },
  { method: "tool/requestUserInput", probeParams: {} },
  { method: "config/read", probeParams: {} },
  { method: "config/value/write", probeParams: {} },
  { method: "config/batchWrite", probeParams: {} },
  { method: "configRequirements/read", probeParams: { _probe: true } },
  { method: "feedback/upload", probeParams: {} },
  { method: "account/read", probeParams: {} },
  { method: "account/login/start", probeParams: {} },
  { method: "account/login/cancel", probeParams: {} },
  { method: "account/logout", probeParams: { _probe: true } },
  { method: "account/rateLimits/read", probeParams: { _probe: true } }
];

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

async function assertRoleAllowed(
  request: { headers: Record<string, unknown>; ip?: string | null },
  reply: { code: (statusCode: number) => { send: (payload: unknown) => void } },
  allowedRoles: Array<AgentExtensionRole>
): Promise<{ role: AgentExtensionRole; actorId: string | null } | null> {
  const resolved = await resolveAgentExtensionRequestRole({
    mode: env.AGENT_EXTENSION_RBAC_MODE,
    headers: request.headers,
    requestIp: typeof request.ip === "string" ? request.ip : null,
    header: {
      secret: env.AGENT_EXTENSION_RBAC_HEADER_SECRET ?? null
    },
    jwt: {
      secret: env.AGENT_EXTENSION_RBAC_JWT_SECRET ?? null,
      issuer: env.AGENT_EXTENSION_RBAC_JWT_ISSUER ?? null,
      audience: env.AGENT_EXTENSION_RBAC_JWT_AUDIENCE ?? null,
      roleClaim: env.AGENT_EXTENSION_RBAC_JWT_ROLE_CLAIM,
      actorClaim: env.AGENT_EXTENSION_RBAC_JWT_ACTOR_CLAIM
    }
  });
  if (!resolved.ok) {
    reply.code(resolved.statusCode).send(resolved.payload);
    return null;
  }

  if (!roleAllowed(resolved.role, allowedRoles)) {
    reply.code(403).send({
      status: "forbidden",
      code: "insufficient_role",
      required: allowedRoles,
      role: resolved.role
    });
    return null;
  }

  return {
    role: resolved.role,
    actorId: resolved.actorId
  };
}

function sourceLabel(source: unknown): string {
  if (typeof source === "string") {
    return source;
  }

  if (source && typeof source === "object" && "subAgent" in source) {
    return "subAgent";
  }

  return "unknown";
}

function safePrettyJson(value: unknown): string | null {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function serializeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  return "unknown error";
}

function coerceEpochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    if (value > 10_000_000_000) {
      return Math.round(value);
    }
    return Math.round(value * 1000);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      if (numeric > 10_000_000_000) {
        return Math.round(numeric);
      }
      return Math.round(numeric * 1000);
    }

    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function getSessionTurnTimingMap(sessionId: string): Record<string, TurnTimingRecord> {
  let map = sessionMetadata.turnTimingBySessionId[sessionId];
  if (map) {
    return map;
  }
  map = {};
  sessionMetadata.turnTimingBySessionId[sessionId] = map;
  return map;
}

function clearSessionTurnTimings(sessionId: string): boolean {
  if (!(sessionId in sessionMetadata.turnTimingBySessionId)) {
    return false;
  }
  delete sessionMetadata.turnTimingBySessionId[sessionId];
  return true;
}

function setTurnStartedAt(sessionId: string, turnId: string, startedAt: number): boolean {
  const timings = getSessionTurnTimingMap(sessionId);
  const existing = timings[turnId];
  if (!existing) {
    timings[turnId] = { startedAt };
    return true;
  }

  let changed = false;
  if (existing.startedAt !== startedAt) {
    existing.startedAt = startedAt;
    changed = true;
  }

  if (typeof existing.completedAt === "number" && existing.completedAt < existing.startedAt) {
    delete existing.completedAt;
    changed = true;
  }

  return changed;
}

function setTurnCompletedAt(sessionId: string, turnId: string, completedAt: number): boolean {
  const timings = getSessionTurnTimingMap(sessionId);
  const existing = timings[turnId];
  if (!existing) {
    timings[turnId] = {
      startedAt: completedAt,
      completedAt
    };
    return true;
  }

  const normalizedCompletedAt = completedAt >= existing.startedAt ? completedAt : existing.startedAt;
  if (existing.completedAt === normalizedCompletedAt) {
    return false;
  }

  existing.completedAt = normalizedCompletedAt;
  return true;
}

function lookupTurnTiming(sessionId: string, turnId: string): TurnTimingRecord | null {
  const sessionTiming = sessionMetadata.turnTimingBySessionId[sessionId];
  if (!sessionTiming) {
    return null;
  }
  return sessionTiming[turnId] ?? null;
}

function earliestTimestamp(left: number | undefined, right: number | undefined): number | undefined {
  if (typeof left === "number" && typeof right === "number") {
    return Math.min(left, right);
  }
  return typeof left === "number" ? left : right;
}

function latestTimestamp(left: number | undefined, right: number | undefined): number | undefined {
  if (typeof left === "number" && typeof right === "number") {
    return Math.max(left, right);
  }
  return typeof left === "number" ? left : right;
}

function isTerminalTranscriptStatus(status: TranscriptEntry["status"]): boolean {
  return status === "complete" || status === "error" || status === "canceled";
}

function upsertSupplementalTranscriptEntry(threadId: string, entry: TranscriptEntry): void {
  let entryMap = supplementalTranscriptByThread.get(threadId);
  if (!entryMap) {
    entryMap = new Map<string, SupplementalTranscriptEntry>();
    supplementalTranscriptByThread.set(threadId, entryMap);
  }

  const existing = entryMap.get(entry.messageId);
  if (existing) {
    const mergedStartedAt = earliestTimestamp(existing.entry.startedAt, entry.startedAt);
    const mergedCompletedAt = latestTimestamp(existing.entry.completedAt, entry.completedAt);
    const normalizedCompletedAt =
      typeof mergedCompletedAt === "number" && typeof mergedStartedAt === "number" && mergedCompletedAt < mergedStartedAt
        ? mergedStartedAt
        : mergedCompletedAt;

    const preventStatusRegression = isTerminalTranscriptStatus(existing.entry.status) && entry.status === "streaming";
    const incoming = preventStatusRegression
      ? {
          ...entry,
          status: existing.entry.status,
          content: existing.entry.content,
          ...(typeof existing.entry.details === "string" ? { details: existing.entry.details } : {})
        }
      : entry;

    const mergedEntry: TranscriptEntry = {
      ...existing.entry,
      ...incoming,
      ...(typeof mergedStartedAt === "number" ? { startedAt: mergedStartedAt } : {}),
      ...(typeof normalizedCompletedAt === "number" ? { completedAt: normalizedCompletedAt } : {})
    };

    entryMap.set(entry.messageId, {
      ...existing,
      entry: mergedEntry
    });
    requestSupplementalTranscriptPersistence();
    return;
  }

  entryMap.set(entry.messageId, {
    sequence: supplementalTranscriptSequence,
    entry
  });
  supplementalTranscriptSequence += 1;

  // Keep memory bounded for long-running sessions.
  if (entryMap.size > 5000) {
    const sortedEntries = Array.from(entryMap.values()).sort((left, right) => left.sequence - right.sequence);
    const trimmed = sortedEntries.slice(sortedEntries.length - 5000);
    const nextMap = new Map<string, SupplementalTranscriptEntry>();
    for (const item of trimmed) {
      nextMap.set(item.entry.messageId, item);
    }
    supplementalTranscriptByThread.set(threadId, nextMap);
  }

  requestSupplementalTranscriptPersistence();
}

function upsertAgentWorkerLifecycleEntry(input: {
  sessionId: string;
  messageId: string;
  turnId: string;
  status: TranscriptEntry["status"];
  content: string;
  details?: Record<string, unknown>;
  startedAt?: number;
}): void {
  const now = Date.now();
  const detailsText = input.details ? stringifyDetails(input.details) : undefined;
  const entry: TranscriptEntry = {
    messageId: input.messageId,
    turnId: input.turnId,
    role: "system",
    type: "agent.worker.lifecycle",
    content: input.content,
    ...(detailsText ? { details: detailsText } : {}),
    status: input.status,
    ...(typeof input.startedAt === "number" ? { startedAt: input.startedAt } : {}),
    ...(input.status === "streaming" ? { startedAt: input.startedAt ?? now } : { completedAt: now })
  };
  upsertSupplementalTranscriptEntry(input.sessionId, entry);
  publishTranscriptUpdated(input.sessionId, {
    turnId: entry.turnId,
    messageId: entry.messageId,
    type: entry.type,
    entry
  });
}

function listSupplementalTranscriptEntries(threadId: string): Array<SupplementalTranscriptEntry> {
  const entryMap = supplementalTranscriptByThread.get(threadId);
  if (!entryMap || entryMap.size === 0) {
    return [];
  }

  return Array.from(entryMap.values()).sort((left, right) => left.sequence - right.sequence);
}

function clearSupplementalTranscriptEntries(threadId: string): boolean {
  const deleted = supplementalTranscriptByThread.delete(threadId);
  if (deleted) {
    requestSupplementalTranscriptPersistence();
  }
  return deleted;
}

function normalizeComparableTranscriptText(value: string | undefined): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim();
}

function isSyntheticTranscriptMessageId(messageId: string): boolean {
  return syntheticTranscriptMessageIdPattern.test(messageId);
}

function hasCanonicalTurnMatchForSyntheticEntry(
  entry: TranscriptEntry,
  turnEntries: Array<TranscriptEntry>
): boolean {
  const canonicalCandidates = turnEntries.filter(
    (candidate) =>
      candidate.messageId !== entry.messageId &&
      !isSyntheticTranscriptMessageId(candidate.messageId) &&
      candidate.role === entry.role &&
      candidate.type === entry.type
  );

  if (canonicalCandidates.length === 0) {
    return false;
  }

  // Raw-events fallback often emits synthetic "reasoning" snapshots that overlap
  // canonical reasoning items from thread/read. Prefer canonical rows whenever present.
  if (entry.type === "reasoning") {
    return true;
  }

  const normalizedContent = normalizeComparableTranscriptText(entry.content);
  const normalizedDetails = normalizeComparableTranscriptText(entry.details);

  return canonicalCandidates.some((candidate) => {
    const candidateContent = normalizeComparableTranscriptText(candidate.content);
    if (normalizedContent.length > 0 && candidateContent === normalizedContent) {
      return true;
    }

    if (normalizedDetails.length > 0) {
      const candidateDetails = normalizeComparableTranscriptText(candidate.details);
      if (candidateDetails === normalizedDetails) {
        return true;
      }
    }

    return false;
  });
}

function dedupeSyntheticTranscriptEntriesByTurn(transcript: Array<TranscriptEntry>): Array<TranscriptEntry> {
  if (transcript.length === 0) {
    return transcript;
  }

  const turnOrder: Array<string> = [];
  const entriesByTurnId = new Map<string, Array<TranscriptEntry>>();
  for (const entry of transcript) {
    if (!entriesByTurnId.has(entry.turnId)) {
      entriesByTurnId.set(entry.turnId, []);
      turnOrder.push(entry.turnId);
    }
    entriesByTurnId.get(entry.turnId)?.push(entry);
  }

  const deduped: Array<TranscriptEntry> = [];
  for (const turnId of turnOrder) {
    const turnEntries = entriesByTurnId.get(turnId) ?? [];
    const hasSynthetic = turnEntries.some((entry) => isSyntheticTranscriptMessageId(entry.messageId));
    const hasCanonical = turnEntries.some((entry) => !isSyntheticTranscriptMessageId(entry.messageId));
    if (!hasSynthetic || !hasCanonical) {
      deduped.push(...turnEntries);
      continue;
    }

    for (const entry of turnEntries) {
      if (isSyntheticTranscriptMessageId(entry.messageId) && hasCanonicalTurnMatchForSyntheticEntry(entry, turnEntries)) {
        continue;
      }
      deduped.push(entry);
    }
  }

  return deduped;
}

function extractItemStartedAt(item: CodexThreadItem): number | null {
  return (
    coerceEpochMs(item.startedAt) ??
    coerceEpochMs(item.started_at) ??
    coerceEpochMs(item.startTime) ??
    coerceEpochMs(item.start_time)
  );
}

function extractItemCompletedAt(item: CodexThreadItem): number | null {
  return (
    coerceEpochMs(item.completedAt) ??
    coerceEpochMs(item.completed_at) ??
    coerceEpochMs(item.endTime) ??
    coerceEpochMs(item.end_time)
  );
}

function extractAnchorItemIdFromTranscriptEntry(entry: TranscriptEntry): string | null {
  if (!entry.details || entry.details.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(entry.details) as Record<string, unknown>;
    if (typeof parsed.anchorItemId === "string" && parsed.anchorItemId.trim().length > 0) {
      return parsed.anchorItemId.trim();
    }
  } catch {
    return null;
  }

  return null;
}

function mergeTranscriptWithSupplemental(
  threadId: string,
  transcript: Array<TranscriptEntry>
): Array<TranscriptEntry> {
  const statusPriority = (status: TranscriptEntry["status"]): number => {
    if (status === "error") {
      return 3;
    }
    if (status === "canceled") {
      return 2;
    }
    if (status === "complete") {
      return 1;
    }
    return 0;
  };

  const mergeTranscriptEntries = (base: TranscriptEntry, supplemental: TranscriptEntry): TranscriptEntry => {
    const normalizedTextLength = (value: unknown): number => {
      if (typeof value !== "string") {
        return 0;
      }
      return value.trim().length;
    };

    const pickRicherText = (preferred: string | undefined, fallback: string | undefined): string | undefined => {
      const preferredLength = normalizedTextLength(preferred);
      const fallbackLength = normalizedTextLength(fallback);
      if (preferredLength === 0 && fallbackLength === 0) {
        return undefined;
      }
      if (preferredLength === 0) {
        return fallback;
      }
      if (fallbackLength === 0) {
        return preferred;
      }
      return preferredLength >= fallbackLength ? preferred : fallback;
    };

    const choosePreferredEntry = (): TranscriptEntry => {
      const basePriority = statusPriority(base.status);
      const supplementalPriority = statusPriority(supplemental.status);
      if (basePriority !== supplementalPriority) {
        return basePriority > supplementalPriority ? base : supplemental;
      }

      const baseDetailsLength = normalizedTextLength(base.details);
      const supplementalDetailsLength = normalizedTextLength(supplemental.details);
      if (baseDetailsLength !== supplementalDetailsLength) {
        return baseDetailsLength > supplementalDetailsLength ? base : supplemental;
      }

      const baseContentLength = normalizedTextLength(base.content);
      const supplementalContentLength = normalizedTextLength(supplemental.content);
      if (baseContentLength !== supplementalContentLength) {
        return baseContentLength > supplementalContentLength ? base : supplemental;
      }

      return base;
    };

    const startedAt =
      typeof base.startedAt === "number" && typeof supplemental.startedAt === "number"
        ? Math.min(base.startedAt, supplemental.startedAt)
        : typeof base.startedAt === "number"
          ? base.startedAt
          : supplemental.startedAt;
    const completedAt =
      typeof base.completedAt === "number" && typeof supplemental.completedAt === "number"
        ? Math.max(base.completedAt, supplemental.completedAt)
        : typeof base.completedAt === "number"
          ? base.completedAt
          : supplemental.completedAt;
    const mergedStatus =
      statusPriority(base.status) >= statusPriority(supplemental.status) ? base.status : supplemental.status;
    const preferred = choosePreferredEntry();
    const fallback = preferred === base ? supplemental : base;
    const content = pickRicherText(preferred.content, fallback.content) ?? preferred.content ?? fallback.content ?? "";
    const details = pickRicherText(preferred.details, fallback.details);

    return {
      messageId: preferred.messageId,
      turnId: preferred.turnId,
      role: preferred.role,
      type: preferred.type,
      content,
      ...(typeof details === "string" ? { details } : {}),
      status: mergedStatus,
      ...(typeof startedAt === "number" ? { startedAt } : {}),
      ...(typeof completedAt === "number" ? { completedAt } : {})
    };
  };

  const finalizeTranscriptEntryFromTurnTiming = (entry: TranscriptEntry): TranscriptEntry => {
    const turnTiming = lookupTurnTiming(threadId, entry.turnId);
    if (!turnTiming) {
      return entry;
    }

    let changed = false;
    const next: TranscriptEntry = { ...entry };
    if (typeof next.startedAt !== "number" && typeof turnTiming.startedAt === "number") {
      next.startedAt = turnTiming.startedAt;
      changed = true;
    }
    if (typeof next.completedAt !== "number" && typeof turnTiming.completedAt === "number") {
      next.completedAt = turnTiming.completedAt;
      changed = true;
    }

    if (next.status === "streaming" && typeof turnTiming.completedAt === "number") {
      next.status = "complete";
      changed = true;
    }

    return changed ? next : entry;
  };

  const supplementalEntries = listSupplementalTranscriptEntries(threadId);
  if (supplementalEntries.length === 0) {
    const finalized = transcript.map((entry) => finalizeTranscriptEntryFromTurnTiming(entry));
    return dedupeSyntheticTranscriptEntriesByTurn(finalized);
  }

  const baseTurnOrder: Array<string> = [];
  const baseEntriesByTurnId = new Map<string, Array<TranscriptEntry>>();
  for (const entry of transcript) {
    if (!baseEntriesByTurnId.has(entry.turnId)) {
      baseEntriesByTurnId.set(entry.turnId, []);
      baseTurnOrder.push(entry.turnId);
    }
    baseEntriesByTurnId.get(entry.turnId)?.push(entry);
  }

  const supplementalEntriesByTurnId = new Map<string, Array<SupplementalTranscriptEntry>>();
  for (const supplemental of supplementalEntries) {
    const turnId = supplemental.entry.turnId;
    const bucket = supplementalEntriesByTurnId.get(turnId);
    if (bucket) {
      bucket.push(supplemental);
    } else {
      supplementalEntriesByTurnId.set(turnId, [supplemental]);
    }
  }

  const merged: Array<TranscriptEntry> = [];
  for (const turnId of baseTurnOrder) {
    const baseTurnEntries = baseEntriesByTurnId.get(turnId) ?? [];
    const supplementalTurnEntries = supplementalEntriesByTurnId.get(turnId);
    if (!supplementalTurnEntries) {
      merged.push(...baseTurnEntries);
      continue;
    }

    const supplementalEntriesForTurn = supplementalTurnEntries.map((entry) => entry.entry);

    let insertionIndex = baseTurnEntries.length;
    for (let index = baseTurnEntries.length - 1; index >= 0; index -= 1) {
      if (baseTurnEntries[index].role === "assistant") {
        insertionIndex = index;
        break;
      }
    }

    const mergedTurnEntries = [...baseTurnEntries];
    const indexByMessageId = new Map<string, number>();
    for (let index = 0; index < mergedTurnEntries.length; index += 1) {
      indexByMessageId.set(mergedTurnEntries[index].messageId, index);
    }

    for (const supplementalEntry of supplementalEntriesForTurn) {
      const existingIndex = indexByMessageId.get(supplementalEntry.messageId);
      if (typeof existingIndex === "number") {
        mergedTurnEntries[existingIndex] = mergeTranscriptEntries(mergedTurnEntries[existingIndex], supplementalEntry);
        continue;
      }

      let insertAt = Math.min(insertionIndex, mergedTurnEntries.length);
      const anchorItemId = extractAnchorItemIdFromTranscriptEntry(supplementalEntry);
      if (anchorItemId) {
        const anchorIndex = indexByMessageId.get(anchorItemId);
        if (typeof anchorIndex === "number") {
          insertAt = Math.min(anchorIndex + 1, mergedTurnEntries.length);
        }
      }

      mergedTurnEntries.splice(insertAt, 0, supplementalEntry);
      if (insertAt <= insertionIndex) {
        insertionIndex += 1;
      }
      for (let index = insertAt; index < mergedTurnEntries.length; index += 1) {
        indexByMessageId.set(mergedTurnEntries[index].messageId, index);
      }
    }

    merged.push(...mergedTurnEntries);
    supplementalEntriesByTurnId.delete(turnId);
  }

  const remainingTurns = Array.from(supplementalEntriesByTurnId.entries()).sort((left, right) => {
    const leftSequence = left[1][0]?.sequence ?? Number.MAX_SAFE_INTEGER;
    const rightSequence = right[1][0]?.sequence ?? Number.MAX_SAFE_INTEGER;
    return leftSequence - rightSequence;
  });

  for (const [, entries] of remainingTurns) {
    for (const supplemental of entries) {
      merged.push(supplemental.entry);
    }
  }

  const finalized = merged.map((entry) => finalizeTranscriptEntryFromTurnTiming(entry));
  return dedupeSyntheticTranscriptEntriesByTurn(finalized);
}

function normalizeTranscriptEntryFromStore(value: unknown): TranscriptEntry | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  const messageId = typeof value.messageId === "string" ? value.messageId.trim() : "";
  const turnId = typeof value.turnId === "string" ? value.turnId.trim() : "";
  const role = value.role;
  const type = typeof value.type === "string" ? value.type.trim() : "";
  const content = typeof value.content === "string" ? value.content : "";
  const status = value.status;

  if (!messageId || !turnId || !type) {
    return null;
  }

  if (role !== "user" && role !== "assistant" && role !== "system") {
    return null;
  }

  if (status !== "streaming" && status !== "complete" && status !== "canceled" && status !== "error") {
    return null;
  }

  const startedAt =
    coerceEpochMs(value.startedAt) ??
    coerceEpochMs(value.started_at) ??
    coerceEpochMs(value.startTime) ??
    coerceEpochMs(value.start_time);
  const completedAt =
    coerceEpochMs(value.completedAt) ??
    coerceEpochMs(value.completed_at) ??
    coerceEpochMs(value.endTime) ??
    coerceEpochMs(value.end_time);

  const normalized: TranscriptEntry = {
    messageId,
    turnId,
    role,
    type,
    content,
    status
  };

  if (typeof value.details === "string" && value.details.trim().length > 0) {
    normalized.details = value.details;
  }

  if (startedAt !== null) {
    normalized.startedAt = startedAt;
  } else if (completedAt !== null) {
    normalized.startedAt = completedAt;
  }

  if (completedAt !== null && completedAt >= (normalized.startedAt ?? completedAt)) {
    normalized.completedAt = completedAt;
  }

  return normalized;
}

function normalizeSupplementalTranscriptEntryFromStore(value: unknown): SupplementalTranscriptEntry | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  const sequenceValue = value.sequence;
  const sequence =
    typeof sequenceValue === "number" && Number.isFinite(sequenceValue) && sequenceValue > 0
      ? Math.floor(sequenceValue)
      : null;
  if (sequence === null) {
    return null;
  }

  const entry = normalizeTranscriptEntryFromStore(value.entry);
  if (!entry) {
    return null;
  }

  return {
    sequence,
    entry
  };
}

async function loadSupplementalTranscriptStore(): Promise<void> {
  try {
    const raw = await readFile(supplementalTranscriptPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!isObjectRecord(parsed)) {
      return;
    }

    const byThread = isObjectRecord(parsed.byThreadId) ? parsed.byThreadId : null;
    const next = new Map<string, Map<string, SupplementalTranscriptEntry>>();
    let maxSequence = 0;

    if (byThread) {
      for (const [threadId, rawEntries] of Object.entries(byThread)) {
        if (typeof threadId !== "string" || threadId.trim().length === 0 || !Array.isArray(rawEntries)) {
          continue;
        }

        const normalized = rawEntries
          .map((value) => normalizeSupplementalTranscriptEntryFromStore(value))
          .filter((value): value is SupplementalTranscriptEntry => value !== null)
          .sort((left, right) => left.sequence - right.sequence)
          .slice(-5000);

        if (normalized.length === 0) {
          continue;
        }

        const entryMap = new Map<string, SupplementalTranscriptEntry>();
        for (const entry of normalized) {
          const existing = entryMap.get(entry.entry.messageId);
          if (!existing || existing.sequence <= entry.sequence) {
            entryMap.set(entry.entry.messageId, entry);
          }
          maxSequence = Math.max(maxSequence, entry.sequence);
        }

        if (entryMap.size > 0) {
          next.set(threadId, entryMap);
        }
      }
    }

    supplementalTranscriptByThread.clear();
    for (const [threadId, entryMap] of next.entries()) {
      supplementalTranscriptByThread.set(threadId, entryMap);
    }

    const parsedSequence =
      typeof parsed.sequence === "number" && Number.isFinite(parsed.sequence) && parsed.sequence > 0
        ? Math.floor(parsed.sequence)
        : 1;
    supplementalTranscriptSequence = Math.max(parsedSequence, maxSequence + 1, 1);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      app.log.warn({ error }, "failed to load supplemental transcript store");
    }
  }
}

function scheduleSupplementalTranscriptPersistence(delayMs: number): void {
  if (supplementalTranscriptPersistTimer !== null) {
    return;
  }

  supplementalTranscriptPersistTimer = setTimeout(() => {
    supplementalTranscriptPersistTimer = null;
    void flushSupplementalTranscriptPersistence();
  }, delayMs);
}

function requestSupplementalTranscriptPersistence(): void {
  supplementalTranscriptPersistQueued = true;
  void flushSupplementalTranscriptPersistence();
}

async function persistSupplementalTranscriptStore(): Promise<void> {
  const byThreadId: Record<string, Array<SupplementalTranscriptEntry>> = {};
  for (const [threadId, entryMap] of supplementalTranscriptByThread.entries()) {
    const entries = Array.from(entryMap.values()).sort((left, right) => left.sequence - right.sequence);
    if (entries.length === 0) {
      continue;
    }
    byThreadId[threadId] = entries;
  }

  const payload: SupplementalTranscriptStore = {
    version: 1,
    sequence: supplementalTranscriptSequence,
    byThreadId
  };

  await writeFile(supplementalTranscriptPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function flushSupplementalTranscriptPersistence(): Promise<void> {
  if (supplementalTranscriptPersistInFlight) {
    await supplementalTranscriptPersistInFlight;
    return;
  }

  supplementalTranscriptPersistInFlight = (async () => {
    while (supplementalTranscriptPersistQueued) {
      supplementalTranscriptPersistQueued = false;
      try {
        await persistSupplementalTranscriptStore();
      } catch (error) {
        app.log.warn({ error }, "failed to persist supplemental transcript store");
        supplementalTranscriptPersistQueued = true;
        scheduleSupplementalTranscriptPersistence(1000);
        break;
      }
    }
  })();

  try {
    await supplementalTranscriptPersistInFlight;
  } finally {
    supplementalTranscriptPersistInFlight = null;
  }
}

function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return value === "untrusted" || value === "on-failure" || value === "on-request" || value === "never";
}

function isSessionControlApprovalPolicy(value: unknown): value is SessionControlApprovalPolicy {
  return value === "untrusted" || value === "on-failure" || value === "on-request" || value === "never";
}

function isNetworkAccess(value: unknown): value is NetworkAccess {
  return value === "restricted" || value === "enabled";
}

function isDefaultSandboxMode(value: unknown): value is DefaultSandboxMode {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

function sessionControlApprovalPolicyFromProtocol(policy: ApprovalPolicy): SessionControlApprovalPolicy {
  return policy;
}

function protocolApprovalPolicyFromSessionControl(policy: SessionControlApprovalPolicy): ApprovalPolicy {
  return policy;
}

function defaultSessionControlsFromEnv(): SessionControlsTuple {
  return {
    model: null,
    approvalPolicy: env.DEFAULT_APPROVAL_POLICY,
    networkAccess: env.DEFAULT_NETWORK_ACCESS,
    filesystemSandbox: env.DEFAULT_SANDBOX_MODE
  };
}

function defaultAgentTurnPolicyFromEnv(): AgentTurnPolicy {
  return {
    sandbox: env.DEFAULT_SANDBOX_MODE,
    networkAccess: env.DEFAULT_NETWORK_ACCESS,
    approvalPolicy: env.DEFAULT_APPROVAL_POLICY,
    effort: null
  };
}

function mergeAgentTurnPolicy(base: AgentTurnPolicy, override?: Partial<AgentTurnPolicy>): AgentTurnPolicy {
  if (!override) {
    return base;
  }

  return {
    sandbox: override.sandbox ?? base.sandbox,
    networkAccess: override.networkAccess ?? base.networkAccess,
    approvalPolicy: override.approvalPolicy ?? base.approvalPolicy,
    effort: override.effort ?? base.effort
  };
}

function parseSessionControlsTuple(value: unknown): SessionControlsTuple | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  const approvalPolicy = isSessionControlApprovalPolicy(value.approvalPolicy) ? value.approvalPolicy : null;
  const networkAccess = isNetworkAccess(value.networkAccess) ? value.networkAccess : null;
  const filesystemSandbox = isDefaultSandboxMode(value.filesystemSandbox)
    ? value.filesystemSandbox
    : isDefaultSandboxMode(value.sandbox)
      ? value.sandbox
      : null;

  if (!approvalPolicy || !networkAccess || !filesystemSandbox) {
    return null;
  }

  const model = typeof value.model === "string" ? value.model.trim() : value.model === null ? null : null;
  return {
    model: model && model.length > 0 ? model : null,
    approvalPolicy,
    networkAccess,
    filesystemSandbox
  };
}

async function loadSessionMetadata(): Promise<SessionMetadataStore> {
  try {
    const raw = await readFile(sessionMetadataPath, "utf8");
    const parsed = JSON.parse(raw);
    const titles: Record<string, string> = {};
    const projects: Record<string, ProjectRecord> = {};
    const sessionProjectById: Record<string, string> = {};
    const sessionApprovalPolicyById: Record<string, ApprovalPolicy> = {};
    const sessionControlsById: Record<string, SessionControlsTuple> = {};
    const defaultSessionControls = defaultSessionControlsFromEnv();
    const projectAgentSessionByKey: Record<string, string> = {};
    const systemOwnedSessionIds: Record<string, true> = {};
    const turnTimingBySessionId: Record<string, Record<string, TurnTimingRecord>> = {};
    const now = new Date().toISOString();

    if (isObjectRecord(parsed) && isObjectRecord(parsed.titles)) {
      for (const [threadId, title] of Object.entries(parsed.titles)) {
        if (typeof title === "string" && title.trim().length > 0) {
          titles[threadId] = title.trim();
        }
      }
    }

    if (isObjectRecord(parsed) && isObjectRecord(parsed.projects)) {
      for (const [projectId, value] of Object.entries(parsed.projects)) {
        if (!isObjectRecord(value)) {
          continue;
        }

        const name = typeof value.name === "string" ? value.name.trim() : "";
        if (!name) {
          continue;
        }

        projects[projectId] = {
          name,
          workingDirectory: normalizeProjectWorkingDirectory(
            typeof value.workingDirectory === "string" || value.workingDirectory === null ? value.workingDirectory : null
          ),
          createdAt: typeof value.createdAt === "string" && value.createdAt.trim().length > 0 ? value.createdAt : now,
          updatedAt: typeof value.updatedAt === "string" && value.updatedAt.trim().length > 0 ? value.updatedAt : now
        };
      }
    }

    const rawSessionProjectMap = isObjectRecord(parsed)
      ? isObjectRecord(parsed.sessionProjectById)
        ? parsed.sessionProjectById
        : isObjectRecord(parsed.sessionProjects)
          ? parsed.sessionProjects
          : null
      : null;

    if (rawSessionProjectMap) {
      for (const [sessionId, projectId] of Object.entries(rawSessionProjectMap)) {
        if (typeof projectId !== "string" || !(projectId in projects)) {
          continue;
        }
        sessionProjectById[sessionId] = projectId;
      }
    }

    if (isObjectRecord(parsed) && isObjectRecord(parsed.sessionApprovalPolicyById)) {
      for (const [sessionId, approvalPolicy] of Object.entries(parsed.sessionApprovalPolicyById)) {
        if (isApprovalPolicy(approvalPolicy)) {
          sessionApprovalPolicyById[sessionId] = approvalPolicy;
        }
      }
    }

    if (isObjectRecord(parsed)) {
      const maybeDefaultControls = parseSessionControlsTuple(parsed.defaultSessionControls);
      if (maybeDefaultControls) {
        defaultSessionControls.model = maybeDefaultControls.model;
        defaultSessionControls.approvalPolicy = maybeDefaultControls.approvalPolicy;
        defaultSessionControls.networkAccess = maybeDefaultControls.networkAccess;
        defaultSessionControls.filesystemSandbox = maybeDefaultControls.filesystemSandbox;
      }
    }

    if (isObjectRecord(parsed) && isObjectRecord(parsed.sessionControlsById)) {
      for (const [sessionId, rawControls] of Object.entries(parsed.sessionControlsById)) {
        const controls = parseSessionControlsTuple(rawControls);
        if (controls) {
          sessionControlsById[sessionId] = controls;
        }
      }
    }

    // Legacy migration: preserve stored approval overrides inside the new controls tuple.
    for (const [sessionId, approvalPolicy] of Object.entries(sessionApprovalPolicyById)) {
      const existing = sessionControlsById[sessionId];
      if (existing) {
        continue;
      }
      sessionControlsById[sessionId] = {
        ...defaultSessionControls,
        approvalPolicy: sessionControlApprovalPolicyFromProtocol(approvalPolicy)
      };
    }

    if (isObjectRecord(parsed) && isObjectRecord(parsed.projectAgentSessionByKey)) {
      for (const [key, sessionId] of Object.entries(parsed.projectAgentSessionByKey)) {
        if (typeof key !== "string" || key.trim().length === 0) {
          continue;
        }
        if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
          continue;
        }
        const parsedKey = parseProjectAgentSessionKey(key);
        if (!parsedKey) {
          continue;
        }
        const sessionScopedOwner = parseSessionScopedAgentOwnerId(parsedKey.projectId);
        if (!sessionScopedOwner && !(parsedKey.projectId in projects)) {
          continue;
        }
        projectAgentSessionByKey[key] = sessionId;
        systemOwnedSessionIds[sessionId] = true;
      }
    }

    if (isObjectRecord(parsed) && isObjectRecord(parsed.systemOwnedSessionIds)) {
      for (const [sessionId, enabled] of Object.entries(parsed.systemOwnedSessionIds)) {
        if (enabled === true) {
          systemOwnedSessionIds[sessionId] = true;
        }
      }
    }

    if (isObjectRecord(parsed) && isObjectRecord(parsed.turnTimingBySessionId)) {
      for (const [sessionId, rawTurnTimingMap] of Object.entries(parsed.turnTimingBySessionId)) {
        if (!isObjectRecord(rawTurnTimingMap)) {
          continue;
        }

        const sessionTiming: Record<string, TurnTimingRecord> = {};
        for (const [turnId, rawTiming] of Object.entries(rawTurnTimingMap)) {
          if (!isObjectRecord(rawTiming)) {
            continue;
          }

          const startedAt =
            coerceEpochMs(rawTiming.startedAt) ??
            coerceEpochMs(rawTiming.started_at) ??
            coerceEpochMs(rawTiming.startTime) ??
            coerceEpochMs(rawTiming.start_time);
          if (startedAt === null) {
            continue;
          }

          const completedAt =
            coerceEpochMs(rawTiming.completedAt) ??
            coerceEpochMs(rawTiming.completed_at) ??
            coerceEpochMs(rawTiming.endTime) ??
            coerceEpochMs(rawTiming.end_time);

          sessionTiming[turnId] =
            completedAt !== null && completedAt >= startedAt
              ? {
                  startedAt,
                  completedAt
                }
              : {
                  startedAt
                };
        }

        if (Object.keys(sessionTiming).length > 0) {
          turnTimingBySessionId[sessionId] = sessionTiming;
        }
      }
    }

    return {
      titles,
      projects,
      sessionProjectById,
      sessionApprovalPolicyById,
      sessionControlsById,
      defaultSessionControls,
      projectAgentSessionByKey,
      systemOwnedSessionIds,
      turnTimingBySessionId
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      app.log.warn({ error }, "failed to load session metadata");
    }
    return {
      titles: {},
      projects: {},
      sessionProjectById: {},
      sessionApprovalPolicyById: {},
      sessionControlsById: {},
      defaultSessionControls: defaultSessionControlsFromEnv(),
      projectAgentSessionByKey: {},
      systemOwnedSessionIds: {},
      turnTimingBySessionId: {}
    };
  }
}

async function persistSessionMetadata(): Promise<void> {
  await writeFile(sessionMetadataPath, `${JSON.stringify(sessionMetadata, null, 2)}\n`, "utf8");
}

function setSessionTitleOverride(threadId: string, title: string | null | undefined): boolean {
  const normalized = typeof title === "string" ? title.trim() : "";

  if (normalized.length === 0) {
    if (threadId in sessionMetadata.titles) {
      delete sessionMetadata.titles[threadId];
      return true;
    }
    return false;
  }

  if (sessionMetadata.titles[threadId] === normalized) {
    return false;
  }

  sessionMetadata.titles[threadId] = normalized;
  return true;
}

function normalizeProjectWorkingDirectory(input: string | null | undefined): string | null {
  if (input === null || input === undefined) {
    return null;
  }

  const normalized = input.trim();
  return normalized.length > 0 ? normalized : null;
}

function sessionScopedAgentOwnerId(sessionId: string): string {
  return `session:${sessionId}`;
}

function parseSessionScopedAgentOwnerId(ownerId: string): string | null {
  if (typeof ownerId !== "string") {
    return null;
  }
  const trimmed = ownerId.trim();
  if (!trimmed.startsWith("session:")) {
    return null;
  }
  const sessionId = trimmed.slice("session:".length).trim();
  return sessionId.length > 0 ? sessionId : null;
}

function toProjectSummary(projectId: string, project: ProjectRecord): ProjectSummary {
  return {
    projectId,
    name: project.name,
    workingDirectory: project.workingDirectory,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  };
}

function listProjectSummaries(): Array<ProjectSummary> {
  return Object.entries(sessionMetadata.projects)
    .map(([projectId, project]) => toProjectSummary(projectId, project))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function findProjectIdByName(projectName: string): string | null {
  const normalized = projectName.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  for (const [projectId, project] of Object.entries(sessionMetadata.projects)) {
    if (project.name.trim().toLowerCase() === normalized) {
      return projectId;
    }
  }

  return null;
}

function resolveSessionProjectId(sessionId: string): string | null {
  const storedProjectId = sessionMetadata.sessionProjectById[sessionId];
  if (typeof storedProjectId !== "string" || storedProjectId.trim().length === 0) {
    return null;
  }

  if (!(storedProjectId in sessionMetadata.projects)) {
    return null;
  }

  return storedProjectId;
}

function sessionControlsEqual(left: SessionControlsTuple, right: SessionControlsTuple): boolean {
  return (
    left.model === right.model &&
    left.approvalPolicy === right.approvalPolicy &&
    left.networkAccess === right.networkAccess &&
    left.filesystemSandbox === right.filesystemSandbox
  );
}

function resolveDefaultSessionControls(): SessionControlsTuple {
  const fallback = defaultSessionControlsFromEnv();
  const stored = parseSessionControlsTuple(sessionMetadata.defaultSessionControls);
  if (!stored) {
    return fallback;
  }
  return stored;
}

function resolveSessionControls(sessionId: string): SessionControlsTuple {
  const stored = parseSessionControlsTuple(sessionMetadata.sessionControlsById[sessionId]);
  if (stored) {
    return stored;
  }

  const defaultControls = resolveDefaultSessionControls();
  const legacyApproval = sessionMetadata.sessionApprovalPolicyById[sessionId];
  if (isApprovalPolicy(legacyApproval)) {
    return {
      ...defaultControls,
      approvalPolicy: legacyApproval
    };
  }

  return defaultControls;
}

function setDefaultSessionControls(nextControls: SessionControlsTuple): boolean {
  const normalizedNext = parseSessionControlsTuple(nextControls);
  if (!normalizedNext) {
    return false;
  }

  const current = resolveDefaultSessionControls();
  if (sessionControlsEqual(current, normalizedNext)) {
    return false;
  }

  sessionMetadata.defaultSessionControls = normalizedNext;
  return true;
}

function setSessionControls(sessionId: string, nextControls: SessionControlsTuple | null): boolean {
  if (nextControls === null) {
    const hadSessionControls = sessionId in sessionMetadata.sessionControlsById;
    if (hadSessionControls) {
      delete sessionMetadata.sessionControlsById[sessionId];
    }

    const hadLegacyApproval = sessionId in sessionMetadata.sessionApprovalPolicyById;
    if (hadLegacyApproval) {
      delete sessionMetadata.sessionApprovalPolicyById[sessionId];
    }
    return hadSessionControls || hadLegacyApproval;
  }

  const normalizedNext = parseSessionControlsTuple(nextControls);
  if (!normalizedNext) {
    return false;
  }

  const current = parseSessionControlsTuple(sessionMetadata.sessionControlsById[sessionId]);
  const changed = !current || !sessionControlsEqual(current, normalizedNext);
  if (changed) {
    sessionMetadata.sessionControlsById[sessionId] = normalizedNext;
  }

  const runtimeApprovalPolicy = normalizedNext.approvalPolicy;
  const approvalPolicyChanged = sessionMetadata.sessionApprovalPolicyById[sessionId] !== runtimeApprovalPolicy;
  if (approvalPolicyChanged) {
    sessionMetadata.sessionApprovalPolicyById[sessionId] = runtimeApprovalPolicy;
  }

  return changed || approvalPolicyChanged;
}

function resolveSessionApprovalPolicy(sessionId: string): ApprovalPolicy {
  return resolveSessionControls(sessionId).approvalPolicy;
}

function setSessionApprovalPolicy(sessionId: string, approvalPolicy: ApprovalPolicy | null): boolean {
  if (approvalPolicy === null) {
    return setSessionControls(sessionId, null);
  }

  const nextControls = {
    ...resolveSessionControls(sessionId),
    approvalPolicy
  };
  return setSessionControls(sessionId, nextControls);
}

function formatSessionControlsTuple(tuple: SessionControlsTuple): string {
  return `${tuple.model ?? "default"} | ${tuple.approvalPolicy} | ${tuple.networkAccess} | ${tuple.filesystemSandbox}`;
}

function appendSessionControlsAuditEntry(input: {
  sessionId: string;
  scope: SessionControlScope;
  actor: string;
  source: string;
  previous: SessionControlsTuple;
  next: SessionControlsTuple;
}): void {
  const occurredAt = new Date().toISOString();
  const eventId = `session-controls-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const previousTuple = formatSessionControlsTuple(input.previous);
  const nextTuple = formatSessionControlsTuple(input.next);
  const scopeLabel = input.scope === "default" ? "new chats default" : "this chat";
  upsertSupplementalTranscriptEntry(input.sessionId, {
    messageId: eventId,
    turnId: "session-controls",
    role: "system",
    type: "session.controls.updated",
    content: `Session controls updated (${scopeLabel}) by ${input.actor} via ${input.source}: ${previousTuple} -> ${nextTuple}`,
    details: JSON.stringify({
      occurredAt,
      actor: input.actor,
      source: input.source,
      scope: input.scope,
      previous: input.previous,
      next: input.next
    }),
    startedAt: Date.parse(occurredAt),
    completedAt: Date.parse(occurredAt),
    status: "complete"
  });
}

function sessionControlsResponse(sessionId: string): {
  sessionId: string;
  controls: SessionControlsTuple;
  defaults: SessionControlsTuple;
  defaultsEditable: boolean;
  defaultLockReason: string | null;
} {
  return {
    sessionId,
    controls: resolveSessionControls(sessionId),
    defaults: resolveDefaultSessionControls(),
    defaultsEditable: !env.SESSION_DEFAULTS_LOCKED,
    defaultLockReason: env.SESSION_DEFAULTS_LOCKED ? "Managed by harness configuration" : null
  };
}

function setSessionProjectAssignment(sessionId: string, nextProjectId: string | null): boolean {
  const currentProjectId = resolveSessionProjectId(sessionId);
  const agentMappingChanged = clearProjectAgentSessionMappingsForSession(sessionId, nextProjectId);
  const sessionScopedAgentMappingChanged = clearSessionScopedAgentSessionMappingsForSourceSession(sessionId);

  if (nextProjectId === null) {
    if (sessionId in sessionMetadata.sessionProjectById) {
      delete sessionMetadata.sessionProjectById[sessionId];
      return true;
    }
    return agentMappingChanged || sessionScopedAgentMappingChanged;
  }

  if (currentProjectId === nextProjectId) {
    return agentMappingChanged || sessionScopedAgentMappingChanged;
  }

  sessionMetadata.sessionProjectById[sessionId] = nextProjectId;
  return true;
}

function defaultSessionTitle(): string {
  return "New chat";
}

function buildProjectAgentTitle(projectName: string, agent: string): string {
  const trimmed = projectName.trim();
  const normalizedAgent = agent.trim().length > 0 ? agent.trim() : "agent";
  if (!trimmed) {
    return `Project ${normalizedAgent}`;
  }

  const cappedName = trimmed.length > 140 ? `${trimmed.slice(0, 140).trim()}...` : trimmed;
  return `${cappedName} ${normalizedAgent}`;
}

function projectAgentSessionKey(projectId: string, agent: string): string {
  return `${projectId}::${agent}`;
}

function parseProjectAgentSessionKey(key: string): { projectId: string; agent: string } | null {
  const separatorIndex = key.indexOf("::");
  if (separatorIndex <= 0 || separatorIndex >= key.length - 2) {
    return null;
  }
  const projectId = key.slice(0, separatorIndex).trim();
  const agent = key.slice(separatorIndex + 2).trim();
  if (!projectId || !agent) {
    return null;
  }
  return { projectId, agent };
}

function listProjectAgentSessionIds(projectId: string): Array<string> {
  const sessionIds = new Set<string>();
  for (const [key, sessionId] of Object.entries(sessionMetadata.projectAgentSessionByKey)) {
    if (!key.startsWith(`${projectId}::`)) {
      continue;
    }
    if (typeof sessionId === "string" && sessionId.trim().length > 0) {
      sessionIds.add(sessionId);
    }
  }
  return Array.from(sessionIds);
}

function listProjectAgentSessionMappings(projectId: string): Array<{ agent: string; sessionId: string }> {
  const mappings: Array<{ agent: string; sessionId: string }> = [];
  for (const [key, sessionId] of Object.entries(sessionMetadata.projectAgentSessionByKey)) {
    const parsed = parseProjectAgentSessionKey(key);
    if (!parsed || parsed.projectId !== projectId) {
      continue;
    }
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      continue;
    }
    mappings.push({
      agent: parsed.agent,
      sessionId
    });
  }
  return mappings;
}

function clearProjectAgentSessionMappingsForProject(projectId: string): boolean {
  let changed = false;
  for (const key of Object.keys(sessionMetadata.projectAgentSessionByKey)) {
    const parsed = parseProjectAgentSessionKey(key);
    if (!parsed || parsed.projectId !== projectId) {
      continue;
    }
    delete sessionMetadata.projectAgentSessionByKey[key];
    changed = true;
  }
  return changed;
}

function clearSessionScopedAgentSessionMappingsForSourceSession(sourceSessionId: string): boolean {
  const prefix = `${sessionScopedAgentOwnerId(sourceSessionId)}::`;
  let changed = false;
  for (const key of Object.keys(sessionMetadata.projectAgentSessionByKey)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    delete sessionMetadata.projectAgentSessionByKey[key];
    changed = true;
  }
  return changed;
}

function clearProjectAgentSessionMappingsForSession(sessionId: string, keepProjectId?: string | null): boolean {
  let changed = false;
  for (const [key, mappedSessionId] of Object.entries(sessionMetadata.projectAgentSessionByKey)) {
    if (mappedSessionId !== sessionId) {
      continue;
    }
    const parsed = parseProjectAgentSessionKey(key);
    if (parsed && keepProjectId && parsed.projectId === keepProjectId) {
      continue;
    }
    delete sessionMetadata.projectAgentSessionByKey[key];
    changed = true;
  }
  return changed;
}

function agentRootPath(agent: string): string {
  return path.join(agentsRootPath, agent);
}

function agentConfigPath(agent: string): string {
  return path.join(agentRootPath(agent), "agent.config.json");
}

async function resolveAgentRuntimePolicyConfig(agent: string): Promise<AgentRuntimePolicyConfig> {
  const defaultPolicy = defaultAgentTurnPolicyFromEnv();
  const configPath = agentConfigPath(agent);

  if (!existsSync(configPath)) {
    return {
      orientationTurnPolicy: defaultPolicy,
      instructionTurnPolicy: defaultPolicy,
      threadStartSandbox: defaultPolicy.sandbox,
      threadStartApprovalPolicy: defaultPolicy.approvalPolicy,
      model: null
    };
  }

  let parsedConfigRaw: unknown;
  try {
    const configContent = await readFile(configPath, "utf8");
    parsedConfigRaw = JSON.parse(configContent);
  } catch (error) {
    throw new Error(`failed to parse ${configPath}: ${serializeError(error)}`);
  }

  const parsed = agentRuntimePolicyFileSchema.safeParse(parsedConfigRaw);
  if (!parsed.success) {
    const issueSummary = parsed.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid ${configPath}: ${issueSummary}`);
  }

  const sharedPolicy = mergeAgentTurnPolicy(defaultPolicy, parsed.data.turnPolicy);
  const orientationTurnPolicy = mergeAgentTurnPolicy(sharedPolicy, parsed.data.orientationTurnPolicy);
  const instructionTurnPolicy = mergeAgentTurnPolicy(sharedPolicy, parsed.data.instructionTurnPolicy);

  return {
    orientationTurnPolicy,
    instructionTurnPolicy,
    threadStartSandbox: parsed.data.threadStartPolicy?.sandbox ?? instructionTurnPolicy.sandbox,
    threadStartApprovalPolicy: parsed.data.threadStartPolicy?.approvalPolicy ?? instructionTurnPolicy.approvalPolicy,
    model: parsed.data.model?.trim() ? parsed.data.model.trim() : null
  };
}

function isKnownAgent(agent: string): boolean {
  return existsSync(agentRootPath(agent));
}

async function setSessionTitle(threadId: string, title: string): Promise<void> {
  const normalized = title.trim();
  if (!normalized) {
    return;
  }

  try {
    await codexRuntime.call("thread/name/set", {
      threadId,
      name: normalized
    });
  } catch (error) {
    app.log.warn({ error, threadId }, "failed to set thread title");
  }

  if (setSessionTitleOverride(threadId, normalized)) {
    await persistSessionMetadata();
  }
}

type AgentSessionStartContext = {
  cwd: string;
  titleSeed: string;
  assignedProjectId: string | null;
};

async function resolveAgentSessionStartContext(
  projectId: string,
  sourceSessionId?: string
): Promise<AgentSessionStartContext> {
  const project = sessionMetadata.projects[projectId];
  if (project) {
    return {
      cwd: project.workingDirectory ?? env.WORKSPACE_ROOT,
      titleSeed: project.name,
      assignedProjectId: projectId
    };
  }

  const scopedSessionId = parseSessionScopedAgentOwnerId(projectId);
  if (!scopedSessionId) {
    throw new Error(`project not found: ${projectId}`);
  }

  const sourceSession = sourceSessionId && sourceSessionId.trim().length > 0 ? sourceSessionId : scopedSessionId;
  let cwd = env.WORKSPACE_ROOT;
  try {
    const read = await codexRuntime.call<{ thread: CodexThread }>("thread/read", {
      threadId: sourceSession,
      includeTurns: false
    });
    if (typeof read.thread.cwd === "string" && read.thread.cwd.trim().length > 0) {
      cwd = read.thread.cwd.trim();
    }
  } catch (error) {
    app.log.warn(
      {
        error,
        ownerProjectId: projectId,
        sourceSessionId: sourceSession
      },
      "failed to resolve source session cwd for session-scoped agent owner; falling back to workspace root"
    );
  }

  const titleSeed = sessionMetadata.titles[sourceSession] ?? `Session ${sourceSession.slice(0, 8)}`;
  return {
    cwd,
    titleSeed,
    assignedProjectId: null
  };
}

async function createProjectAgentSession(
  projectId: string,
  agent: string,
  runtimePolicy: AgentRuntimePolicyConfig,
  sourceSessionId?: string
): Promise<CodexThread> {
  const startContext = await resolveAgentSessionStartContext(projectId, sourceSessionId);
  const agentSessionKey = projectAgentSessionKey(projectId, agent);

  const startResponse = await callThreadMethodWithRawEventsFallback<{ thread: CodexThread }>("thread/start", {
    cwd: startContext.cwd,
    model: runtimePolicy.model ?? undefined,
    sandbox: runtimePolicy.threadStartSandbox,
    approvalPolicy: runtimePolicy.threadStartApprovalPolicy
  });
  const agentThread = startResponse.thread;
  if (startContext.assignedProjectId) {
    sessionMetadata.sessionProjectById[agentThread.id] = startContext.assignedProjectId;
  }
  sessionMetadata.projectAgentSessionByKey[agentSessionKey] = agentThread.id;
  setSystemOwnedSession(agentThread.id, true);
  await setSessionTitle(agentThread.id, buildProjectAgentTitle(startContext.titleSeed, agent));
  await persistSessionMetadata();
  return agentThread;
}

async function ensureProjectAgentSession(
  projectId: string,
  agent: string,
  runtimePolicy: AgentRuntimePolicyConfig,
  sourceSessionId?: string
): Promise<string> {
  const key = projectAgentSessionKey(projectId, agent);
  const inFlight = projectAgentSessionEnsureInFlightByKey.get(key);
  if (inFlight) {
    return inFlight;
  }

  const ensurePromise = (async () => {
    const mappedSessionId = sessionMetadata.projectAgentSessionByKey[key];
    if (typeof mappedSessionId === "string" && mappedSessionId.trim().length > 0) {
      const systemOwnedChanged = setSystemOwnedSession(mappedSessionId, true);
      const exists = await sessionExistsForProjectAssignment(mappedSessionId);
      if (exists) {
        if (systemOwnedChanged) {
          await persistSessionMetadata();
        }
        return mappedSessionId;
      }

      setSessionProjectAssignment(mappedSessionId, null);
      setSessionTitleOverride(mappedSessionId, null);
      delete sessionMetadata.projectAgentSessionByKey[key];
      await persistSessionMetadata();
    }

    const created = await createProjectAgentSession(projectId, agent, runtimePolicy, sourceSessionId);
    if (projectId in sessionMetadata.projects) {
      publishToSockets(
        "session_project_updated",
        {
          sessionId: created.id,
          projectId
        },
        created.id,
        { broadcastToAll: true }
      );
    }
    return created.id;
  })();

  projectAgentSessionEnsureInFlightByKey.set(key, ensurePromise);
  try {
    return await ensurePromise;
  } finally {
    projectAgentSessionEnsureInFlightByKey.delete(key);
  }
}

async function clearProjectAgentSessionMapping(projectId: string, agent: string, expectedSessionId: string): Promise<void> {
  const key = projectAgentSessionKey(projectId, agent);
  let metadataChanged = false;

  if (sessionMetadata.projectAgentSessionByKey[key] === expectedSessionId) {
    delete sessionMetadata.projectAgentSessionByKey[key];
    metadataChanged = true;
  }

  coreQueueWorkerOrientationCompletedBySession.delete(expectedSessionId);
  agentExtensionBootstrapCompletedBySession.delete(expectedSessionId);
  coreQueueWorkerOrientationInFlightBySession.delete(expectedSessionId);
  for (const inFlightKey of agentExtensionBootstrapInFlightByKey.keys()) {
    if (inFlightKey.startsWith(`${expectedSessionId}::`)) {
      agentExtensionBootstrapInFlightByKey.delete(inFlightKey);
    }
  }

  if (metadataChanged) {
    await persistSessionMetadata();
  }
}

function setSystemOwnedSession(sessionId: string, enabled: boolean): boolean {
  if (enabled) {
    if (sessionMetadata.systemOwnedSessionIds[sessionId] === true) {
      return false;
    }
    sessionMetadata.systemOwnedSessionIds[sessionId] = true;
    return true;
  }

  if (sessionId in sessionMetadata.systemOwnedSessionIds) {
    delete sessionMetadata.systemOwnedSessionIds[sessionId];
    return true;
  }

  return false;
}

function isSystemOwnedSession(sessionId: string): boolean {
  return sessionMetadata.systemOwnedSessionIds[sessionId] === true;
}

function listSessionIdsForProject(projectId: string, options?: { includeSystemOwned?: boolean }): Array<string> {
  const includeSystemOwned = options?.includeSystemOwned === true;
  const sessionIds: Array<string> = [];
  for (const [sessionId, assignedProjectId] of Object.entries(sessionMetadata.sessionProjectById)) {
    if (assignedProjectId === projectId) {
      if (!includeSystemOwned && isSystemOwnedSession(sessionId)) {
        continue;
      }
      sessionIds.push(sessionId);
    }
  }
  return sessionIds;
}

function resolveSessionTitle(thread: CodexThread): string {
  const storedTitle = sessionMetadata.titles[thread.id];
  if (typeof storedTitle === "string" && storedTitle.trim().length > 0) {
    return storedTitle.trim();
  }

  const maybeNamedThread = thread as CodexThread & { threadName?: unknown; name?: unknown };
  if (typeof maybeNamedThread.threadName === "string" && maybeNamedThread.threadName.trim().length > 0) {
    return maybeNamedThread.threadName.trim();
  }

  if (typeof maybeNamedThread.name === "string" && maybeNamedThread.name.trim().length > 0) {
    return maybeNamedThread.name.trim();
  }

  return thread.preview?.trim() || "New chat";
}

function toSessionSummary(thread: CodexThread, materialized = true): SessionSummary {
  const sessionControls = resolveSessionControls(thread.id);
  return {
    sessionId: thread.id,
    title: resolveSessionTitle(thread),
    materialized,
    modelProvider: thread.modelProvider,
    approvalPolicy: resolveSessionApprovalPolicy(thread.id),
    sessionControls,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    cwd: thread.cwd,
    source: sourceLabel(thread.source),
    projectId: resolveSessionProjectId(thread.id)
  };
}

function userInputToText(input: { type: string; text?: string; url?: string; path?: string }): string {
  if (input.type === "text") {
    return input.text ?? "";
  }
  if (input.type === "image") {
    return `[image] ${input.url ?? ""}`;
  }
  if (input.type === "localImage") {
    return `[localImage] ${input.path ?? ""}`;
  }
  if (input.type === "skill") {
    return `[skill] ${input.path ?? ""}`;
  }
  if (input.type === "mention") {
    return `[mention] ${input.path ?? ""}`;
  }
  return `[${input.type}]`;
}

function stringifyDetails(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

function summarizeSystemItem(item: CodexThreadItem): { summary: string; details?: string } {
  if (item.type === "commandExecution") {
    const command = typeof item.command === "string" ? item.command : "(unknown command)";
    const status = typeof item.status === "string" ? item.status : "unknown";
    return {
      summary: `Command execution ${status}: ${command}`,
      details: stringifyDetails(item)
    };
  }

  if (item.type === "fileChange") {
    const status = typeof item.status === "string" ? item.status : "unknown";
    const changes = Array.isArray(item.changes) ? item.changes.length : 0;
    return {
      summary: `File change ${status}: ${changes} change${changes === 1 ? "" : "s"}`,
      details: stringifyDetails(item)
    };
  }

  if (item.type === "mcpToolCall") {
    const server = typeof item.server === "string" ? item.server : "unknown-server";
    const tool = typeof item.tool === "string" ? item.tool : "unknown-tool";
    const status = typeof item.status === "string" ? item.status : "unknown";
    return {
      summary: `Tool ${server}/${tool} ${status}`,
      details: stringifyDetails(item)
    };
  }

  if (item.type === "reasoning") {
    return {
      summary: "Reasoning update",
      details: stringifyDetails(item)
    };
  }

  if (item.type === "plan") {
    const text = typeof item.text === "string" ? item.text : "";
    return {
      summary: text ? `Plan: ${text}` : "Plan update",
      details: stringifyDetails(item)
    };
  }

  return {
    summary: `[${item.type}]`,
    details: stringifyDetails(item)
  };
}

function resolveTurnTiming(sessionId: string, turn: CodexTurn): TurnTimingRecord | null {
  const stored = lookupTurnTiming(sessionId, turn.id);
  const startedAt =
    coerceEpochMs(turn.startedAt) ??
    coerceEpochMs(turn.started_at) ??
    coerceEpochMs(turn.startTime) ??
    coerceEpochMs(turn.start_time) ??
    stored?.startedAt ??
    null;
  const completedAt =
    coerceEpochMs(turn.completedAt) ??
    coerceEpochMs(turn.completed_at) ??
    coerceEpochMs(turn.endTime) ??
    coerceEpochMs(turn.end_time) ??
    stored?.completedAt ??
    null;

  if (startedAt === null && completedAt === null) {
    return null;
  }

  if (startedAt === null && completedAt !== null) {
    return {
      startedAt: completedAt,
      completedAt
    };
  }

  if (startedAt !== null && completedAt !== null && completedAt >= startedAt) {
    return {
      startedAt,
      completedAt
    };
  }

  return startedAt !== null
    ? {
        startedAt
      }
    : null;
}

function itemToTranscriptEntry(turnId: string, item: CodexThreadItem, turnTiming?: TurnTimingRecord): TranscriptEntry {
  const baseTiming =
    turnTiming && typeof turnTiming.startedAt === "number"
      ? {
          startedAt: turnTiming.startedAt,
          ...(typeof turnTiming.completedAt === "number" ? { completedAt: turnTiming.completedAt } : {})
        }
      : {};

  if (item.type === "userMessage") {
    const contentItems = Array.isArray(item.content)
      ? (item.content as Array<{ type?: unknown; text?: unknown; url?: unknown; path?: unknown }>)
      : [];

    return {
      messageId: item.id,
      turnId,
      role: "user",
      type: item.type,
      ...baseTiming,
      content: contentItems
        .map((value) =>
          userInputToText({
            type: typeof value.type === "string" ? value.type : "text",
            text: typeof value.text === "string" ? value.text : undefined,
            url: typeof value.url === "string" ? value.url : undefined,
            path: typeof value.path === "string" ? value.path : undefined
          })
        )
        .join("\n")
        .trim(),
      status: "complete"
    };
  }

  if (item.type === "agentMessage") {
    const text = typeof item.text === "string" ? item.text : "";
    return {
      messageId: item.id,
      turnId,
      role: "assistant",
      type: item.type,
      ...baseTiming,
      content: text,
      status: "complete"
    };
  }

  const systemSummary = summarizeSystemItem(item);
  return {
    messageId: item.id,
    turnId,
    role: "system",
    type: item.type,
    ...baseTiming,
    content: systemSummary.summary,
    details: systemSummary.details,
    status: "complete"
  };
}

function turnsToTranscript(sessionId: string, turns: Array<CodexTurn>): Array<TranscriptEntry> {
  const entries: Array<TranscriptEntry> = [];

  for (const turn of turns) {
    const turnTiming = resolveTurnTiming(sessionId, turn) ?? undefined;
    for (const item of turn.items) {
      entries.push(itemToTranscriptEntry(turn.id, item, turnTiming));
    }
  }

  return entries;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return message.includes("abort");
  }

  if (typeof error === "string") {
    return error.toLowerCase().includes("abort");
  }

  return false;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  throw new Error("orchestrator job aborted");
}

async function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);

  if (!signal) {
    await delay(ms);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("orchestrator job aborted"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isTurnStillRunning(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  if (!normalized) {
    // Unknown status should be treated as still running so we never advance early.
    return true;
  }

  return (
    normalized !== "completed" &&
    normalized !== "failed" &&
    normalized !== "error" &&
    normalized !== "interrupted" &&
    normalized !== "cancelled" &&
    normalized !== "canceled"
  );
}

function latestAgentMessageFromTurn(turn: CodexTurn): string | null {
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item?.type !== "agentMessage") {
      continue;
    }

    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (text.length > 0) {
      return text;
    }
  }

  return null;
}

type FileChangeEventPayload = {
  threadId: string;
  turnId: string;
  itemId: string;
  projectId: string;
  sourceSessionId: string;
  approvalId?: string;
  summary: string;
  details: string;
  anchorItemId: string;
};

function turnEventKey(threadId: string, turnId: string): string {
  return `${threadId}::${turnId}`;
}

function noteFileChangeEventAnchor(input: { threadId: string; turnId: string; anchor: string }): void {
  const normalizedAnchor = input.anchor.trim();
  if (!normalizedAnchor) {
    return;
  }
  const key = turnEventKey(input.threadId, input.turnId);
  const anchors = fileChangeEventAnchorsByTurn.get(key) ?? new Set<string>();
  anchors.add(normalizedAnchor);
  fileChangeEventAnchorsByTurn.set(key, anchors);
}

function getFileChangeEventCount(threadId: string, turnId: string): number {
  return fileChangeEventAnchorsByTurn.get(turnEventKey(threadId, turnId))?.size ?? 0;
}

function clearFileChangeEventCount(threadId: string, turnId: string): void {
  fileChangeEventAnchorsByTurn.delete(turnEventKey(threadId, turnId));
}

function clearFileChangeEventsForThread(threadId: string): void {
  const prefix = `${threadId}::`;
  for (const key of fileChangeEventAnchorsByTurn.keys()) {
    if (key.startsWith(prefix)) {
      fileChangeEventAnchorsByTurn.delete(key);
    }
  }
}

function parseFileChangeMethodFromTranscriptDetails(details: string | undefined): string | null {
  if (typeof details !== "string" || details.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(details) as unknown;
    if (isObjectRecord(parsed) && typeof parsed.method === "string" && parsed.method.trim().length > 0) {
      return parsed.method;
    }
  } catch {
    // Ignore malformed details payloads and treat as not-recoverable for method inference.
  }
  return null;
}

function recoverFileChangeCountFromSupplemental(threadId: string, turnId: string): number {
  const entries = listSupplementalTranscriptEntries(threadId)
    .map((entry) => entry.entry)
    .filter((entry) => entry.turnId === turnId && entry.type === "approval.request");

  let count = 0;
  for (const entry of entries) {
    if (parseFileChangeMethodFromTranscriptDetails(entry.details) === "item/fileChange/requestApproval") {
      count += 1;
    }
  }
  return count;
}

function transcriptLineForEventContext(entry: TranscriptEntry): string {
  const roleLabel = entry.role.toUpperCase();
  const content = entry.content.replace(/\s+/g, " ").trim();
  return content.length > 0 ? `${roleLabel} [${entry.type}]: ${content}` : `${roleLabel} [${entry.type}]`;
}

function sliceEntriesThroughMessage(entries: Array<TranscriptEntry>, messageId: string): Array<TranscriptEntry> {
  const normalized = messageId.trim();
  if (!normalized) {
    return entries;
  }
  const index = entries.findIndex((entry) => entry.messageId === normalized);
  return index >= 0 ? entries.slice(0, index + 1) : entries;
}

function truncateForEvent(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n... (truncated)`;
}

function normalizeChangeRecords(input: unknown): {
  normalizedChanges: Array<Record<string, unknown>>;
  hasAnyDiff: boolean;
} {
  const changes = Array.isArray(input) ? input : [];
  const normalizedChanges: Array<Record<string, unknown>> = [];
  let hasAnyDiff = false;
  for (const change of changes) {
    if (!isObjectRecord(change)) {
      continue;
    }
    const normalized: Record<string, unknown> = {};
    if (typeof change.path === "string" && change.path.trim().length > 0) {
      normalized.path = change.path.trim();
    }
    if (change.kind !== undefined) {
      normalized.kind = change.kind;
    }
    if (typeof change.diff === "string" && change.diff.length > 0) {
      normalized.diff = change.diff;
      hasAnyDiff = true;
    }
    normalizedChanges.push(normalized);
  }
  return {
    normalizedChanges,
    hasAnyDiff
  };
}

function parseDetailsObject(details: string | undefined): Record<string, unknown> | null {
  if (typeof details !== "string" || details.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(details) as unknown;
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractChangeCandidate(details: Record<string, unknown> | null): unknown {
  if (!details) {
    return undefined;
  }
  if (Array.isArray(details.changes)) {
    return details.changes;
  }
  if (isObjectRecord(details.item) && Array.isArray(details.item.changes)) {
    return details.item.changes;
  }
  if (isObjectRecord(details.fileChange) && Array.isArray(details.fileChange.changes)) {
    return details.fileChange.changes;
  }
  return undefined;
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveFileChangeRecordsFromApproval(approval: PendingApprovalRecord): {
  normalizedChanges: Array<Record<string, unknown>>;
  itemId: string | null;
  turnId: string | null;
} | null {
  const resolveCandidate = (input: { changes: unknown; itemId: string | null; turnId: string | null }) => {
    const { normalizedChanges, hasAnyDiff } = normalizeChangeRecords(input.changes);
    if (normalizedChanges.length === 0 || !hasAnyDiff) {
      return null;
    }
    return {
      normalizedChanges,
      itemId: input.itemId,
      turnId: input.turnId
    };
  };

  const approvalDetails = isObjectRecord(approval.details) ? approval.details : null;
  const directCandidate = resolveCandidate({
    changes: extractChangeCandidate(approvalDetails),
    itemId: normalizeNonEmptyString(approval.itemId) ?? normalizeNonEmptyString(extractItemId(approval.details)),
    turnId: normalizeNonEmptyString(approval.turnId) ?? normalizeNonEmptyString(extractTurnId(approval.details))
  });
  if (directCandidate) {
    return directCandidate;
  }

  const targetItemId = normalizeNonEmptyString(approval.itemId) ?? normalizeNonEmptyString(extractItemId(approval.details));
  const targetTurnId = normalizeNonEmptyString(approval.turnId) ?? normalizeNonEmptyString(extractTurnId(approval.details));
  if (!targetItemId && !targetTurnId) {
    return null;
  }

  const supplementalEntries = listSupplementalTranscriptEntries(approval.threadId);
  for (let index = supplementalEntries.length - 1; index >= 0; index -= 1) {
    const entry = supplementalEntries[index]?.entry;
    if (!entry || entry.type !== "fileChange") {
      continue;
    }
    if (targetItemId && entry.messageId !== targetItemId) {
      continue;
    }
    if (!targetItemId && targetTurnId && entry.turnId !== targetTurnId) {
      continue;
    }

    const parsed = parseDetailsObject(entry.details);
    const candidate = resolveCandidate({
      changes: extractChangeCandidate(parsed),
      itemId: normalizeNonEmptyString(entry.messageId),
      turnId: normalizeNonEmptyString(entry.turnId)
    });
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function buildFileChangeEventPayloadFromApproval(approval: PendingApprovalRecord): FileChangeEventPayload | null {
  if (approval.method !== "item/fileChange/requestApproval" || isSystemOwnedSession(approval.threadId)) {
    return null;
  }

  const projectId = resolveSessionProjectId(approval.threadId);
  if (!projectId) {
    return null;
  }

  const resolved = resolveFileChangeRecordsFromApproval(approval);
  if (!resolved) {
    return null;
  }

  const fallbackItemId = `approval-${approval.approvalId}`;
  const itemId = normalizeNonEmptyString(approval.itemId) ?? resolved.itemId ?? fallbackItemId;
  const turnId = normalizeNonEmptyString(approval.turnId) ?? resolved.turnId ?? "approval";

  const summary = `File change awaiting approval: ${resolved.normalizedChanges.length} change${resolved.normalizedChanges.length === 1 ? "" : "s"}`;
  const details = truncateForEvent(
    JSON.stringify(
      {
        status: "pending_approval",
        changes: resolved.normalizedChanges
      },
      null,
      2
    ),
    50_000
  );

  return {
    threadId: approval.threadId,
    turnId,
    itemId,
    projectId,
    sourceSessionId: approval.threadId,
    approvalId: approval.approvalId,
    summary,
    details,
    anchorItemId: itemId
  };
}

async function loadTurnContextForFileChangeEvent(
  payload: FileChangeEventPayload,
  signal?: AbortSignal
): Promise<{ userRequest: string; turnTranscript: string }> {
  const supplementalEntries = sliceEntriesThroughMessage(
    listSupplementalTranscriptEntries(payload.threadId)
      .filter((entry) => entry.entry.turnId === payload.turnId)
      .map((entry) => entry.entry),
    payload.itemId
  );
  const supplementalUser = supplementalEntries.find((entry) => entry.role === "user" && entry.content.trim().length > 0);
  let userRequest = supplementalUser?.content.trim() ?? "User request unavailable for this turn.";
  let turnTranscript =
    supplementalEntries.length > 0
      ? supplementalEntries.map((entry) => transcriptLineForEventContext(entry)).join("\n")
      : "Turn transcript unavailable for this turn.";

  try {
    throwIfAborted(signal);
    const response = await codexRuntime.call<{ thread: CodexThread }>("thread/read", {
      threadId: payload.threadId,
      includeTurns: true
    });
    throwIfAborted(signal);
    const turn = response.thread.turns.find((entry) => entry.id === payload.turnId);
    if (turn) {
      const merged = sliceEntriesThroughMessage(
        mergeTranscriptWithSupplemental(payload.threadId, turnsToTranscript(payload.threadId, [turn])).filter(
          (entry) => entry.turnId === payload.turnId
        ),
        payload.itemId
      );
      if (merged.length > 0) {
        const userEntry = merged.find((entry) => entry.role === "user" && entry.content.trim().length > 0);
        if (userEntry) {
          userRequest = userEntry.content.trim();
        }
        turnTranscript = merged.map((entry) => transcriptLineForEventContext(entry)).join("\n");
      }
    }
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      throw error;
    }
  }

  return {
    userRequest: truncateForEvent(userRequest, 8_000),
    turnTranscript: truncateForEvent(turnTranscript, 24_000)
  };
}

async function enqueueFileChangeReviewEventFromApproval(
  approval: PendingApprovalRecord,
  source: "approval_request" | "approvals_reconcile"
): Promise<void> {
  if (!orchestratorQueue || approval.method !== "item/fileChange/requestApproval") {
    return;
  }

  const payload = buildFileChangeEventPayloadFromApproval(approval);
  if (!payload) {
    return;
  }
  noteFileChangeEventAnchor({
    threadId: payload.threadId,
    turnId: payload.turnId,
    anchor: payload.anchorItemId
  });

  const context = await loadTurnContextForFileChangeEvent(payload).catch(() => ({
    userRequest: "User request unavailable for this turn.",
    turnTranscript: "Turn transcript unavailable for this turn."
  }));

  const results = await emitAgentEvent("file_change.approval_requested", {
    context: {
      projectId: payload.projectId,
      sourceSessionId: payload.sourceSessionId,
      threadId: payload.threadId,
      turnId: payload.turnId,
      itemId: payload.itemId,
      approvalId: payload.approvalId ?? null,
      anchorItemId: payload.anchorItemId,
      userRequest: context.userRequest,
      turnTranscript: context.turnTranscript
    },
    summary: payload.summary,
    details: payload.details,
    sourceEvent: source,
    fileChangeStatus: "pending_approval"
  });

  if (!selectEnqueueResultFromAgentEvent(results)) {
    app.log.warn(
      {
        threadId: approval.threadId,
        turnId: approval.turnId,
        itemId: approval.itemId,
        approvalId: approval.approvalId,
        source
      },
      "file-change review event emitted but no queue enqueue result was returned"
    );
  }
}

async function loadTurnContextForTurnCompletedEvent(
  threadId: string,
  turnId: string,
  signal?: AbortSignal
): Promise<{ userRequest: string; transcript: string }> {
  const supplementalEntries = listSupplementalTranscriptEntries(threadId)
    .map((entry) => entry.entry)
    .filter((entry) => entry.turnId === turnId);
  const supplementalUser = supplementalEntries.find((entry) => entry.role === "user" && entry.content.trim().length > 0);
  let userRequest = supplementalUser?.content.trim() ?? "User request unavailable for this turn.";
  let transcript =
    supplementalEntries.length > 0
      ? supplementalEntries.map((entry) => transcriptLineForEventContext(entry)).join("\n")
      : "Turn transcript unavailable for this turn.";

  try {
    throwIfAborted(signal);
    const response = await codexRuntime.call<{ thread: CodexThread }>("thread/read", {
      threadId,
      includeTurns: true
    });
    throwIfAborted(signal);
    const turns = Array.isArray(response.thread.turns) ? response.thread.turns : [];
    const turn = turns.find((entry) => entry.id === turnId);
    if (turn) {
      const merged = mergeTranscriptWithSupplemental(threadId, turnsToTranscript(threadId, [turn])).filter(
        (entry) => entry.turnId === turnId
      );
      if (merged.length > 0) {
        const userEntry = merged.find((entry) => entry.role === "user" && entry.content.trim().length > 0);
        if (userEntry) {
          userRequest = userEntry.content.trim();
        }
        transcript = merged.map((entry) => transcriptLineForEventContext(entry)).join("\n");
      }
    }
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      throw error;
    }
  }

  return {
    userRequest: truncateForEvent(userRequest, 8_000),
    transcript: truncateForEvent(transcript, 40_000)
  };
}

function maybeEmitTurnCompletedAgentEvent(threadId: string, turnId: string): void {
  const projectId = resolveSessionProjectId(threadId);
  if (!projectId) {
    return;
  }
  const trackedFileChangeCount = getFileChangeEventCount(threadId, turnId);
  const recoveredFileChangeCount = trackedFileChangeCount > 0 ? trackedFileChangeCount : recoverFileChangeCountFromSupplemental(threadId, turnId);
  const fileChangeCount = Math.max(trackedFileChangeCount, recoveredFileChangeCount);
  if (fileChangeCount <= 0) {
    return;
  }

  const dispatchKey = turnEventKey(threadId, turnId);
  if (turnCompletedEventDispatchInFlight.has(dispatchKey)) {
    return;
  }
  turnCompletedEventDispatchInFlight.add(dispatchKey);

  const maxAttempts = 3;
  void (async () => {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const snapshot = await loadTurnContextForTurnCompletedEvent(threadId, turnId).catch(() => ({
        userRequest: "User request unavailable for this turn.",
        transcript: "Turn transcript unavailable for this turn."
      }));

      try {
        const results = await emitAgentEvent("turn.completed", {
          context: {
            projectId,
            sourceSessionId: threadId,
            threadId,
            turnId,
            userRequest: snapshot.userRequest
          },
          hadFileChangeRequests: true,
          turnTranscriptSnapshot: snapshot.transcript,
          fileChangeRequestCount: fileChangeCount
        });
        if (results.length > 0 && !hasActionableTurnCompletedEventResult(results)) {
          throw new Error("turn.completed event had handlers but no actionable enqueue/action result");
        }
        clearFileChangeEventCount(threadId, turnId);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          await delay(60 * attempt);
        }
      }
    }

    app.log.warn(
      {
        error: lastError,
        threadId,
        turnId,
        projectId,
        attempts: maxAttempts
      },
      "failed to emit turn.completed agent event after retries"
    );
    clearFileChangeEventCount(threadId, turnId);
  })()
    .catch((error) => {
      app.log.warn({ error, threadId, turnId, projectId }, "unexpected failure while dispatching turn.completed agent event");
      clearFileChangeEventCount(threadId, turnId);
    })
    .finally(() => {
      turnCompletedEventDispatchInFlight.delete(dispatchKey);
    });
}

function hasActionableTurnCompletedEventResult(results: Array<AgentEventEmitResult>): boolean {
  if (selectEnqueueResultFromAgentEvent(results)) {
    return true;
  }

  return results.some(
    (result) =>
      result.kind === "action_result" &&
      (result.status === "performed" ||
        result.status === "already_resolved" ||
        result.status === "not_eligible" ||
        result.status === "conflict")
  );
}

function buildFallbackSuggestedRequest(contextEntries: Array<TranscriptEntry>, draft?: string): string {
  const cleanedDraft = typeof draft === "string" ? draft.trim() : "";
  if (cleanedDraft.length > 0) {
    return cleanedDraft;
  }
  const lastUser = [...contextEntries].reverse().find((entry) => entry.role === "user" && entry.content.trim().length > 0);
  if (lastUser) {
    const request = lastUser.content.replace(/\s+/g, " ").trim().slice(0, 220);
    return `Please continue from your last response and focus on this request: ${request}`;
  }
  const lastAssistant = [...contextEntries]
    .reverse()
    .find((entry) => entry.role === "assistant" && entry.content.trim().length > 0);
  if (lastAssistant) {
    const summarized = lastAssistant.content.replace(/\s+/g, " ").trim().slice(0, 260);
    return `Please continue from your last response and focus on the concrete next step. (${summarized})`;
  }
  return "Please continue with the next concrete step and include exact commands or code changes.";
}

function suggestionContextEntriesFromTranscript(transcript: Array<TranscriptEntry>): Array<TranscriptEntry> {
  return transcript
    .filter((entry) => (entry.role === "user" || entry.role === "assistant") && entry.content.trim().length > 0);
}

async function loadSuggestionContext(sessionId: string): Promise<Array<TranscriptEntry>> {
  try {
    const source = await codexRuntime.call<{ thread: CodexThread }>("thread/read", {
      threadId: sessionId,
      includeTurns: true
    });
    const transcript = mergeTranscriptWithSupplemental(
      sessionId,
      turnsToTranscript(sessionId, Array.isArray(source.thread.turns) ? source.thread.turns : [])
    );
    return suggestionContextEntriesFromTranscript(transcript);
  } catch (error) {
    if (!isIncludeTurnsUnavailableError(error)) {
      throw error;
    }
    const transcript = mergeTranscriptWithSupplemental(sessionId, []);
    return suggestionContextEntriesFromTranscript(transcript);
  }
}

function suggestionQueueProjectId(sessionId: string): string {
  const projectId = resolveSessionProjectId(sessionId);
  return projectId ?? sessionScopedAgentOwnerId(sessionId);
}

function suggestionTurnIdForSession(sessionId: string): string {
  return activeTurnByThread.get(sessionId) ?? "suggest-request";
}

function suggestedRequestStateKey(sessionId: string, requestKey: string): string {
  return `${sessionId}::${requestKey}`;
}

function pruneSuggestedRequestState(): void {
  while (suggestedRequestStateByRequestKey.size > MAX_SUGGESTED_REQUEST_STATE_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestUpdatedAt = Number.POSITIVE_INFINITY;
    for (const [requestKey, state] of suggestedRequestStateByRequestKey.entries()) {
      if (state.updatedAt < oldestUpdatedAt) {
        oldestUpdatedAt = state.updatedAt;
        oldestKey = requestKey;
      }
    }
    if (!oldestKey) {
      break;
    }
    suggestedRequestStateByRequestKey.delete(oldestKey);
  }
}

function upsertSuggestedRequestRuntimeState(input: {
  sessionId: string;
  requestKey: string;
  status: SuggestedRequestRuntimeStateStatus;
  suggestion?: string;
  error?: string;
}): SuggestedRequestRuntimeState {
  const key = suggestedRequestStateKey(input.sessionId, input.requestKey);
  const existing = suggestedRequestStateByRequestKey.get(key) ?? null;
  const status = input.status;
  const suggestion = typeof input.suggestion === "string" ? input.suggestion.trim() : "";
  const error = typeof input.error === "string" ? input.error.trim() : "";
  if (existing && (existing.status === "complete" || existing.status === "error" || existing.status === "canceled") && status === "streaming") {
    return existing;
  }

  const next: SuggestedRequestRuntimeState = {
    sessionId: input.sessionId,
    requestKey: input.requestKey,
    status,
    suggestion: suggestion.length > 0 ? suggestion : existing?.suggestion ?? null,
    error: error.length > 0 ? error : status === "error" ? existing?.error ?? "suggested request generation failed" : null,
    updatedAt: Date.now()
  };
  suggestedRequestStateByRequestKey.set(key, next);
  pruneSuggestedRequestState();

  publishToSockets(
    "suggested_request_updated",
    {
      sessionId: next.sessionId,
      requestKey: next.requestKey,
      status: next.status,
      ...(next.suggestion ? { suggestion: next.suggestion } : {}),
      ...(next.error ? { error: next.error } : {})
    },
    next.sessionId
  );

  return next;
}

function readSuggestedRequestRuntimeState(sessionId: string, requestKey: string): SuggestedRequestRuntimeState | null {
  return suggestedRequestStateByRequestKey.get(suggestedRequestStateKey(sessionId, requestKey)) ?? null;
}

function formatSuggestionContext(entries: Array<TranscriptEntry>): { userRequest: string; transcript: string } {
  const userRequest =
    [...entries].reverse().find((entry) => entry.role === "user" && entry.content.trim().length > 0)?.content ??
    "User request unavailable.";
  const transcript =
    entries.map((entry, index) => `${index + 1}. ${entry.role}: ${entry.content}`).join("\n").trim() ||
    "No transcript context available.";
  return { userRequest, transcript };
}

async function enqueueSuggestedRequestViaAgentEvent(input: {
  sessionId: string;
  projectId: string;
  requestKey: string;
  model?: string;
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  draft?: string;
}): Promise<AgentEventEnqueueResult> {
  const contextEntries = await loadSuggestionContext(input.sessionId).catch(() => []);
  const context = formatSuggestionContext(contextEntries);
  const results = await emitAgentEvent("suggest_request.requested", {
    requestKey: input.requestKey,
    sessionId: input.sessionId,
    projectId: input.projectId,
    threadId: input.sessionId,
    turnId: suggestionTurnIdForSession(input.sessionId),
    userRequest: context.userRequest,
    turnTranscript: context.transcript,
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.draft ? { draft: input.draft } : {})
  });

  const enqueue = selectEnqueueResultFromAgentEvent(results);
  if (!enqueue) {
    throw new OrchestratorQueueError(
      "job_conflict",
      "no agent handler enqueued a suggest_request job for suggest_request.requested",
      409
    );
  }
  return enqueue;
}

async function generateSuggestedRequestForJob(
  payload: SuggestRequestJobPayload,
  options?: {
    signal?: AbortSignal;
    onTurnStarted?: (threadId: string, turnId: string) => void;
  }
): Promise<SuggestRequestJobResult> {
  suggestedRequestStateByRequestKey.delete(suggestedRequestStateKey(payload.sessionId, payload.requestKey));
  await runAgentInstructionJob(
    {
      agent: payload.agent,
      jobKind: "suggest_request",
      projectId: payload.projectId,
      sourceSessionId: payload.sessionId,
      threadId: payload.sourceThreadId,
      turnId: payload.sourceTurnId,
      bootstrapInstruction: payload.bootstrapInstruction,
      instructionText: payload.instructionText,
      expectResponse: "none"
    },
    options
  );

  const state = readSuggestedRequestRuntimeState(payload.sessionId, payload.requestKey);
  const suggestion = state?.status === "complete" && typeof state.suggestion === "string" ? state.suggestion.trim() : "";
  if (suggestion) {
    return {
      suggestion,
      requestKey: payload.requestKey
    };
  }

  return {
    suggestion: buildFallbackSuggestedRequest([], payload.draft),
    requestKey: payload.requestKey
  };
}

type AgentOutputUpdate = {
  text: string;
  status: "streaming" | "complete";
};

function normalizeAgentOutputText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 12_000) {
    return trimmed;
  }
  return `${trimmed.slice(0, 12_000)}\n\n[truncated]`;
}

function agentTurnFailedError(outputText: string | null | undefined): Error {
  const normalized = typeof outputText === "string" ? normalizeAgentOutputText(outputText).trim() : "";
  if (normalized.length === 0) {
    return new Error("agent turn failed");
  }
  const capped = normalized.length > 400 ? `${normalized.slice(0, 400)}...` : normalized;
  return new Error(`agent turn failed: ${capped}`);
}

function runtimeObservedTurnKey(threadId: string, turnId: string): string {
  return `${threadId}::${turnId}`;
}

function emitRuntimeTurnSignal(threadId: string, turnId: string): void {
  const key = runtimeObservedTurnKey(threadId, turnId);
  const waiters = runtimeTurnSignalWaitersByKey.get(key);
  if (!waiters || waiters.size === 0) {
    return;
  }
  runtimeTurnSignalWaitersByKey.delete(key);
  for (const waiter of waiters) {
    waiter();
  }
}

function observeRuntimeTurnState(
  threadId: string,
  turnId: string,
  mutator: (state: RuntimeObservedTurnState) => void
): RuntimeObservedTurnState {
  const key = runtimeObservedTurnKey(threadId, turnId);
  const existing = runtimeObservedTurnsByKey.get(key);
  const baseline: RuntimeObservedTurnState =
    existing ?? {
      threadId,
      turnId,
      status: "running",
      assistantText: "",
      updatedAt: Date.now()
    };
  mutator(baseline);
  baseline.updatedAt = Date.now();
  runtimeObservedTurnsByKey.set(key, baseline);
  if (runtimeObservedTurnsByKey.size > 2_000) {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [candidateKey, state] of runtimeObservedTurnsByKey.entries()) {
      if (state.updatedAt < oldestAt) {
        oldestAt = state.updatedAt;
        oldestKey = candidateKey;
      }
    }
    if (oldestKey) {
      runtimeObservedTurnsByKey.delete(oldestKey);
      runtimeTurnSignalWaitersByKey.delete(oldestKey);
    }
  }
  emitRuntimeTurnSignal(threadId, turnId);
  return baseline;
}

function markRuntimeTurnStarted(threadId: string, turnId: string): void {
  observeRuntimeTurnState(threadId, turnId, (state) => {
    state.status = "running";
    state.assistantText = "";
  });
}

function markRuntimeTurnSettled(threadId: string, turnId: string, status: RuntimeObservedTurnStatus): void {
  observeRuntimeTurnState(threadId, turnId, (state) => {
    state.status = status;
  });
}

function setRuntimeTurnAssistantText(threadId: string, turnId: string, text: string): void {
  observeRuntimeTurnState(threadId, turnId, (state) => {
    state.assistantText = text;
  });
}

function appendRuntimeTurnAssistantDelta(threadId: string, turnId: string, delta: string): void {
  observeRuntimeTurnState(threadId, turnId, (state) => {
    state.assistantText = `${state.assistantText}${delta}`;
  });
}

function runtimeStatusFromTurnStatus(status: string): RuntimeObservedTurnStatus {
  if (isTurnStillRunning(status)) {
    return "running";
  }
  const normalized = status.trim().toLowerCase();
  if (normalized === "failed" || normalized === "error") {
    return "failed";
  }
  return "completed";
}

function runtimeTurnStateFromStore(threadId: string, turnId: string): RuntimeObservedTurnState | null {
  return runtimeObservedTurnsByKey.get(runtimeObservedTurnKey(threadId, turnId)) ?? null;
}

function canTrustThreadReadTerminalStatus(threadId: string, turnId: string): boolean {
  if (!isSystemOwnedSession(threadId)) {
    return true;
  }

  const activeTurnId = activeTurnByThread.get(threadId);
  if (!activeTurnId) {
    return true;
  }

  return activeTurnId !== turnId;
}

function shouldPollThreadForRuntimeTurn(threadId: string, observed: RuntimeObservedTurnState | null): boolean {
  if (!isSystemOwnedSession(threadId)) {
    return true;
  }
  if (!observed) {
    return true;
  }
  if (observed.status !== "running") {
    return true;
  }
  return Date.now() - observed.updatedAt >= env.ORCHESTRATOR_AGENT_POLL_INTERVAL_MS;
}

async function waitForRuntimeTurnSignal(threadId: string, turnId: string, waitMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const boundedWaitMs = Math.max(0, waitMs);
  if (boundedWaitMs === 0) {
    return;
  }

  const key = runtimeObservedTurnKey(threadId, turnId);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      const waiters = runtimeTurnSignalWaitersByKey.get(key);
      if (waiters) {
        waiters.delete(onSignal);
        if (waiters.size === 0) {
          runtimeTurnSignalWaitersByKey.delete(key);
        }
      }
    };

    const onSignal = (): void => {
      cleanup();
      resolve();
    };

    const onAbort = (): void => {
      cleanup();
      reject(new Error("orchestrator job aborted"));
    };

    const waiters = runtimeTurnSignalWaitersByKey.get(key) ?? new Set<() => void>();
    waiters.add(onSignal);
    runtimeTurnSignalWaitersByKey.set(key, waiters);

    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, boundedWaitMs);

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function observeRuntimeTurnNotification(notification: JsonRpcNotification, extractedThreadId?: string): void {
  const params = notification.params;
  const fallbackThreadId = extractedThreadId;

  if (notification.method === "turn/started") {
    const threadId = fallbackThreadId;
    const turnId = extractTurnId(params);
    if (threadId && turnId) {
      markRuntimeTurnStarted(threadId, turnId);
    }
    return;
  }

  if (notification.method === "turn/completed" || notification.method === "turn/failed") {
    const threadId = fallbackThreadId;
    const turnId = extractTurnId(params);
    if (threadId && turnId) {
      markRuntimeTurnSettled(threadId, turnId, notification.method === "turn/failed" ? "failed" : "completed");
    }
    return;
  }

  if (
    (notification.method === "item/started" || notification.method === "item/completed") &&
    fallbackThreadId &&
    isObjectRecord(params) &&
    isObjectRecord(params.item) &&
    params.item.type === "agentMessage"
  ) {
    const turnId = extractTurnId(params) ?? activeTurnByThread.get(fallbackThreadId) ?? null;
    if (turnId) {
      const text = typeof params.item.text === "string" ? params.item.text : "";
      if (text.length > 0) {
        setRuntimeTurnAssistantText(fallbackThreadId, turnId, text);
      }
    }
    return;
  }

  if (
    notification.method === "item/agentMessage/delta" &&
    fallbackThreadId &&
    isObjectRecord(params) &&
    typeof params.delta === "string"
  ) {
    const turnId = extractTurnId(params) ?? activeTurnByThread.get(fallbackThreadId) ?? null;
    if (turnId) {
      appendRuntimeTurnAssistantDelta(fallbackThreadId, turnId, params.delta);
    }
    return;
  }

  if (
    notification.method === "codex/event/agent_message_content_delta" &&
    isObjectRecord(params) &&
    isObjectRecord(params.msg) &&
    typeof params.msg.delta === "string"
  ) {
    const threadId =
      (typeof params.msg.thread_id === "string" ? params.msg.thread_id : null) ??
      (typeof params.conversationId === "string" ? params.conversationId : null) ??
      fallbackThreadId;
    const turnId =
      (typeof params.msg.turn_id === "string" ? params.msg.turn_id : null) ??
      extractTurnId(params) ??
      (threadId ? activeTurnByThread.get(threadId) ?? null : null);
    if (threadId && turnId) {
      appendRuntimeTurnAssistantDelta(threadId, turnId, params.msg.delta);
    }
    return;
  }

  if (
    notification.method === "codex/event/agent_message" &&
    isObjectRecord(params) &&
    isObjectRecord(params.msg) &&
    typeof params.msg.message === "string"
  ) {
    const threadId =
      (typeof params.msg.thread_id === "string" ? params.msg.thread_id : null) ??
      (typeof params.conversationId === "string" ? params.conversationId : null) ??
      fallbackThreadId;
    const turnId =
      (typeof params.msg.turn_id === "string" ? params.msg.turn_id : null) ??
      extractTurnId(params) ??
      (threadId ? activeTurnByThread.get(threadId) ?? null : null);
    if (threadId && turnId) {
      setRuntimeTurnAssistantText(threadId, turnId, params.msg.message);
    }
  }
}

type ReadThreadForTurnPollingResult = {
  thread: CodexThread;
  materialized: boolean;
};

async function readThreadForTurnPolling(threadId: string, signal?: AbortSignal): Promise<ReadThreadForTurnPollingResult> {
  throwIfAborted(signal);
  try {
    const response = await runtimeProfileAdapter.readThread({
      threadId,
      includeTurns: true
    });
    return {
      thread: response.thread as CodexThread,
      materialized: true
    };
  } catch (error) {
    if (!isIncludeTurnsUnavailableError(error)) {
      throw error;
    }
  }

  // The thread exists but is still materializing (common immediately after thread/start).
  // Polling should continue instead of failing the job terminally.
  const fallback = await runtimeProfileAdapter.readThread({
    threadId,
    includeTurns: false
  });
  return {
    thread: fallback.thread as CodexThread,
    materialized: false
  };
}

async function waitForAssistantText(
  threadId: string,
  turnId: string,
  signal?: AbortSignal,
  onOutputUpdate?: (update: AgentOutputUpdate) => void
): Promise<string> {
  throwIfAborted(signal);
  const startedAt = Date.now();
  const timeoutMs = env.ORCHESTRATOR_AGENT_TURN_TIMEOUT_MS;
  const includeTurnsGraceMs = env.ORCHESTRATOR_AGENT_INCLUDE_TURNS_GRACE_MS;
  const completedWithoutOutputGraceMs = Math.max(5_000, env.ORCHESTRATOR_AGENT_POLL_INTERVAL_MS * 2);
  let nonMaterializedSince: number | null = null;
  let sawCompletedTurnWithoutOutput = false;
  let completedTurnWithoutOutputAt: number | null = null;
  let lastOutputText: string | null = null;
  let lastOutputStatus: AgentOutputUpdate["status"] | null = null;
  let lastProgressAt = Date.now();
  let lastObservedRuntimeUpdatedAt = 0;
  let lastThreadReadAssistantText = "";
  let lastThreadReadItemCount = -1;
  let untrustedCompletedSince: number | null = null;
  let runningWithoutItemsSince: number | null = null;

  const emitOutput = (text: string, status: AgentOutputUpdate["status"]): void => {
    const normalizedText = normalizeAgentOutputText(text);
    if (!normalizedText) {
      return;
    }
    if (lastOutputText === normalizedText && lastOutputStatus === status) {
      return;
    }
    lastOutputText = normalizedText;
    lastOutputStatus = status;
    onOutputUpdate?.({
      text: normalizedText,
      status
    });
  };

  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(signal);
    const observed = runtimeTurnStateFromStore(threadId, turnId);
    if (observed) {
      if (observed.updatedAt > lastObservedRuntimeUpdatedAt) {
        lastObservedRuntimeUpdatedAt = observed.updatedAt;
        lastProgressAt = Date.now();
      }
      const observedText = normalizeAgentOutputText(observed.assistantText);
      if (observedText.length > 0) {
        emitOutput(observedText, observed.status === "completed" ? "complete" : "streaming");
      }
      if (observed.status === "failed") {
        throw agentTurnFailedError(observedText);
      }
      if (observed.status === "completed") {
        if (observedText.length > 0) {
          return observedText;
        }
        sawCompletedTurnWithoutOutput = true;
        if (completedTurnWithoutOutputAt === null) {
          completedTurnWithoutOutputAt = Date.now();
        }
      }
    }

    const shouldPollThreadRead = shouldPollThreadForRuntimeTurn(threadId, observed);
    if (shouldPollThreadRead) {
      const readResult = await readThreadForTurnPolling(threadId, signal);
      if (!readResult.materialized) {
        if (nonMaterializedSince === null) {
          nonMaterializedSince = Date.now();
        } else if (Date.now() - nonMaterializedSince >= includeTurnsGraceMs) {
          throw new Error(`includeTurns not materialized yet for thread ${threadId} after ${includeTurnsGraceMs}ms`);
        }
      } else {
        nonMaterializedSince = null;

        const turns = Array.isArray(readResult.thread.turns) ? readResult.thread.turns : [];
        const turn = turns.find((entry) => entry.id === turnId);
        if (turn) {
          const runtimeStatus = runtimeStatusFromTurnStatus(turn.status);
          let trustTerminalStatus =
            runtimeStatus === "running" || runtimeStatus === "failed"
              ? true
              : canTrustThreadReadTerminalStatus(threadId, turnId);
          const turnItems = Array.isArray(turn.items) ? turn.items : [];
          const itemCount = turnItems.length;
          if (itemCount !== lastThreadReadItemCount) {
            lastThreadReadItemCount = itemCount;
            lastProgressAt = Date.now();
          }
          if (runtimeStatus === "running" && itemCount === 0) {
            if (runningWithoutItemsSince === null) {
              runningWithoutItemsSince = Date.now();
            } else if (Date.now() - runningWithoutItemsSince >= env.ORCHESTRATOR_AGENT_EMPTY_TURN_GRACE_MS) {
              throw new Error(`agent turn ${turnId} made no item progress before ${env.ORCHESTRATOR_AGENT_EMPTY_TURN_GRACE_MS}ms`);
            }
          } else {
            runningWithoutItemsSince = null;
          }

          if (runtimeStatus === "completed" && !trustTerminalStatus) {
            if (untrustedCompletedSince === null) {
              untrustedCompletedSince = Date.now();
            }
            const noProgressForMs = Date.now() - lastProgressAt;
            const untrustedCompletedForMs = Date.now() - untrustedCompletedSince;
            if (
              noProgressForMs >= env.ORCHESTRATOR_AGENT_UNTRUSTED_TERMINAL_GRACE_MS &&
              untrustedCompletedForMs >= env.ORCHESTRATOR_AGENT_UNTRUSTED_TERMINAL_GRACE_MS
            ) {
              activeTurnByThread.delete(threadId);
              trustTerminalStatus = true;
            }
          } else {
            untrustedCompletedSince = null;
          }

          markRuntimeTurnSettled(threadId, turnId, trustTerminalStatus ? runtimeStatus : "running");
          const assistantText = latestAgentMessageFromTurn(turn);
          if (assistantText) {
            const normalizedAssistantText = normalizeAgentOutputText(assistantText);
            if (normalizedAssistantText.length > 0 && normalizedAssistantText !== lastThreadReadAssistantText) {
              lastThreadReadAssistantText = normalizedAssistantText;
              lastProgressAt = Date.now();
            }
            setRuntimeTurnAssistantText(threadId, turnId, assistantText);
            emitOutput(
              assistantText,
              runtimeStatus === "completed" && trustTerminalStatus ? "complete" : "streaming"
            );
          }
          if (runtimeStatus === "failed") {
            throw agentTurnFailedError(assistantText);
          }
          if (runtimeStatus === "completed" && trustTerminalStatus) {
            if (assistantText) {
              return normalizeAgentOutputText(assistantText);
            }
            sawCompletedTurnWithoutOutput = true;
            if (completedTurnWithoutOutputAt === null) {
              completedTurnWithoutOutputAt = Date.now();
            }
          }
        }
      }
    }

    if (
      sawCompletedTurnWithoutOutput &&
      completedTurnWithoutOutputAt !== null &&
      Date.now() - completedTurnWithoutOutputAt >= completedWithoutOutputGraceMs
    ) {
      throw new Error("agent turn completed but no assistant text was readable before timeout");
    }

    await waitForRuntimeTurnSignal(threadId, turnId, env.ORCHESTRATOR_AGENT_POLL_INTERVAL_MS, signal);
  }

  if (sawCompletedTurnWithoutOutput) {
    throw new Error("agent turn completed but no assistant text was readable before timeout");
  }
  throw new Error("timed out waiting for agent assistant text");
}

async function waitForTurnToSettle(
  threadId: string,
  turnId: string,
  signal?: AbortSignal,
  onOutputUpdate?: (update: AgentOutputUpdate) => void
): Promise<string | null> {
  throwIfAborted(signal);
  const startedAt = Date.now();
  const timeoutMs = env.ORCHESTRATOR_AGENT_TURN_TIMEOUT_MS;
  const includeTurnsGraceMs = env.ORCHESTRATOR_AGENT_INCLUDE_TURNS_GRACE_MS;
  let nonMaterializedSince: number | null = null;
  let latestOutputText: string | null = null;
  let lastOutputText: string | null = null;
  let lastOutputStatus: AgentOutputUpdate["status"] | null = null;
  let lastProgressAt = Date.now();
  let lastObservedRuntimeUpdatedAt = 0;
  let lastThreadReadAssistantText = "";
  let lastThreadReadItemCount = -1;
  let untrustedCompletedSince: number | null = null;
  let runningWithoutItemsSince: number | null = null;

  const emitOutput = (text: string, status: AgentOutputUpdate["status"]): void => {
    const normalizedText = normalizeAgentOutputText(text);
    if (!normalizedText) {
      return;
    }
    if (lastOutputText === normalizedText && lastOutputStatus === status) {
      return;
    }
    lastOutputText = normalizedText;
    lastOutputStatus = status;
    onOutputUpdate?.({
      text: normalizedText,
      status
    });
  };

  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(signal);
    const observed = runtimeTurnStateFromStore(threadId, turnId);
    if (observed) {
      if (observed.updatedAt > lastObservedRuntimeUpdatedAt) {
        lastObservedRuntimeUpdatedAt = observed.updatedAt;
        lastProgressAt = Date.now();
      }
      const observedText = normalizeAgentOutputText(observed.assistantText);
      if (observedText.length > 0) {
        latestOutputText = observedText;
        emitOutput(observedText, observed.status === "completed" ? "complete" : "streaming");
      }
      if (observed.status === "failed") {
        throw agentTurnFailedError(observedText);
      }
      if (observed.status === "completed") {
        return latestOutputText;
      }
    }

    const shouldPollThreadRead = shouldPollThreadForRuntimeTurn(threadId, observed);
    if (shouldPollThreadRead) {
      const readResult = await readThreadForTurnPolling(threadId, signal);
      if (!readResult.materialized) {
        if (nonMaterializedSince === null) {
          nonMaterializedSince = Date.now();
        } else if (Date.now() - nonMaterializedSince >= includeTurnsGraceMs) {
          throw new Error(`includeTurns not materialized yet for thread ${threadId} after ${includeTurnsGraceMs}ms`);
        }
      } else {
        nonMaterializedSince = null;

        const turns = Array.isArray(readResult.thread.turns) ? readResult.thread.turns : [];
        const turn = turns.find((entry) => entry.id === turnId);
        if (turn) {
          const runtimeStatus = runtimeStatusFromTurnStatus(turn.status);
          let trustTerminalStatus =
            runtimeStatus === "running" || runtimeStatus === "failed"
              ? true
              : canTrustThreadReadTerminalStatus(threadId, turnId);
          const turnItems = Array.isArray(turn.items) ? turn.items : [];
          const itemCount = turnItems.length;
          if (itemCount !== lastThreadReadItemCount) {
            lastThreadReadItemCount = itemCount;
            lastProgressAt = Date.now();
          }
          if (runtimeStatus === "running" && itemCount === 0) {
            if (runningWithoutItemsSince === null) {
              runningWithoutItemsSince = Date.now();
            } else if (Date.now() - runningWithoutItemsSince >= env.ORCHESTRATOR_AGENT_EMPTY_TURN_GRACE_MS) {
              throw new Error(`agent turn ${turnId} made no item progress before ${env.ORCHESTRATOR_AGENT_EMPTY_TURN_GRACE_MS}ms`);
            }
          } else {
            runningWithoutItemsSince = null;
          }

          if (runtimeStatus === "completed" && !trustTerminalStatus) {
            if (untrustedCompletedSince === null) {
              untrustedCompletedSince = Date.now();
            }
            const noProgressForMs = Date.now() - lastProgressAt;
            const untrustedCompletedForMs = Date.now() - untrustedCompletedSince;
            if (
              noProgressForMs >= env.ORCHESTRATOR_AGENT_UNTRUSTED_TERMINAL_GRACE_MS &&
              untrustedCompletedForMs >= env.ORCHESTRATOR_AGENT_UNTRUSTED_TERMINAL_GRACE_MS
            ) {
              activeTurnByThread.delete(threadId);
              trustTerminalStatus = true;
            }
          } else {
            untrustedCompletedSince = null;
          }

          markRuntimeTurnSettled(threadId, turnId, trustTerminalStatus ? runtimeStatus : "running");
          const assistantText = latestAgentMessageFromTurn(turn);
          if (assistantText) {
            const normalizedAssistantText = normalizeAgentOutputText(assistantText);
            if (normalizedAssistantText.length > 0 && normalizedAssistantText !== lastThreadReadAssistantText) {
              lastThreadReadAssistantText = normalizedAssistantText;
              lastProgressAt = Date.now();
            }
            setRuntimeTurnAssistantText(threadId, turnId, assistantText);
            latestOutputText = normalizeAgentOutputText(assistantText);
            emitOutput(
              assistantText,
              runtimeStatus === "completed" && trustTerminalStatus ? "complete" : "streaming"
            );
          }
          if (runtimeStatus === "failed") {
            throw agentTurnFailedError(assistantText);
          }

          if (runtimeStatus === "completed" && trustTerminalStatus) {
            return latestOutputText;
          }
        }
      }
    }

    await waitForRuntimeTurnSignal(threadId, turnId, env.ORCHESTRATOR_AGENT_POLL_INTERVAL_MS, signal);
  }

  throw new Error("timed out waiting for agent turn completion");
}

function isSuggestedRequestRuntimeStateTerminal(status: SuggestedRequestRuntimeStateStatus): boolean {
  return status === "complete" || status === "error" || status === "canceled";
}

async function waitForTurnOrSuggestedRequestCompletion(
  params: {
    threadId: string;
    turnId: string;
    sourceSessionId: string;
    requestKey: string;
    signal?: AbortSignal;
  }
): Promise<void> {
  throwIfAborted(params.signal);
  const startedAt = Date.now();
  const timeoutMs = env.ORCHESTRATOR_SUGGEST_REQUEST_WAIT_MS;

  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(params.signal);

    const suggestedRequestState = readSuggestedRequestRuntimeState(params.sourceSessionId, params.requestKey);
    if (suggestedRequestState && isSuggestedRequestRuntimeStateTerminal(suggestedRequestState.status)) {
      const observed = runtimeTurnStateFromStore(params.threadId, params.turnId);
      if (observed?.status === "running") {
        try {
          await runtimeProfileAdapter.interruptTurn({
            threadId: params.threadId,
            turnId: params.turnId
          });
        } catch {
          // Best-effort interrupt to release the worker turn once completion signal is satisfied.
        }
      }
      return;
    }

    const observed = runtimeTurnStateFromStore(params.threadId, params.turnId);
    if (observed) {
      const observedText = normalizeAgentOutputText(observed.assistantText);
      if (observed.status === "failed") {
        throw agentTurnFailedError(observedText);
      }
      if (observed.status === "completed") {
        return;
      }
    }

    await waitForRuntimeTurnSignal(params.threadId, params.turnId, env.ORCHESTRATOR_AGENT_POLL_INTERVAL_MS, params.signal);
  }

  throw new Error("suggested request completion signal was not observed before deadline");
}

function buildCoreQueueWorkerOrientationText(agent: string): string {
  return [
    "# System Queue-Runner Orientation",
    "",
    "Before doing anything else, read and follow queue-runner guidance in:",
    "- `docs/queue-runner.md`",
    "",
    `You are booting as a hidden system-owned worker for agent "${agent}".`,
    "This is a control-plane queue processor session, not a user-facing chat.",
    "",
    "Core operating posture:",
    "- process one queue job at a time, in the order jobs are delivered by core",
    "- prioritize liveness: publish initial live status signaling immediately when job execution begins",
    "- do not delay live signaling for reads; gather additional context only when it is needed for the next safe mutation",
    "- keep reads minimal and action-scoped; in most jobs, provided routing context is sufficient to begin execution",
    "- treat routing ids in each job as authoritative (`projectId`, `sourceSessionId`, `threadId`, `turnId`, and optional item/approval ids)",
    "- execute mutations only inside the intended `projectId + sourceSessionId + turnId` scope unless the instruction explicitly requires otherwise",
    "- execute real side effects during the turn using CLI commands; do not depend on returning structured JSON output",
    "- do not perform steering unless the job enables steering and the assessed risk is at or above the configured auto-steer threshold",
    "- verify state after each mutation phase and always at terminal completion",
    "- if a user action races and resolves first, accept reconciliation and continue deterministically",
    "",
    "Queue job shape you will receive:",
    "- `agent_instruction`: includes `jobKind`, routing ids, and markdown `instructionText`",
    "- in this runtime, suggest-request work is also delivered as `agent_instruction` with `jobKind: suggest_request`",
    "",
    "For full CLI command reference, use:",
    "- `docs/operations/cli.md`",
    "",
    "Primary CLI commands for queue-runner side effects:",
    "- transcript updates: `pnpm --filter @repo/cli dev sessions transcript upsert ...`",
    "- suggested-request updates: `pnpm --filter @repo/cli dev sessions suggest-request upsert ...`",
    "- approval actions: `pnpm --filter @repo/cli dev approvals decide ...`",
    "- steering actions: `pnpm --filter @repo/cli dev sessions steer ...` (only when auto-steer is enabled and risk >= configured threshold)",
    "",
    "After this orientation turn completes, expect extension-specific bootstrap instructions and then live queue jobs.",
    "Acknowledge readiness briefly and stay in queue-runner mode."
  ].join("\n");
}

function extensionBootstrapSetForSession(sessionId: string): Set<string> {
  const existing = agentExtensionBootstrapCompletedBySession.get(sessionId);
  if (existing) {
    return existing;
  }
  const next = new Set<string>();
  agentExtensionBootstrapCompletedBySession.set(sessionId, next);
  return next;
}

async function ensureCoreQueueWorkerOrientation(
  sessionId: string,
  projectId: string,
  agent: string,
  runtimePolicy: AgentRuntimePolicyConfig,
  options?: {
    signal?: AbortSignal;
    onTurnStarted?: (threadId: string, turnId: string) => void;
  }
): Promise<void> {
  if (coreQueueWorkerOrientationCompletedBySession.has(sessionId)) {
    return;
  }

  const existing = coreQueueWorkerOrientationInFlightBySession.get(sessionId);
  if (existing) {
    throwIfAborted(options?.signal);
    await existing;
    throwIfAborted(options?.signal);
    return;
  }

  const work = (async () => {
    if (coreQueueWorkerOrientationCompletedBySession.has(sessionId)) {
      return;
    }

    const turn = await runtimeProfileAdapter.startTurn({
      threadId: sessionId,
      model: runtimePolicy.model ?? undefined,
      effort: runtimePolicy.orientationTurnPolicy.effort ?? undefined,
      sandboxPolicy: toTurnSandboxPolicy(
        runtimePolicy.orientationTurnPolicy.sandbox,
        runtimePolicy.orientationTurnPolicy.networkAccess
      ),
      approvalPolicy: runtimePolicy.orientationTurnPolicy.approvalPolicy,
      inputText: buildCoreQueueWorkerOrientationText(agent)
    });
    activeTurnByThread.set(sessionId, turn.id);
    options?.onTurnStarted?.(sessionId, turn.id);
    markRuntimeTurnStarted(sessionId, turn.id);
    const lifecycleMessageId = `agent-worker-lifecycle::core-orientation::${turn.id}`;
    const lifecycleStartedAt = Date.now();
    upsertAgentWorkerLifecycleEntry({
      sessionId,
      messageId: lifecycleMessageId,
      turnId: turn.id,
      status: "streaming",
      content: "Running core queue-runner orientation turn.",
      details: {
        phase: "core_orientation",
        projectId,
        agent
      },
      startedAt: lifecycleStartedAt
    });
    try {
      await waitForTurnToSettle(sessionId, turn.id, options?.signal);
      upsertAgentWorkerLifecycleEntry({
        sessionId,
        messageId: lifecycleMessageId,
        turnId: turn.id,
        status: "complete",
        content: "Core queue-runner orientation completed.",
        details: {
          phase: "core_orientation",
          projectId,
          agent,
          durationMs: Math.max(0, Date.now() - lifecycleStartedAt)
        },
        startedAt: lifecycleStartedAt
      });
      coreQueueWorkerOrientationCompletedBySession.add(sessionId);
      app.log.info({ projectId, agent, sessionId }, "completed core queue-runner orientation turn");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isAbortError(error) || options?.signal?.aborted) {
        try {
          await runtimeProfileAdapter.interruptTurn({
            threadId: sessionId,
            turnId: turn.id
          });
        } catch {
          // Best-effort interrupt to avoid lingering in-progress worker turns.
        }
      }
      upsertAgentWorkerLifecycleEntry({
        sessionId,
        messageId: lifecycleMessageId,
        turnId: turn.id,
        status: isAbortError(error) ? "canceled" : "error",
        content: isAbortError(error)
          ? "Core queue-runner orientation canceled."
          : `Core queue-runner orientation failed: ${message}`,
        details: {
          phase: "core_orientation",
          projectId,
          agent,
          error: message
        },
        startedAt: lifecycleStartedAt
      });
      throw error;
    }
  })();

  coreQueueWorkerOrientationInFlightBySession.set(sessionId, work);
  try {
    await work;
  } finally {
    if (coreQueueWorkerOrientationInFlightBySession.get(sessionId) === work) {
      coreQueueWorkerOrientationInFlightBySession.delete(sessionId);
    }
  }
}

async function ensureAgentExtensionBootstrapInstruction(
  sessionId: string,
  projectId: string,
  agent: string,
  runtimePolicy: AgentRuntimePolicyConfig,
  bootstrapInstruction: { key: string; instructionText: string } | undefined,
  options?: {
    signal?: AbortSignal;
    onTurnStarted?: (threadId: string, turnId: string) => void;
  }
): Promise<void> {
  if (!bootstrapInstruction) {
    return;
  }

  const key = bootstrapInstruction.key.trim();
  const instructionText = bootstrapInstruction.instructionText.trim();
  if (!key || !instructionText) {
    return;
  }

  const completedKeys = extensionBootstrapSetForSession(sessionId);
  if (completedKeys.has(key)) {
    return;
  }

  const inFlightKey = `${sessionId}::${key}`;
  const existing = agentExtensionBootstrapInFlightByKey.get(inFlightKey);
  if (existing) {
    throwIfAborted(options?.signal);
    await existing;
    throwIfAborted(options?.signal);
    return;
  }

  const work = (async () => {
    if (completedKeys.has(key)) {
      return;
    }

    const turn = await runtimeProfileAdapter.startTurn({
      threadId: sessionId,
      model: runtimePolicy.model ?? undefined,
      effort: runtimePolicy.orientationTurnPolicy.effort ?? undefined,
      sandboxPolicy: toTurnSandboxPolicy(
        runtimePolicy.orientationTurnPolicy.sandbox,
        runtimePolicy.orientationTurnPolicy.networkAccess
      ),
      approvalPolicy: runtimePolicy.orientationTurnPolicy.approvalPolicy,
      inputText: instructionText
    });
    activeTurnByThread.set(sessionId, turn.id);
    options?.onTurnStarted?.(sessionId, turn.id);
    markRuntimeTurnStarted(sessionId, turn.id);
    const lifecycleMessageId = `agent-worker-lifecycle::extension-bootstrap::${key}::${turn.id}`;
    const lifecycleStartedAt = Date.now();
    upsertAgentWorkerLifecycleEntry({
      sessionId,
      messageId: lifecycleMessageId,
      turnId: turn.id,
      status: "streaming",
      content: `Running extension bootstrap instruction (${key}).`,
      details: {
        phase: "extension_bootstrap",
        projectId,
        agent,
        bootstrapKey: key
      },
      startedAt: lifecycleStartedAt
    });
    try {
      await waitForTurnToSettle(sessionId, turn.id, options?.signal);
      upsertAgentWorkerLifecycleEntry({
        sessionId,
        messageId: lifecycleMessageId,
        turnId: turn.id,
        status: "complete",
        content: `Extension bootstrap instruction completed (${key}).`,
        details: {
          phase: "extension_bootstrap",
          projectId,
          agent,
          bootstrapKey: key,
          durationMs: Math.max(0, Date.now() - lifecycleStartedAt)
        },
        startedAt: lifecycleStartedAt
      });
      completedKeys.add(key);
      app.log.info({ projectId, agent, sessionId, bootstrapKey: key }, "completed agent extension bootstrap turn");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isAbortError(error) || options?.signal?.aborted) {
        try {
          await runtimeProfileAdapter.interruptTurn({
            threadId: sessionId,
            turnId: turn.id
          });
        } catch {
          // Best-effort interrupt to avoid lingering in-progress worker turns.
        }
      }
      upsertAgentWorkerLifecycleEntry({
        sessionId,
        messageId: lifecycleMessageId,
        turnId: turn.id,
        status: isAbortError(error) ? "canceled" : "error",
        content: isAbortError(error)
          ? `Extension bootstrap instruction canceled (${key}).`
          : `Extension bootstrap instruction failed (${key}): ${message}`,
        details: {
          phase: "extension_bootstrap",
          projectId,
          agent,
          bootstrapKey: key,
          error: message
        },
        startedAt: lifecycleStartedAt
      });
      throw error;
    }
  })();

  agentExtensionBootstrapInFlightByKey.set(inFlightKey, work);
  try {
    await work;
  } finally {
    if (agentExtensionBootstrapInFlightByKey.get(inFlightKey) === work) {
      agentExtensionBootstrapInFlightByKey.delete(inFlightKey);
    }
  }
}

async function ensureAgentSessionStartupReady(
  params: {
    sessionId: string;
    projectId: string;
    agent: string;
    runtimePolicy: AgentRuntimePolicyConfig;
    bootstrapInstruction?: { key: string; instructionText: string };
  },
  options?: {
    signal?: AbortSignal;
    onTurnStarted?: (threadId: string, turnId: string) => void;
  }
): Promise<void> {
  await ensureCoreQueueWorkerOrientation(
    params.sessionId,
    params.projectId,
    params.agent,
    params.runtimePolicy,
    options
  );

  await ensureAgentExtensionBootstrapInstruction(
    params.sessionId,
    params.projectId,
    params.agent,
    params.runtimePolicy,
    params.bootstrapInstruction,
    options
  );
}

async function resolveAgentSession(
  projectId: string,
  agent: string,
  runtimePolicy: AgentRuntimePolicyConfig,
  sourceSessionId?: string
): Promise<string> {
  if (!isKnownAgent(agent)) {
    throw new Error(`unknown agent "${agent}" under ${agentsRootPath}`);
  }
  return ensureProjectAgentSession(projectId, agent, runtimePolicy, sourceSessionId);
}

function parseAgentInstructionActionIntentsOutput(outputText: string): Array<AgentInstructionActionIntent> {
  const trimmed = outputText.trim();
  if (!trimmed) {
    throw new Error("agent instruction expected action intents but assistant output was empty");
  }

  const parseCandidates: Array<string> = [];
  const seenCandidates = new Set<string>();
  const pushCandidate = (value: string): void => {
    const candidate = value.trim();
    if (!candidate || seenCandidates.has(candidate)) {
      return;
    }
    seenCandidates.add(candidate);
    parseCandidates.push(candidate);
  };

  pushCandidate(trimmed);

  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]+?)\s*```/gi)) {
    if (typeof match[1] === "string") {
      pushCandidate(match[1]);
    }
  }

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    pushCandidate(trimmed.slice(objectStart, objectEnd + 1));
  }

  let parsedValue: unknown = null;
  let lastError: unknown = null;
  for (const candidate of parseCandidates) {
    try {
      parsedValue = JSON.parse(candidate);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw new Error(`agent instruction action intents were not valid JSON: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  const parsed = agentInstructionActionIntentBatchSchema.safeParse(parsedValue);
  if (!parsed.success) {
    throw new Error(`agent instruction action intents failed schema validation: ${parsed.error.message}`);
  }

  return parsed.data.intents;
}

async function runAgentInstructionJob(
  payload: AgentInstructionJobPayload,
  options?: {
    signal?: AbortSignal;
    jobId?: string;
    onTurnStarted?: (threadId: string, turnId: string) => void;
    onOutputUpdate?: (update: AgentOutputUpdate) => void;
  }
): Promise<AgentInstructionJobResult> {
  throwIfAborted(options?.signal);
  let recoveredMissingSession = false;
  const runtimePolicy = await resolveAgentRuntimePolicyConfig(payload.agent);

  while (true) {
    const agentSessionId = await resolveAgentSession(
      payload.projectId,
      payload.agent,
      runtimePolicy,
      payload.sourceSessionId
    );
    let lifecycleMessageId: string | null = null;
    let lifecycleTurnId: string | null = null;
    let lifecycleStartedAt: number | null = null;
    const upsertLifecycle = (
      status: TranscriptEntry["status"],
      content: string,
      details?: Record<string, unknown>
    ): void => {
      if (!lifecycleMessageId || !lifecycleTurnId || lifecycleStartedAt === null) {
        return;
      }
      upsertAgentWorkerLifecycleEntry({
        sessionId: agentSessionId,
        messageId: lifecycleMessageId,
        turnId: lifecycleTurnId,
        status,
        content,
        details: {
          phase: "job_execution",
          agent: payload.agent,
          jobKind: payload.jobKind,
          projectId: payload.projectId,
          sourceSessionId: payload.sourceSessionId,
          sourceTurnId: payload.turnId,
          ...(payload.approvalId ? { approvalId: payload.approvalId } : {}),
          ...(payload.itemId ? { itemId: payload.itemId } : {}),
          ...(payload.anchorItemId ? { anchorItemId: payload.anchorItemId } : {}),
          ...(options?.jobId ? { queueJobId: options.jobId } : {}),
          ...(details ?? {})
        },
        startedAt: lifecycleStartedAt
      });
    };
    const lifecycleDurationMs = (): number => {
      const startedAt = lifecycleStartedAt ?? Date.now();
      return Math.max(0, Date.now() - startedAt);
    };
    try {
      await ensureAgentSessionStartupReady(
        {
          sessionId: agentSessionId,
          projectId: payload.projectId,
          agent: payload.agent,
          runtimePolicy,
          bootstrapInstruction: payload.bootstrapInstruction
        },
        options
      );
      throwIfAborted(options?.signal);

      const turn = await runtimeProfileAdapter.startTurn({
        threadId: agentSessionId,
        model: payload.model?.trim() ? payload.model.trim() : runtimePolicy.model ?? undefined,
        effort: payload.effort ?? runtimePolicy.instructionTurnPolicy.effort ?? undefined,
        sandboxPolicy: toTurnSandboxPolicy(
          runtimePolicy.instructionTurnPolicy.sandbox,
          runtimePolicy.instructionTurnPolicy.networkAccess
        ),
        approvalPolicy: runtimePolicy.instructionTurnPolicy.approvalPolicy,
        inputText: payload.instructionText
      });
      activeTurnByThread.set(agentSessionId, turn.id);
      options?.onTurnStarted?.(agentSessionId, turn.id);
      markRuntimeTurnStarted(agentSessionId, turn.id);
      lifecycleMessageId = `agent-worker-lifecycle::job::${options?.jobId ?? payload.jobKind}::${turn.id}`;
      lifecycleTurnId = turn.id;
      lifecycleStartedAt = Date.now();
      upsertLifecycle("streaming", `Processing queue job "${payload.jobKind}".`, {
        responseExpectation: payload.expectResponse
      });

      if (payload.expectResponse === "assistant_text") {
        const outputText = await waitForAssistantText(
          agentSessionId,
          turn.id,
          options?.signal,
          options?.onOutputUpdate
        );
        upsertLifecycle("complete", `Queue job "${payload.jobKind}" completed.`, {
          durationMs: lifecycleDurationMs()
        });
        return {
          status: "ok",
          ...(outputText.trim().length > 0 ? { outputText } : {})
        };
      }

      if (payload.expectResponse === "action_intents") {
        const outputText = await waitForAssistantText(
          agentSessionId,
          turn.id,
          options?.signal,
          options?.onOutputUpdate
        );
        const actionIntents = parseAgentInstructionActionIntentsOutput(outputText);
        upsertLifecycle("complete", `Queue job "${payload.jobKind}" completed.`, {
          durationMs: lifecycleDurationMs(),
          actionIntentCount: actionIntents.length
        });
        return {
          status: "ok",
          outputText,
          actionIntents
        };
      }

      if (payload.completionSignal?.kind === "suggested_request") {
        try {
          await waitForTurnOrSuggestedRequestCompletion({
            threadId: agentSessionId,
            turnId: turn.id,
            sourceSessionId: payload.sourceSessionId,
            requestKey: payload.completionSignal.requestKey,
            signal: options?.signal
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const completionSignalTimeout = message.includes("suggested request completion signal was not observed before deadline");
          if (!completionSignalTimeout) {
            throw error;
          }

          const existingState = readSuggestedRequestRuntimeState(payload.sourceSessionId, payload.completionSignal.requestKey);
          if (!existingState || !isSuggestedRequestRuntimeStateTerminal(existingState.status)) {
            const fallbackSuggestion = buildFallbackSuggestedRequest([], payload.fallbackSuggestionDraft);
            upsertSuggestedRequestRuntimeState({
              sessionId: payload.sourceSessionId,
              requestKey: payload.completionSignal.requestKey,
              status: "complete",
              suggestion: fallbackSuggestion
            });
          }

          try {
            await runtimeProfileAdapter.interruptTurn({
              threadId: agentSessionId,
              turnId: turn.id
            });
          } catch {
            // Best-effort interrupt only; job completion no longer depends on the worker turn settling.
          }
        }
        upsertLifecycle("complete", `Queue job "${payload.jobKind}" completed.`, {
          durationMs: lifecycleDurationMs()
        });
        return {
          status: "ok"
        };
      }

      const outputText = await waitForTurnToSettle(
        agentSessionId,
        turn.id,
        options?.signal,
        options?.onOutputUpdate
      );
      upsertLifecycle("complete", `Queue job "${payload.jobKind}" completed.`, {
        durationMs: lifecycleDurationMs()
      });
      return {
        status: "ok",
        ...(outputText && outputText.trim().length > 0 ? { outputText } : {})
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isAbortError(error) || options?.signal?.aborted) {
        if (lifecycleTurnId) {
          try {
            await runtimeProfileAdapter.interruptTurn({
              threadId: agentSessionId,
              turnId: lifecycleTurnId
            });
          } catch {
            // Best-effort interrupt only.
          }
        }
        upsertLifecycle("canceled", `Queue job "${payload.jobKind}" canceled.`, {
          error: message,
          durationMs: lifecycleDurationMs()
        });
        throw error;
      }

      if (lifecycleTurnId) {
        try {
          await runtimeProfileAdapter.interruptTurn({
            threadId: agentSessionId,
            turnId: lifecycleTurnId
          });
        } catch {
          // Best-effort interrupt only; this prevents stuck turns from lingering after non-abort failures.
        }
      }

      upsertLifecycle("error", `Queue job "${payload.jobKind}" failed: ${message}`, {
        error: message,
        durationMs: lifecycleDurationMs()
      });

      const recoverableMissingSession = isMissingThreadError(error) || isNoRolloutFoundError(error);
      if (!recoverableMissingSession || recoveredMissingSession) {
        throw error;
      }

      recoveredMissingSession = true;
      app.log.warn(
        {
          error,
          projectId: payload.projectId,
          agent: payload.agent,
          agentSessionId,
          jobKind: payload.jobKind
        },
        "agent session unavailable during instruction job; clearing mapping and retrying once"
      );
      await clearProjectAgentSessionMapping(payload.projectId, payload.agent, agentSessionId);
    }
  }
}

async function runAgentInstructionJobWithSuggestedRequestDeadline(
  payload: AgentInstructionJobPayload,
  options?: {
    signal?: AbortSignal;
    jobId?: string;
    onTurnStarted?: (threadId: string, turnId: string) => void;
    onOutputUpdate?: (update: AgentOutputUpdate) => void;
  }
): Promise<AgentInstructionJobResult> {
  const deadlineMs = env.ORCHESTRATOR_SUGGEST_REQUEST_WAIT_MS;
  let latestThreadId: string | null = null;
  let latestTurnId: string | null = null;
  let timeoutTriggered = false;

  const localController = new AbortController();
  const parentAbortListener = (): void => {
    localController.abort();
  };
  if (options?.signal) {
    if (options.signal.aborted) {
      throw new Error("orchestrator job aborted");
    }
    options.signal.addEventListener("abort", parentAbortListener, { once: true });
  }

  let timeoutHandle: NodeJS.Timeout | null = null;
  const runPromise = runAgentInstructionJob(payload, {
    ...options,
    signal: localController.signal,
    onTurnStarted: (threadId, turnId) => {
      latestThreadId = threadId;
      latestTurnId = turnId;
      options?.onTurnStarted?.(threadId, turnId);
    }
  });

  const timeoutPromise = new Promise<AgentInstructionJobResult>((resolve) => {
    timeoutHandle = setTimeout(async () => {
      timeoutTriggered = true;

      if (payload.completionSignal?.kind === "suggested_request") {
        const existingState = readSuggestedRequestRuntimeState(payload.sourceSessionId, payload.completionSignal.requestKey);
        if (!existingState || !isSuggestedRequestRuntimeStateTerminal(existingState.status)) {
          const fallbackSuggestion = buildFallbackSuggestedRequest([], payload.fallbackSuggestionDraft);
          upsertSuggestedRequestRuntimeState({
            sessionId: payload.sourceSessionId,
            requestKey: payload.completionSignal.requestKey,
            status: "complete",
            suggestion: fallbackSuggestion
          });
        }
      }

      resolve({
        status: "ok"
      });

      localController.abort();
      if (latestThreadId && latestTurnId) {
        try {
          await runtimeProfileAdapter.interruptTurn({
            threadId: latestThreadId,
            turnId: latestTurnId
          });
        } catch {
          // Best-effort interrupt only.
        }
      }
    }, deadlineMs);
  });

  try {
    const result = await Promise.race([runPromise, timeoutPromise]);
    if (timeoutTriggered) {
      void runPromise.catch(() => {
        // Intentionally ignored: fallback completion already published.
      });
    }
    return result;
  } catch (error) {
    if (timeoutTriggered) {
      void runPromise.catch(() => {
        // Intentionally ignored: fallback completion already published.
      });
      return {
        status: "ok"
      };
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    if (options?.signal) {
      options.signal.removeEventListener("abort", parentAbortListener);
    }
  }
}
function extractThreadId(params: unknown): string | undefined {
  if (!isObjectRecord(params)) {
    return undefined;
  }

  if (typeof params.threadId === "string") {
    return params.threadId;
  }

  if (typeof params.conversationId === "string") {
    return params.conversationId;
  }

  if (isObjectRecord(params.thread) && typeof params.thread.id === "string") {
    return params.thread.id;
  }

  return undefined;
}

function extractTurnId(params: unknown): string | null {
  if (!isObjectRecord(params)) {
    return null;
  }

  if (typeof params.turnId === "string" && params.turnId.trim().length > 0) {
    return params.turnId;
  }

  if (typeof params.turn_id === "string" && params.turn_id.trim().length > 0) {
    return params.turn_id;
  }

  if (isObjectRecord(params.turn)) {
    if (typeof params.turn.id === "string" && params.turn.id.trim().length > 0) {
      return params.turn.id;
    }

    if (typeof params.turn.turnId === "string" && params.turn.turnId.trim().length > 0) {
      return params.turn.turnId;
    }

    if (typeof params.turn.turn_id === "string" && params.turn.turn_id.trim().length > 0) {
      return params.turn.turn_id;
    }
  }

  if (isObjectRecord(params.item)) {
    if (typeof params.item.turnId === "string" && params.item.turnId.trim().length > 0) {
      return params.item.turnId;
    }

    if (typeof params.item.turn_id === "string" && params.item.turn_id.trim().length > 0) {
      return params.item.turn_id;
    }

    if (typeof params.item.parentTurnId === "string" && params.item.parentTurnId.trim().length > 0) {
      return params.item.parentTurnId;
    }

    if (typeof params.item.parent_turn_id === "string" && params.item.parent_turn_id.trim().length > 0) {
      return params.item.parent_turn_id;
    }

    if (isObjectRecord(params.item.turn)) {
      if (typeof params.item.turn.id === "string" && params.item.turn.id.trim().length > 0) {
        return params.item.turn.id;
      }
      if (typeof params.item.turn.turnId === "string" && params.item.turn.turnId.trim().length > 0) {
        return params.item.turn.turnId;
      }
      if (typeof params.item.turn.turn_id === "string" && params.item.turn.turn_id.trim().length > 0) {
        return params.item.turn.turn_id;
      }
    }
  }

  return null;
}

function extractItemId(params: unknown): string | null {
  if (!isObjectRecord(params)) {
    return null;
  }

  if (typeof params.itemId === "string") {
    return params.itemId;
  }

  if (typeof params.callId === "string") {
    return params.callId;
  }

  if (isObjectRecord(params.item) && typeof params.item.id === "string") {
    return params.item.id;
  }

  return null;
}

function isNoRolloutFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("no rollout found for thread id") ||
    message.includes("no rollout found for conversation id") ||
    message.includes("thread not found") ||
    message.includes("thread not loaded")
  );
}

function isInvalidThreadIdError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("invalid thread id") || message.includes("invalid conversation id");
}

function isThreadNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("thread not found") || message.includes("conversation not found");
}

function isMissingThreadError(error: unknown): boolean {
  return isInvalidThreadIdError(error) || isThreadNotFoundError(error);
}

function isSessionPurged(sessionId: string): boolean {
  return purgedSessionIds.has(sessionId);
}

function systemSessionPayload(sessionId: string): {
  status: "error";
  code: "system_session";
  sessionId: string;
  message: string;
} {
  return {
    status: "error",
    code: "system_session",
    sessionId,
    message: "system-owned sessions are reserved for orchestrator workers"
  };
}

function deletedSessionPayload(sessionId: string, title?: string): DeletedSessionPayload {
  const normalizedTitle = typeof title === "string" && title.trim().length > 0 ? title.trim() : undefined;
  return {
    status: "deleted",
    sessionId,
    title: normalizedTitle,
    message: deletedSessionMessage,
    deletedAt: new Date().toISOString()
  };
}

async function collectSessionArtifactPaths(rootDir: string, sessionId: string): Promise<Array<string>> {
  const matches: Array<string> = [];
  const pendingDirs: Array<string> = [rootDir];

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    if (!currentDir) {
      continue;
    }

    let entries: Array<Dirent>;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        continue;
      }
      throw error;
    }

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pendingDirs.push(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!entry.name.includes(sessionId)) {
        continue;
      }

      matches.push(absolutePath);
    }
  }

  return matches;
}

async function purgeRolloutFilesForSession(sessionId: string, knownPath?: string | null): Promise<Array<string>> {
  if (!env.CODEX_HOME) {
    return [];
  }

  const roots = [
    path.join(env.CODEX_HOME, "sessions"),
    path.join(env.CODEX_HOME, "archived_sessions"),
    path.join(env.CODEX_HOME, "shell_snapshots")
  ];
  const candidatePaths = new Set<string>();
  if (typeof knownPath === "string" && knownPath.trim().length > 0) {
    candidatePaths.add(path.resolve(knownPath));
  }

  for (const root of roots) {
    const matches = await collectSessionArtifactPaths(root, sessionId);
    for (const match of matches) {
      candidatePaths.add(path.resolve(match));
    }
  }

  const deletedPaths: Array<string> = [];
  for (const candidatePath of candidatePaths) {
    try {
      await rm(candidatePath, { force: true });
      deletedPaths.push(candidatePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  return deletedPaths;
}

function hasPendingApprovalsForThread(threadId: string): boolean {
  for (const approval of pendingApprovals.values()) {
    if (approval.threadId === threadId && approval.status === "pending") {
      return true;
    }
  }

  return false;
}

function clearPendingApprovalsForThread(threadId: string): void {
  for (const [approvalId, approval] of pendingApprovals.entries()) {
    if (approval.threadId !== threadId) {
      continue;
    }

    upsertSupplementalTranscriptEntry(threadId, approvalResolutionToTranscriptEntry(approval, { status: "expired" }));
    pendingApprovals.delete(approvalId);
    publishToSockets(
      "approval_resolved",
      {
        approvalId,
        status: "expired"
      },
      threadId
    );
  }
}

function hasPendingToolInputsForThread(threadId: string): boolean {
  for (const item of pendingToolUserInputs.values()) {
    if (item.threadId === threadId && item.status === "pending") {
      return true;
    }
  }

  return false;
}

function toPublicToolUserInput(record: PendingToolUserInputRecord): PendingToolUserInput {
  const { rpcId: _rpcId, ...rest } = record;
  return rest;
}

function listPendingToolInputsByThread(threadId: string): Array<PendingToolUserInput> {
  const requests: Array<PendingToolUserInput> = [];
  for (const request of pendingToolUserInputs.values()) {
    if (request.threadId !== threadId || request.status !== "pending") {
      continue;
    }

    requests.push(toPublicToolUserInput(request));
  }

  requests.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return requests;
}

function normalizeToolUserInputQuestion(input: unknown): ToolUserInputQuestion | null {
  if (!isObjectRecord(input)) {
    return null;
  }

  if (typeof input.id !== "string" || typeof input.header !== "string" || typeof input.question !== "string") {
    return null;
  }

  let options: Array<ToolUserInputQuestionOption> | null = null;
  if (Array.isArray(input.options)) {
    options = input.options
      .map((entry) => {
        if (!isObjectRecord(entry)) {
          return null;
        }

        if (typeof entry.label !== "string" || typeof entry.description !== "string") {
          return null;
        }

        return {
          label: entry.label,
          description: entry.description
        };
      })
      .filter((entry): entry is ToolUserInputQuestionOption => entry !== null);
  }

  return {
    id: input.id,
    header: input.header,
    question: input.question,
    options,
    isOther: input.isOther === true,
    isSecret: input.isSecret === true
  };
}

function buildToolUserInputSummary(params: Record<string, unknown>): string {
  const questions = Array.isArray(params.questions) ? params.questions.length : 0;
  const label = questions === 1 ? "question" : "questions";
  return `Tool input required (${questions} ${label})`;
}

function createPendingToolUserInput(serverRequest: JsonRpcServerRequest): PendingToolUserInputRecord | null {
  if (serverRequest.method !== "item/tool/requestUserInput" && serverRequest.method !== "tool/requestUserInput") {
    return null;
  }

  if (!isObjectRecord(serverRequest.params)) {
    return null;
  }

  const threadId = extractThreadId(serverRequest.params);
  if (!threadId) {
    return null;
  }

  const questions = Array.isArray(serverRequest.params.questions)
    ? serverRequest.params.questions
        .map((entry) => normalizeToolUserInputQuestion(entry))
        .filter((entry): entry is ToolUserInputQuestion => entry !== null)
    : [];

  const requestId = String(serverRequest.id);
  return {
    requestId,
    rpcId: serverRequest.id,
    method: serverRequest.method,
    threadId,
    turnId: extractTurnId(serverRequest.params),
    itemId: extractItemId(serverRequest.params),
    summary: buildToolUserInputSummary(serverRequest.params),
    questions,
    details: serverRequest.params,
    createdAt: new Date().toISOString(),
    status: "pending"
  };
}

function approvalToTranscriptEntry(approval: PendingApprovalRecord): TranscriptEntry {
  const startedAt = coerceEpochMs(approval.createdAt) ?? Date.now();
  return {
    messageId: `approval-${approval.approvalId}`,
    turnId: approval.turnId ?? "approval",
    role: "system",
    type: "approval.request",
    content: approval.summary,
    details: stringifyDetails({
      method: approval.method,
      createdAt: approval.createdAt,
      ...approval.details
    }),
    startedAt,
    status: "complete"
  };
}

function approvalResolutionToTranscriptEntry(
  approval: PendingApprovalRecord,
  payload: { status: string; decision?: string; scope?: string }
): TranscriptEntry {
  const decisionText = typeof payload.decision === "string" ? ` (${payload.decision})` : "";
  const statusText = typeof payload.status === "string" ? payload.status : "resolved";
  const completedAt = Date.now();
  const startedAt = coerceEpochMs(approval.createdAt) ?? completedAt;
  return {
    messageId: `approval-${approval.approvalId}`,
    turnId: approval.turnId ?? "approval",
    role: "system",
    type: "approval.resolved",
    content: `Approval ${statusText}${decisionText}`,
    details: stringifyDetails({
      approvalId: approval.approvalId,
      ...payload
    }),
    startedAt,
    completedAt,
    status: "complete"
  };
}

function toolInputToTranscriptEntry(request: PendingToolUserInputRecord): TranscriptEntry {
  const startedAt = coerceEpochMs(request.createdAt) ?? Date.now();
  return {
    messageId: `tool-input-${request.requestId}`,
    turnId: request.turnId ?? "tool-input",
    role: "system",
    type: "tool_input.request",
    content: request.summary,
    details: stringifyDetails({
      method: request.method,
      createdAt: request.createdAt,
      questions: request.questions,
      ...request.details
    }),
    startedAt,
    status: "complete"
  };
}

function toolInputResolutionToTranscriptEntry(
  request: PendingToolUserInputRecord,
  payload: { status: string; decision?: string }
): TranscriptEntry {
  const decisionText = typeof payload.decision === "string" ? ` (${payload.decision})` : "";
  const statusText = typeof payload.status === "string" ? payload.status : "resolved";
  const completedAt = Date.now();
  const startedAt = coerceEpochMs(request.createdAt) ?? completedAt;
  return {
    messageId: `tool-input-${request.requestId}`,
    turnId: request.turnId ?? "tool-input",
    role: "system",
    type: "tool_input.resolved",
    content: `Tool input ${statusText}${decisionText}`,
    details: stringifyDetails({
      requestId: request.requestId,
      ...payload
    }),
    startedAt,
    completedAt,
    status: "complete"
  };
}

function clearPendingToolInputsForThread(threadId: string): void {
  for (const [requestId, pending] of pendingToolUserInputs.entries()) {
    if (pending.threadId !== threadId) {
      continue;
    }

    upsertSupplementalTranscriptEntry(threadId, toolInputResolutionToTranscriptEntry(pending, { status: "expired" }));
    pendingToolUserInputs.delete(requestId);
    publishToSockets(
      "tool_user_input_resolved",
      {
        requestId,
        status: "expired"
      },
      threadId
    );
  }
}

function clearPendingToolInputsForTurn(threadId: string, turnId: string): void {
  for (const [requestId, pending] of pendingToolUserInputs.entries()) {
    if (pending.threadId !== threadId || pending.turnId !== turnId) {
      continue;
    }

    upsertSupplementalTranscriptEntry(threadId, toolInputResolutionToTranscriptEntry(pending, { status: "expired" }));
    pendingToolUserInputs.delete(requestId);
    publishToSockets(
      "tool_user_input_resolved",
      {
        requestId,
        status: "expired"
      },
      threadId
    );
  }
}

function toolUserInputResponsePayload(body: {
  decision: ToolUserInputDecisionInput;
  answers?: Record<string, { answers: Array<string> }>;
  response?: unknown;
}): unknown {
  if (body.response !== undefined) {
    return body.response;
  }

  if (body.decision === "accept") {
    return {
      answers: body.answers ?? {}
    };
  }

  return {
    status: body.decision
  };
}

function isMethodUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const lower = error.message.toLowerCase();
  return (
    lower.includes("rpc error -32601") ||
    lower.includes("method not found") ||
    lower.includes("unknown variant") ||
    lower.includes("requires experimentalapi capability") ||
    lower.includes("experimental api capability")
  );
}

function isInvalidParamsError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const lower = error.message.toLowerCase();
  return lower.includes("rpc error -32602") || lower.includes("missing field") || lower.includes("invalid type");
}

function isInvalidRequestStateError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const lower = error.message.toLowerCase();
  return (
    lower.includes("rpc error -32600") ||
    lower.includes("cannot rollback while a turn is in progress") ||
    lower.includes("turn is in progress") ||
    lower.includes("already in progress")
  );
}

function isExperimentalRawEventsUnsupportedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const lower = error.message.toLowerCase();
  return lower.includes("experimentalrawevents") && lower.includes("experimentalapi");
}

async function callThreadMethodWithRawEventsFallback<T>(
  method: "thread/start" | "thread/resume" | "thread/fork",
  params: Record<string, unknown>
): Promise<T> {
  const shouldTryRawEvents = experimentalRawEventsCapability !== "unsupported";
  if (!shouldTryRawEvents) {
    return codexRuntime.call<T>(method, params);
  }

  try {
    const response = await codexRuntime.call<T>(method, {
      ...params,
      experimentalRawEvents: true
    });
    experimentalRawEventsCapability = "supported";
    return response;
  } catch (error) {
    if (!isExperimentalRawEventsUnsupportedError(error)) {
      throw error;
    }

    experimentalRawEventsCapability = "unsupported";
    return codexRuntime.call<T>(method, params);
  }
}

function isAuthRequiredError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const lower = error.message.toLowerCase();
  return (
    lower.includes("unauthorized") ||
    lower.includes("missing bearer or basic authentication") ||
    lower.includes("authentication required")
  );
}

function mapCodexError(error: unknown, fallbackMessage = "codex call failed"): {
  httpStatus: number;
  code: string;
  message: string;
} {
  if (isMethodUnavailableError(error)) {
    return {
      httpStatus: 501,
      code: "method_not_supported",
      message: error instanceof Error ? error.message : fallbackMessage
    };
  }

  if (isInvalidParamsError(error)) {
    return {
      httpStatus: 400,
      code: "invalid_params",
      message: error instanceof Error ? error.message : fallbackMessage
    };
  }

  if (isInvalidRequestStateError(error)) {
    return {
      httpStatus: 409,
      code: "invalid_state",
      message: error instanceof Error ? error.message : fallbackMessage
    };
  }

  if (isAuthRequiredError(error)) {
    return {
      httpStatus: 401,
      code: "auth_required",
      message: error instanceof Error ? error.message : fallbackMessage
    };
  }

  if (error instanceof Error && error.message.toLowerCase().includes("timed out")) {
    return {
      httpStatus: 504,
      code: "codex_timeout",
      message: error.message
    };
  }

  return {
    httpStatus: 500,
    code: "codex_error",
    message: error instanceof Error ? error.message : fallbackMessage
  };
}

function sendMappedCodexError(
  reply: { code: (statusCode: number) => unknown },
  error: unknown,
  fallbackMessage: string,
  details?: Record<string, unknown>
): { status: "error"; code: string; message: string; details?: Record<string, unknown> } {
  const mapped = mapCodexError(error, fallbackMessage);
  reply.code(mapped.httpStatus);
  return {
    status: "error",
    code: mapped.code,
    message: mapped.message,
    ...(details ? { details } : {})
  };
}

function classifyCapabilityProbeError(error: unknown): CapabilityEntry {
  if (isMethodUnavailableError(error)) {
    return {
      status: "disabled",
      reason: error instanceof Error ? error.message : "method unavailable"
    };
  }

  if (
    isInvalidParamsError(error) ||
    isInvalidRequestStateError(error) ||
    isAuthRequiredError(error) ||
    isNoRolloutFoundError(error)
  ) {
    return {
      status: "available",
      reason: error instanceof Error ? error.message : "runtime validation"
    };
  }

  if (error instanceof Error) {
    return {
      status: "unknown",
      reason: error.message
    };
  }

  return {
    status: "unknown",
    reason: "unknown error"
  };
}

async function refreshCapabilities(): Promise<void> {
  if (capabilitiesRefreshInFlight) {
    return capabilitiesRefreshInFlight;
  }

  const task = (async () => {
    const next = new Map<string, CapabilityEntry>();
    for (const probe of capabilityMethodProbes) {
      try {
        await codexRuntime.call(probe.method, probe.probeParams);
        next.set(probe.method, {
          status: "available",
          reason: null
        });
      } catch (error) {
        next.set(probe.method, classifyCapabilityProbeError(error));
      }
    }

    capabilitiesByMethod.clear();
    for (const [method, result] of next.entries()) {
      capabilitiesByMethod.set(method, result);
    }

    capabilitiesInitialized = true;
    capabilitiesLastUpdatedAt = new Date().toISOString();
  })();

  capabilitiesRefreshInFlight = task;
  try {
    await task;
  } finally {
    capabilitiesRefreshInFlight = null;
  }
}

function methodCapabilityStatus(method: string): CapabilityStatus {
  return capabilitiesByMethod.get(method)?.status ?? "unknown";
}

function capabilityFeatures(): Record<string, boolean> {
  return {
    toolUserInput:
      methodCapabilityStatus("item/tool/requestUserInput") === "available" ||
      methodCapabilityStatus("tool/requestUserInput") === "available",
    threadFork: methodCapabilityStatus("thread/fork") === "available",
    threadCompact: methodCapabilityStatus("thread/compact/start") === "available",
    threadRollback: methodCapabilityStatus("thread/rollback") === "available",
    threadBackgroundTerminalClean: methodCapabilityStatus("thread/backgroundTerminals/clean") === "available",
    turnSteer: methodCapabilityStatus("turn/steer") === "available",
    reviewStart: methodCapabilityStatus("review/start") === "available",
    commandExec: methodCapabilityStatus("command/exec") === "available",
    feedbackUpload: methodCapabilityStatus("feedback/upload") === "available",
    mcpOauth: methodCapabilityStatus("mcpServer/oauth/login") === "available",
    mcpReload: methodCapabilityStatus("config/mcpServer/reload") === "available",
    accountLifecycle:
      methodCapabilityStatus("account/read") === "available" &&
      methodCapabilityStatus("account/login/start") === "available" &&
      methodCapabilityStatus("account/logout") === "available",
    configRead: methodCapabilityStatus("config/read") === "available",
    configWrite:
      methodCapabilityStatus("config/value/write") === "available" ||
      methodCapabilityStatus("config/batchWrite") === "available",
    configRequirements: methodCapabilityStatus("configRequirements/read") === "available",
    apps: methodCapabilityStatus("app/list") === "available",
    skills: methodCapabilityStatus("skills/list") === "available",
    collaborationModes: methodCapabilityStatus("collaborationMode/list") === "available",
    experimentalFeatures: methodCapabilityStatus("experimentalFeature/list") === "available",
    planUpdates: true,
    diffUpdates: true,
    tokenUsage: true
  };
}

async function resolveKnownSessionTitle(sessionId: string): Promise<string | undefined> {
  const storedTitle = sessionMetadata.titles[sessionId];
  if (typeof storedTitle === "string" && storedTitle.trim().length > 0) {
    return storedTitle.trim();
  }

  try {
    const response = await codexRuntime.call<{ thread: CodexThread & { threadName?: unknown; name?: unknown } }>(
      "thread/read",
      {
        threadId: sessionId,
        includeTurns: false
      }
    );
    return resolveSessionTitle(response.thread);
  } catch (error) {
    if (isNoRolloutFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function listThreadIdsByArchiveState(archived: boolean): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;

  do {
    const response: { data: Array<CodexThread>; nextCursor: string | null } = await codexRuntime.call("thread/list", {
      archived,
      limit: 200,
      cursor: cursor ?? undefined
    });

    for (const thread of response.data) {
      if (!isSessionPurged(thread.id)) {
        ids.add(thread.id);
      }
    }

    cursor = response.nextCursor;
  } while (cursor);

  return ids;
}

async function sessionExistsForProjectAssignment(sessionId: string): Promise<boolean> {
  try {
    await codexRuntime.call("thread/read", {
      threadId: sessionId,
      includeTurns: false
    });
    return true;
  } catch (error) {
    if (isMissingThreadError(error)) {
      return false;
    }

    if (!isNoRolloutFoundError(error)) {
      throw error;
    }
  }

  const loaded = await codexRuntime.call<{ data: Array<string> }>("thread/loaded/list", {});
  return loaded.data.includes(sessionId);
}

async function classifyProjectSessionsForArchive(sessionIds: Array<string>): Promise<{
  archivableSessionIds: Array<string>;
  alreadyArchivedSessionIds: Array<string>;
  notMaterializedSessionIds: Array<string>;
}> {
  const activeIds = await listThreadIdsByArchiveState(false);
  const archivedIds = await listThreadIdsByArchiveState(true);

  const archivableSessionIds: Array<string> = [];
  const alreadyArchivedSessionIds: Array<string> = [];
  const notMaterializedSessionIds: Array<string> = [];

  for (const sessionId of sessionIds) {
    if (archivedIds.has(sessionId)) {
      alreadyArchivedSessionIds.push(sessionId);
      continue;
    }

    if (activeIds.has(sessionId)) {
      archivableSessionIds.push(sessionId);
      continue;
    }

    notMaterializedSessionIds.push(sessionId);
  }

  return {
    archivableSessionIds,
    alreadyArchivedSessionIds,
    notMaterializedSessionIds
  };
}

async function classifyProjectSessionAssignments(sessionIds: Array<string>): Promise<{
  existingSessionIds: Array<string>;
  staleSessionIds: Array<string>;
}> {
  if (sessionIds.length === 0) {
    return {
      existingSessionIds: [],
      staleSessionIds: []
    };
  }

  const [activeIds, archivedIds, loaded] = await Promise.all([
    listThreadIdsByArchiveState(false),
    listThreadIdsByArchiveState(true),
    codexRuntime.call<{ data: Array<string> }>("thread/loaded/list", {})
  ]);

  const knownSessionIds = new Set<string>();
  for (const sessionId of activeIds) {
    knownSessionIds.add(sessionId);
  }
  for (const sessionId of archivedIds) {
    knownSessionIds.add(sessionId);
  }
  for (const sessionId of loaded.data) {
    if (!isSessionPurged(sessionId)) {
      knownSessionIds.add(sessionId);
    }
  }

  const existingSessionIds: Array<string> = [];
  const staleSessionIds: Array<string> = [];

  for (const sessionId of sessionIds) {
    if (knownSessionIds.has(sessionId)) {
      existingSessionIds.push(sessionId);
      continue;
    }
    staleSessionIds.push(sessionId);
  }

  return {
    existingSessionIds,
    staleSessionIds
  };
}

async function pruneStaleSessionControlMetadata(): Promise<number> {
  const sessionIds = new Set<string>([
    ...Object.keys(sessionMetadata.sessionControlsById),
    ...Object.keys(sessionMetadata.sessionApprovalPolicyById)
  ]);

  if (sessionIds.size === 0) {
    return 0;
  }

  const classification = await classifyProjectSessionAssignments(Array.from(sessionIds));
  if (classification.staleSessionIds.length === 0) {
    return 0;
  }

  let changed = false;
  for (const sessionId of classification.staleSessionIds) {
    if (setSessionControls(sessionId, null)) {
      changed = true;
    }
  }

  if (changed) {
    await persistSessionMetadata();
  }

  return classification.staleSessionIds.length;
}

async function hardDeleteSession(sessionId: string): Promise<HardDeleteSessionOutcome> {
  if (isSessionPurged(sessionId)) {
    const sessionScopedAgentMappingChanged = clearSessionScopedAgentSessionMappingsForSourceSession(sessionId);
    const systemMetadataChanged = setSystemOwnedSession(sessionId, false);
    const policyMetadataChanged = setSessionApprovalPolicy(sessionId, null);
    const turnTimingMetadataChanged = clearSessionTurnTimings(sessionId);
    clearSupplementalTranscriptEntries(sessionId);
    if (sessionScopedAgentMappingChanged || systemMetadataChanged || policyMetadataChanged || turnTimingMetadataChanged) {
      await persistSessionMetadata();
    }
    return {
      status: "gone",
      payload: deletedSessionPayload(sessionId, sessionMetadata.titles[sessionId])
    };
  }

  const activeTurnId = activeTurnByThread.get(sessionId);
  if (activeTurnId) {
    try {
      await codexRuntime.call("turn/interrupt", {
        threadId: sessionId,
        turnId: activeTurnId
      });
    } catch (error) {
      app.log.warn({ error, sessionId, turnId: activeTurnId }, "failed to interrupt active turn before delete");
    }
  }

  let knownTitle: string | undefined;
  let knownPath: string | null = null;
  let sessionReadSucceeded = false;
  try {
    const response = await codexRuntime.call<{
      thread: CodexThread & { path?: unknown; rolloutPath?: unknown; threadName?: unknown; name?: unknown };
    }>("thread/read", {
      threadId: sessionId,
      includeTurns: false
    });
    sessionReadSucceeded = true;
    knownTitle = resolveSessionTitle(response.thread);
    if (typeof response.thread.path === "string" && response.thread.path.trim().length > 0) {
      knownPath = response.thread.path;
    } else if (typeof response.thread.rolloutPath === "string" && response.thread.rolloutPath.trim().length > 0) {
      knownPath = response.thread.rolloutPath;
    }
  } catch (error) {
    if (!isNoRolloutFoundError(error)) {
      throw error;
    }
  }

  const deletedPaths = await purgeRolloutFilesForSession(sessionId, knownPath);
  const existsInMemory =
    activeTurnByThread.has(sessionId) ||
    hasPendingApprovalsForThread(sessionId) ||
    hasPendingToolInputsForThread(sessionId) ||
    sessionReadSucceeded ||
    knownPath !== null;
  if (!existsInMemory && deletedPaths.length === 0) {
    const sessionScopedAgentMappingChanged = clearSessionScopedAgentSessionMappingsForSourceSession(sessionId);
    const titleMetadataChanged = setSessionTitleOverride(sessionId, null);
    const projectMetadataChanged = setSessionProjectAssignment(sessionId, null);
    const policyMetadataChanged = setSessionApprovalPolicy(sessionId, null);
    const turnTimingMetadataChanged = clearSessionTurnTimings(sessionId);
    clearFileChangeEventsForThread(sessionId);
    clearSupplementalTranscriptEntries(sessionId);
    if (
      sessionScopedAgentMappingChanged ||
      titleMetadataChanged ||
      projectMetadataChanged ||
      policyMetadataChanged ||
      turnTimingMetadataChanged
    ) {
      await persistSessionMetadata();
    }
    return {
      status: "not_found",
      sessionId
    };
  }

  if (!knownTitle) {
    knownTitle = await resolveKnownSessionTitle(sessionId);
  }

  activeTurnByThread.delete(sessionId);
  clearFileChangeEventsForThread(sessionId);
  clearSupplementalTranscriptEntries(sessionId);
  clearPendingApprovalsForThread(sessionId);
  clearPendingToolInputsForThread(sessionId);
  purgedSessionIds.add(sessionId);

  const wasSystemOwned = isSystemOwnedSession(sessionId);
  const sessionScopedAgentMappingChanged = clearSessionScopedAgentSessionMappingsForSourceSession(sessionId);
  const titleMetadataChanged = setSessionTitleOverride(sessionId, null);
  const projectMetadataChanged = setSessionProjectAssignment(sessionId, null);
  const systemMetadataChanged = setSystemOwnedSession(sessionId, false);
  const policyMetadataChanged = setSessionApprovalPolicy(sessionId, null);
  const turnTimingMetadataChanged = clearSessionTurnTimings(sessionId);
  if (
    sessionScopedAgentMappingChanged ||
    titleMetadataChanged ||
    projectMetadataChanged ||
    systemMetadataChanged ||
    policyMetadataChanged ||
    turnTimingMetadataChanged
  ) {
    await persistSessionMetadata();
  }

  const payload = deletedSessionPayload(sessionId, knownTitle);
  publishToSockets("session_deleted", payload, sessionId, {
    broadcastToAll: true,
    ...(wasSystemOwned ? { forceThreadFilter: true } : {})
  });

  return {
    status: "deleted",
    sessionId,
    title: payload.title ?? null,
    deletedFileCount: deletedPaths.length,
    payload
  };
}

function socketMessageToString(raw: unknown): string | null {
  if (typeof raw === "string") {
    return raw;
  }

  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }

  if (Array.isArray(raw)) {
    return Buffer.concat(raw as Array<Buffer>).toString("utf8");
  }

  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }

  return null;
}

function publishToSockets(
  type: string,
  payload: unknown,
  threadId?: string,
  options?: { broadcastToAll?: boolean; forceThreadFilter?: boolean }
): void {
  const envelope = JSON.stringify({
    type,
    threadId: threadId ?? null,
    payload
  });
  const isSystemThreadEvent =
    options?.forceThreadFilter === true || (typeof threadId === "string" && isSystemOwnedSession(threadId));

  for (const socket of sockets) {
    const filter = socketThreadFilter.get(socket) ?? null;
    if (isSystemThreadEvent && filter !== threadId) {
      continue;
    }
    if (!options?.broadcastToAll) {
      if (filter && threadId && filter !== threadId) {
        continue;
      }

      if (filter && !threadId) {
        continue;
      }
    }

    if (socket.readyState !== 1) {
      continue;
    }

    try {
      socket.send(envelope);
    } catch (error) {
      app.log.warn({ error }, "failed to publish websocket message");
    }
  }
}

const MAX_AGENT_ACTION_IDEMPOTENCY_ENTRIES = 5_000;

function agentActionResultWithEnvelope(
  envelope: z.infer<typeof agentActionEnvelopeSchema>,
  result: AgentRuntimeActionResult
): AgentRuntimeActionResult {
  return {
    ...result,
    ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
    ...(envelope.idempotencyKey ? { idempotencyKey: envelope.idempotencyKey } : {})
  };
}

function readAgentActionReplayResult(
  envelope: z.infer<typeof agentActionEnvelopeSchema>,
  scope?: AgentRuntimeActionExecutionScope
): AgentRuntimeActionResult | null {
  if (!envelope.idempotencyKey) {
    return null;
  }

  const existing = agentActionResultByIdempotencyKey.get(envelope.idempotencyKey);
  if (!existing) {
    return null;
  }

  const signature = normalizeAgentActionSignature({
    actionType: envelope.actionType,
    payload: envelope.payload,
    scope
  });
  if (existing.signature !== signature) {
    return {
      actionType: envelope.actionType,
      status: "conflict",
      ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
      idempotencyKey: envelope.idempotencyKey,
      details: {
        code: "idempotency_conflict",
        message: "idempotency key was reused with a different action payload"
      }
    };
  }

  return agentActionResultWithEnvelope(envelope, existing.result);
}

function rememberAgentActionResult(
  envelope: z.infer<typeof agentActionEnvelopeSchema>,
  result: AgentRuntimeActionResult,
  scope?: AgentRuntimeActionExecutionScope
): void {
  if (!envelope.idempotencyKey) {
    return;
  }

  const storedResult = agentActionResultWithEnvelope(envelope, result);
  const signature = normalizeAgentActionSignature({
    actionType: envelope.actionType,
    payload: envelope.payload,
    scope
  });
  agentActionResultByIdempotencyKey.set(envelope.idempotencyKey, {
    signature,
    result: storedResult
  });

  while (agentActionResultByIdempotencyKey.size > MAX_AGENT_ACTION_IDEMPOTENCY_ENTRIES) {
    const oldest = agentActionResultByIdempotencyKey.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    agentActionResultByIdempotencyKey.delete(oldest);
  }
}

function invalidAgentActionResult(
  input: {
    actionType: string;
    requestId?: string;
    idempotencyKey?: string;
    message: string;
    issues?: unknown;
  }
): AgentRuntimeActionResult {
  return {
    actionType: input.actionType,
    status: "invalid",
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    details: {
      message: input.message,
      ...(input.issues ? { issues: input.issues } : {})
    }
  };
}

function forbiddenAgentActionResult(
  input: {
    actionType: string;
    requestId?: string;
    idempotencyKey?: string;
    code: string;
    message: string;
    details?: Record<string, unknown>;
  }
): AgentRuntimeActionResult {
  return {
    actionType: input.actionType,
    status: "forbidden",
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    details: {
      code: input.code,
      message: input.message,
      ...(input.details ? input.details : {})
    }
  };
}

type AgentRuntimeActionExecutionScope = {
  projectId?: string | null;
  sourceSessionId?: string | null;
  turnId?: string | null;
};

type AgentRuntimeActionCapabilityContext = {
  extensionName: string;
  declaredCapabilities: AgentExtensionCapabilityDeclaration | null;
};

type ExecuteAgentRuntimeActionOptions = {
  scope?: AgentRuntimeActionExecutionScope;
  capability?: AgentRuntimeActionCapabilityContext;
};

async function executeAgentRuntimeAction(
  input: AgentRuntimeActionRequest,
  options?: ExecuteAgentRuntimeActionOptions
): Promise<AgentRuntimeActionResult> {
  const envelopeParsed = agentActionEnvelopeSchema.safeParse(input);
  if (!envelopeParsed.success) {
    const actionType = typeof input.actionType === "string" && input.actionType.trim().length > 0 ? input.actionType : "unknown";
    return invalidAgentActionResult({
      actionType,
      requestId: typeof input.requestId === "string" ? input.requestId : undefined,
      idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey : undefined,
      message: "action request envelope is invalid",
      issues: envelopeParsed.error.issues
    });
  }

  const envelope = envelopeParsed.data;

  if (options?.capability) {
    const capability = evaluateActionCapability({
      mode: env.AGENT_EXTENSION_TRUST_MODE,
      extensionName: options.capability.extensionName,
      declaredCapabilities: options.capability.declaredCapabilities,
      actionType: envelope.actionType
    });
    if (!capability.allowed) {
      return forbiddenAgentActionResult({
        actionType: envelope.actionType,
        ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
        ...(envelope.idempotencyKey ? { idempotencyKey: envelope.idempotencyKey } : {}),
        code: "undeclared_capability",
        message: capability.reason ?? `action capability ${envelope.actionType} is not declared`
      });
    }
    if (capability.reason) {
      app.log.warn(
        {
          extensionName: options.capability.extensionName,
          actionType: envelope.actionType,
          reason: capability.reason
        },
        "agent action capability was not declared"
      );
    }
  }

  const replay = readAgentActionReplayResult(envelope, options?.scope);
  if (replay) {
    return replay;
  }

  let result: AgentRuntimeActionResult;

  if (envelope.actionType === "transcript.upsert") {
    const payloadParsed = agentActionTranscriptPayloadSchema.safeParse(envelope.payload);
    if (!payloadParsed.success) {
      result = invalidAgentActionResult({
        actionType: envelope.actionType,
        message: "transcript.upsert payload is invalid",
        issues: payloadParsed.error.issues
      });
    } else {
      const payload = payloadParsed.data;
      const scopeSessionId = options?.scope?.sourceSessionId?.trim();
      if (scopeSessionId && payload.sessionId !== scopeSessionId) {
        result = forbiddenAgentActionResult({
          actionType: envelope.actionType,
          ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
          ...(envelope.idempotencyKey ? { idempotencyKey: envelope.idempotencyKey } : {}),
          code: "scope_session_mismatch",
          message: `transcript.upsert sessionId must match sourceSessionId=${scopeSessionId}`,
          details: {
            expectedSessionId: scopeSessionId,
            receivedSessionId: payload.sessionId
          }
        });
      } else if (options?.scope?.turnId && payload.entry.turnId !== options.scope.turnId) {
        result = forbiddenAgentActionResult({
          actionType: envelope.actionType,
          ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
          ...(envelope.idempotencyKey ? { idempotencyKey: envelope.idempotencyKey } : {}),
          code: "scope_turn_mismatch",
          message: `transcript.upsert turnId must match turnId=${options.scope.turnId}`,
          details: {
            expectedTurnId: options.scope.turnId,
            receivedTurnId: payload.entry.turnId
          }
        });
      } else if (!(await sessionExistsForProjectAssignment(payload.sessionId))) {
        result = {
          actionType: envelope.actionType,
          status: "failed",
          ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
          ...(envelope.idempotencyKey ? { idempotencyKey: envelope.idempotencyKey } : {}),
          details: {
            code: "session_not_found",
            message: `session ${payload.sessionId} was not found`
          }
        };
      } else {
        const normalizedDetails = normalizeActionTranscriptDetails(payload.entry.details);
        const upsertResult = await runtimeProfileAdapter.upsertTranscript({
          sessionId: payload.sessionId,
          entry: {
            messageId: payload.entry.messageId,
            turnId: payload.entry.turnId,
            role: payload.entry.role,
            type: payload.entry.type,
            content: payload.entry.content,
            ...(normalizedDetails !== null ? { details: normalizedDetails } : {}),
            status: payload.entry.status,
            ...(typeof payload.entry.startedAt === "number" ? { startedAt: payload.entry.startedAt } : {}),
            ...(typeof payload.entry.completedAt === "number" ? { completedAt: payload.entry.completedAt } : {})
          }
        });
        result = {
          actionType: envelope.actionType,
          status: upsertResult.status,
          details: upsertResult.details
        };
      }
    }
  } else if (envelope.actionType === "approval.decide") {
    const payloadParsed = agentActionApprovalPayloadSchema.safeParse(envelope.payload);
    if (!payloadParsed.success) {
      result = invalidAgentActionResult({
        actionType: envelope.actionType,
        message: "approval.decide payload is invalid",
        issues: payloadParsed.error.issues
      });
    } else {
      const payload = payloadParsed.data;
      const approval = pendingApprovals.get(payload.approvalId);
      if (!approval) {
        result = {
          actionType: envelope.actionType,
          status: "already_resolved",
          details: {
            approvalId: payload.approvalId
          }
        };
      } else {
        const scopeSessionId = options?.scope?.sourceSessionId?.trim();
        if (scopeSessionId && approval.threadId !== scopeSessionId) {
          result = forbiddenAgentActionResult({
            actionType: envelope.actionType,
            ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
            ...(envelope.idempotencyKey ? { idempotencyKey: envelope.idempotencyKey } : {}),
            code: "scope_session_mismatch",
            message: `approval.decide approval thread must match sourceSessionId=${scopeSessionId}`,
            details: {
              approvalId: payload.approvalId,
              expectedSessionId: scopeSessionId,
              receivedSessionId: approval.threadId
            }
          });
        } else if (options?.scope?.turnId && approval.turnId !== options.scope.turnId) {
          result = forbiddenAgentActionResult({
            actionType: envelope.actionType,
            ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
            ...(envelope.idempotencyKey ? { idempotencyKey: envelope.idempotencyKey } : {}),
            code: "scope_turn_mismatch",
            message: `approval.decide approval turn must match turnId=${options.scope.turnId}`,
            details: {
              approvalId: payload.approvalId,
              expectedTurnId: options.scope.turnId,
              receivedTurnId: approval.turnId
            }
          });
        } else {
          const scope = payload.scope ?? "turn";
          const rawPayload = approvalDecisionPayload(approval, payload.decision, scope);
          const responsePayload = isObjectRecord(rawPayload) ? rawPayload : {};
          const decisionResult = await runtimeProfileAdapter.decideApproval({
            rpcId: approval.rpcId,
            payload: responsePayload,
            approvalId: payload.approvalId,
            threadId: approval.threadId,
            actionType: payload.decision === "accept" ? "approval.accept" : "approval.decline"
          });

          if (decisionResult.status === "performed") {
            upsertSupplementalTranscriptEntry(
              approval.threadId,
              approvalResolutionToTranscriptEntry(approval, {
                status: "resolved",
                decision: payload.decision,
                scope
              })
            );
            pendingApprovals.delete(payload.approvalId);
            publishToSockets(
              "approval_resolved",
              {
                approvalId: payload.approvalId,
                status: "resolved",
                decision: payload.decision,
                scope
              },
              approval.threadId
            );
          }

          result = {
            actionType: envelope.actionType,
            status: decisionResult.status,
            details: {
              ...(decisionResult.details ?? {}),
              approvalId: payload.approvalId,
              threadId: approval.threadId
            }
          };
        }
      }
    }
  } else if (envelope.actionType === "turn.steer.create") {
    const payloadParsed = agentActionSteerPayloadSchema.safeParse(envelope.payload);
    if (!payloadParsed.success) {
      result = invalidAgentActionResult({
        actionType: envelope.actionType,
        message: "turn.steer.create payload is invalid",
        issues: payloadParsed.error.issues
      });
    } else {
      const payload = payloadParsed.data;
      const scopeSessionId = options?.scope?.sourceSessionId?.trim();
      if (scopeSessionId && payload.sessionId !== scopeSessionId) {
        result = forbiddenAgentActionResult({
          actionType: envelope.actionType,
          ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
          ...(envelope.idempotencyKey ? { idempotencyKey: envelope.idempotencyKey } : {}),
          code: "scope_session_mismatch",
          message: `turn.steer.create sessionId must match sourceSessionId=${scopeSessionId}`,
          details: {
            expectedSessionId: scopeSessionId,
            receivedSessionId: payload.sessionId
          }
        });
      } else if (options?.scope?.turnId && payload.turnId !== options.scope.turnId) {
        result = forbiddenAgentActionResult({
          actionType: envelope.actionType,
          ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
          ...(envelope.idempotencyKey ? { idempotencyKey: envelope.idempotencyKey } : {}),
          code: "scope_turn_mismatch",
          message: `turn.steer.create turnId must match turnId=${options.scope.turnId}`,
          details: {
            expectedTurnId: options.scope.turnId,
            receivedTurnId: payload.turnId
          }
        });
      } else {
        const steerResult = await runtimeProfileAdapter.steerTurn({
          sessionId: payload.sessionId,
          turnId: payload.turnId,
          input: payload.input
        });
        result = {
          actionType: envelope.actionType,
          status: steerResult.status,
          details: steerResult.details
        };
      }
    }
  } else if (envelope.actionType === "queue.enqueue") {
    const payloadParsed = agentActionQueueEnqueuePayloadSchema.safeParse(envelope.payload);
    if (!payloadParsed.success) {
      result = invalidAgentActionResult({
        actionType: envelope.actionType,
        message: "queue.enqueue payload is invalid",
        issues: payloadParsed.error.issues
      });
    } else {
      const payload = payloadParsed.data;
      const scopeProjectId = options?.scope?.projectId?.trim();
      const scopeSessionId = options?.scope?.sourceSessionId?.trim();
      const scopedSourceSessionId = payload.sourceSessionId ?? scopeSessionId ?? null;
      if (scopeProjectId && payload.projectId !== scopeProjectId) {
        result = forbiddenAgentActionResult({
          actionType: envelope.actionType,
          ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
          ...(envelope.idempotencyKey ? { idempotencyKey: envelope.idempotencyKey } : {}),
          code: "scope_project_mismatch",
          message: `queue.enqueue projectId must match projectId=${scopeProjectId}`,
          details: {
            expectedProjectId: scopeProjectId,
            receivedProjectId: payload.projectId
          }
        });
      } else if (scopeSessionId && scopedSourceSessionId && scopedSourceSessionId !== scopeSessionId) {
        result = forbiddenAgentActionResult({
          actionType: envelope.actionType,
          ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
          ...(envelope.idempotencyKey ? { idempotencyKey: envelope.idempotencyKey } : {}),
          code: "scope_session_mismatch",
          message: `queue.enqueue sourceSessionId must match sourceSessionId=${scopeSessionId}`,
          details: {
            expectedSessionId: scopeSessionId,
            receivedSessionId: payload.sourceSessionId
          }
        });
      } else {
        try {
          const enqueueResult = await enqueueJobForAgentEvent({
            type: payload.type,
            projectId: payload.projectId,
            sourceSessionId: scopedSourceSessionId,
            payload: payload.payload
          });
          result = {
            actionType: envelope.actionType,
            status: enqueueResult.status === "already_queued" ? "already_resolved" : "performed",
            details: {
              enqueueStatus: enqueueResult.status,
              job: enqueueResult.job
            }
          };
        } catch (error) {
          result = {
            actionType: envelope.actionType,
            status: "failed",
            details: {
              message: error instanceof Error ? error.message : String(error)
            }
          };
        }
      }
    }
  } else {
    result = invalidAgentActionResult({
      actionType: envelope.actionType,
      message: `unsupported actionType: ${envelope.actionType}`
    });
  }

  const withEnvelope = agentActionResultWithEnvelope(envelope, result);
  if (isReplayCacheableActionStatus(withEnvelope.status)) {
    rememberAgentActionResult(envelope, withEnvelope, options?.scope);
  }
  return withEnvelope;
}

async function enqueueJobForAgentEvent(input: EnqueueJobInput): Promise<EnqueueJobResult> {
  if (!orchestratorQueue) {
    throw new Error("orchestrator queue is unavailable");
  }

  return orchestratorQueue.enqueue(input);
}

function resolveAgentActionScopeFromEventPayload(payload: Record<string, unknown>): AgentRuntimeActionExecutionScope | null {
  const context = isObjectRecord(payload.context) ? payload.context : null;
  const projectId =
    normalizeNonEmptyString(context?.projectId) ?? normalizeNonEmptyString(payload.projectId) ?? null;
  const sourceSessionId =
    normalizeNonEmptyString(context?.sourceSessionId) ??
    normalizeNonEmptyString(context?.threadId) ??
    normalizeNonEmptyString(payload.sourceSessionId) ??
    normalizeNonEmptyString(payload.sessionId) ??
    normalizeNonEmptyString(payload.threadId) ??
    null;
  const turnId = normalizeNonEmptyString(context?.turnId) ?? normalizeNonEmptyString(payload.turnId) ?? null;
  if (!projectId && !sourceSessionId && !turnId) {
    return null;
  }
  return {
    projectId,
    sourceSessionId,
    turnId
  };
}

async function emitAgentEvent(type: string, payload: Record<string, unknown>): Promise<Array<AgentEventEmitResult>> {
  const actionScope = resolveAgentActionScopeFromEventPayload(payload);
  const results = await agentEventsRuntime.emit(
    {
      type,
      payload
    },
    {
      enqueueJob: enqueueJobForAgentEvent,
      logger: app.log
    },
    {
      executeAction: async (actionRequest) =>
        executeAgentRuntimeAction(actionRequest, actionScope ? { scope: actionScope } : undefined)
    }
  );

  const actionSummary = summarizeActionReconciliation(results);
  app.log.debug(
    {
      eventType: type,
      resultCount: results.length,
      enqueueCount: results.filter((result) => result.kind === "enqueue_result").length,
      actionCount: results.filter((result) => result.kind === "action_result").length,
      handlerErrorCount: results.filter((result) => result.kind === "handler_error").length,
      actionWinner: actionSummary.winner
        ? {
            moduleName: actionSummary.winner.moduleName,
            actionType: actionSummary.winner.actionType,
            status: actionSummary.winner.status
          }
        : null,
      reconciledStatuses: actionSummary.reconciledStatuses
    },
    "agent event aggregation summary"
  );

  return results;
}

function publishTranscriptUpdated(
  threadId: string,
  payload: {
    turnId?: string;
    messageId?: string;
    type?: string;
    entry?: TranscriptEntry;
  }
): void {
  publishToSockets(
    "transcript_updated",
    {
      threadId,
      ...payload
    },
    threadId
  );
}

function agentInstructionOutputMessageId(jobId: string): string {
  return `agent-job-output::${jobId}`;
}

type AgentInstructionSupplementalTarget = {
  messageId: string;
  type: string;
  placeholderMatches: Array<string>;
  placeholderContent: string | null;
  completeFallback: string;
  errorFallback: string;
  canceledFallback: string;
};

function defaultSupplementalFallback(type: string, terminalStatus: "complete" | "error" | "canceled"): string {
  if (terminalStatus === "complete") {
    return `${type} completed, but no detailed output was produced.`;
  }
  if (terminalStatus === "error") {
    return `${type} failed before detailed output was produced.`;
  }
  return `${type} was canceled before detailed output was produced.`;
}

function expectedSupplementalTargetsForAgentInstruction(
  payload: AgentInstructionJobPayload
): Array<AgentInstructionSupplementalTarget> {
  if (!Array.isArray(payload.supplementalTargets) || payload.supplementalTargets.length === 0) {
    return [];
  }

  const normalizedTargets: Array<AgentInstructionSupplementalTarget> = [];
  const seenMessageIds = new Set<string>();
  for (const target of payload.supplementalTargets) {
    if (!isObjectRecord(target)) {
      continue;
    }
    const messageId = typeof target.messageId === "string" ? target.messageId.trim() : "";
    const type = typeof target.type === "string" ? target.type.trim() : "";
    if (!messageId || !type || seenMessageIds.has(messageId)) {
      continue;
    }

    const placeholderTexts = Array.isArray(target.placeholderTexts)
      ? target.placeholderTexts
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];

    normalizedTargets.push({
      messageId,
      type,
      placeholderMatches: placeholderTexts.map((entry) => entry.toLowerCase()),
      placeholderContent: placeholderTexts[0] ?? null,
      completeFallback:
        typeof target.completeFallback === "string" && target.completeFallback.trim().length > 0
          ? target.completeFallback.trim()
          : defaultSupplementalFallback(type, "complete"),
      errorFallback:
        typeof target.errorFallback === "string" && target.errorFallback.trim().length > 0
          ? target.errorFallback.trim()
          : defaultSupplementalFallback(type, "error"),
      canceledFallback:
        typeof target.canceledFallback === "string" && target.canceledFallback.trim().length > 0
          ? target.canceledFallback.trim()
          : defaultSupplementalFallback(type, "canceled")
    });
    seenMessageIds.add(messageId);
  }

  return normalizedTargets;
}

function isSupplementalPlaceholderContent(value: string, target: AgentInstructionSupplementalTarget): boolean {
  if (target.placeholderMatches.length === 0) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return target.placeholderMatches.includes(normalized);
}

function initializeAgentInstructionSupplementalStreamingEntries(payload: AgentInstructionJobPayload): void {
  const targets = expectedSupplementalTargetsForAgentInstruction(payload);
  if (targets.length === 0) {
    return;
  }

  const now = Date.now();
  const threadEntries = supplementalTranscriptByThread.get(payload.sourceSessionId);
  for (const target of targets) {
    const existing = threadEntries?.get(target.messageId)?.entry;
    if (existing?.status === "complete" || existing?.status === "streaming") {
      continue;
    }

    const content = target.placeholderContent ?? `${target.type} queued...`;
    const entry: TranscriptEntry = {
      messageId: target.messageId,
      turnId: payload.turnId,
      role: "system",
      type: target.type,
      content,
      details:
        typeof existing?.details === "string" && existing.details.trim().length > 0
          ? existing.details
          : JSON.stringify({
              anchorItemId: payload.anchorItemId ?? payload.itemId ?? null,
              approvalId: payload.approvalId ?? null
            }),
      status: "streaming",
      startedAt: existing?.startedAt ?? now
    };

    upsertSupplementalTranscriptEntry(payload.sourceSessionId, entry);
    publishTranscriptUpdated(payload.sourceSessionId, {
      turnId: entry.turnId,
      messageId: entry.messageId,
      type: entry.type,
      entry
    });
  }
}

function reconcileAgentInstructionSupplementalStreamingEntries(input: {
  payload: AgentInstructionJobPayload;
  terminalStatus: "complete" | "error" | "canceled";
  errorMessage?: string;
}): void {
  const targets = expectedSupplementalTargetsForAgentInstruction(input.payload);
  if (targets.length === 0) {
    return;
  }

  const threadEntries = supplementalTranscriptByThread.get(input.payload.sourceSessionId);
  const now = Date.now();
  for (const target of targets) {
    const existing = threadEntries?.get(target.messageId)?.entry;
    if (
      shouldPreserveSuccessfulSupplementalEntry({
        existingStatus: existing?.status,
        terminalStatus: input.terminalStatus
      })
    ) {
      continue;
    }

    let content = existing?.content.trim() ?? "";
    const placeholderContent = isSupplementalPlaceholderContent(content, target);
    if (content.length === 0 || placeholderContent) {
      if (input.terminalStatus === "complete") {
        content = target.completeFallback;
      } else if (input.terminalStatus === "error") {
        const reason = typeof input.errorMessage === "string" && input.errorMessage.trim().length > 0 ? input.errorMessage : null;
        content = reason ? `${target.errorFallback} (${reason})` : target.errorFallback;
      } else {
        content = target.canceledFallback;
      }
    }

    const existingDetails = typeof existing?.details === "string" ? existing.details : "";
    const details =
      existingDetails.trim().length > 0
        ? existingDetails
        : JSON.stringify({
            anchorItemId: input.payload.anchorItemId ?? input.payload.itemId ?? null,
            approvalId: input.payload.approvalId ?? null
          });

    const shouldUpsert =
      !existing ||
      existing.status !== input.terminalStatus ||
      existing.content.trim() !== content ||
      (input.terminalStatus === "complete" && isSupplementalPlaceholderContent(existing.content, target));

    if (!shouldUpsert) {
      continue;
    }

    upsertSupplementalTranscriptEntry(input.payload.sourceSessionId, {
      messageId: target.messageId,
      turnId: input.payload.turnId,
      role: "system",
      type: target.type,
      content,
      details,
      status: input.terminalStatus,
      startedAt: existing?.startedAt ?? now,
      completedAt: now
    });

    const entry: TranscriptEntry = {
      messageId: target.messageId,
      turnId: input.payload.turnId,
      role: "system",
      type: target.type,
      content,
      details,
      status: input.terminalStatus,
      startedAt: existing?.startedAt ?? now,
      completedAt: now
    };

    publishTranscriptUpdated(input.payload.sourceSessionId, {
      turnId: input.payload.turnId,
      messageId: target.messageId,
      type: target.type,
      entry
    });
  }
}

function buildAgentInstructionOutputDetails(payload: AgentInstructionJobPayload, jobId: string): string {
  const details: Record<string, unknown> = {
    jobId,
    jobKind: payload.jobKind,
    agent: payload.agent,
    projectId: payload.projectId,
    sourceSessionId: payload.sourceSessionId,
    sourceThreadId: payload.threadId,
    sourceTurnId: payload.turnId
  };

  if (payload.itemId) {
    details.itemId = payload.itemId;
  }
  if (payload.anchorItemId) {
    details.anchorItemId = payload.anchorItemId;
  }
  if (payload.approvalId) {
    details.approvalId = payload.approvalId;
  }

  return JSON.stringify(details);
}

function upsertAgentInstructionOutputTranscript(input: {
  payload: AgentInstructionJobPayload;
  jobId: string;
  status: TranscriptEntry["status"];
  content: string;
}): void {
  const content = input.content.trim();
  if (!content) {
    return;
  }

  const now = Date.now();
  const messageId = agentInstructionOutputMessageId(input.jobId);
  const details = buildAgentInstructionOutputDetails(input.payload, input.jobId);

  const entry: TranscriptEntry = {
    messageId,
    turnId: input.payload.turnId,
    role: "system",
    type: "agent.jobOutput",
    content,
    details,
    status: input.status,
    startedAt: now,
    ...(input.status === "streaming" ? {} : { completedAt: now })
  };

  upsertSupplementalTranscriptEntry(input.payload.sourceSessionId, entry);

  publishTranscriptUpdated(input.payload.sourceSessionId, {
    turnId: input.payload.turnId,
    messageId,
    type: "agent.jobOutput",
    entry
  });
}

function summarizeActionIntentExecutionResults(results: Array<AgentRuntimeActionResult>): string {
  if (results.length === 0) {
    return "Agent action intent job completed with zero intents.";
  }

  const byStatus = new Map<string, number>();
  for (const result of results) {
    byStatus.set(result.status, (byStatus.get(result.status) ?? 0) + 1);
  }

  const orderedStatuses = ["performed", "already_resolved", "not_eligible", "conflict", "forbidden", "invalid", "failed"];
  const statusSummary = orderedStatuses
    .filter((status) => byStatus.has(status))
    .map((status) => `${status}=${byStatus.get(status)}`)
    .join(", ");

  return `Agent action intents executed (${results.length}): ${statusSummary || "no-status"}.`;
}

function withCoreIdempotencyForActionIntent(input: {
  payload: AgentInstructionJobPayload;
  intent: AgentInstructionActionIntent;
}): AgentInstructionActionIntent {
  if (input.intent.idempotencyKey && input.intent.idempotencyKey.trim().length > 0) {
    return input.intent;
  }

  const signature = normalizeAgentActionSignature({
    actionType: input.intent.actionType,
    payload: input.intent.payload,
    scope: {
      projectId: input.payload.projectId,
      sourceSessionId: input.payload.sourceSessionId,
      turnId: input.payload.turnId
    }
  });
  const signatureHash = hashAgentActionSignature(signature);
  return {
    ...input.intent,
    idempotencyKey: [
      "agent-intent",
      input.payload.projectId,
      input.payload.sourceSessionId,
      input.payload.turnId,
      input.payload.jobKind,
      signatureHash
    ].join(":")
  };
}

function agentRetryDelayMs(attempt: number): number {
  return Math.max(0, (Math.max(1, attempt) - 1) * 60);
}

function buildOrchestratorJobDefinitions(): JobDefinitionsMap {
  const definitions: Array<any> = [];

  if (env.ORCHESTRATOR_SUGGEST_REQUEST_ENABLED) {
    definitions.push({
      type: "suggest_request",
      version: 1,
      priority: "interactive",
      payloadSchema: suggestRequestJobPayloadSchema,
      resultSchema: suggestRequestJobResultSchema,
      dedupe: {
        key: (payload: SuggestRequestJobPayload) => `${payload.projectId}:${payload.sessionId}:suggest_request`,
        mode: "single_flight"
      },
      retry: {
        maxAttempts: env.ORCHESTRATOR_QUEUE_MAX_ATTEMPTS,
        classify: (error: unknown) => {
          const message =
            error instanceof Error
              ? error.message.toLowerCase()
              : typeof error === "string"
                ? error.toLowerCase()
                : "";
          if (
            message.includes("timed out") ||
            message.includes("timeout") ||
            message.includes("thread not found") ||
            message.includes("conversation not found") ||
            message.includes("invalid thread id") ||
            message.includes("invalid conversation id") ||
            message.includes("no rollout found for thread id") ||
            message.includes("no rollout found for conversation id") ||
            message.includes("made no item progress") ||
            message.includes("temporarily unavailable")
          ) {
            return "retryable";
          }
          return "fatal";
        },
        baseDelayMs: 60,
        maxDelayMs: 10_000,
        jitter: false,
        delayForAttempt: agentRetryDelayMs
      },
      timeoutMs: env.ORCHESTRATOR_QUEUE_DEFAULT_TIMEOUT_MS,
      cancel: {
        strategy: "interrupt_turn",
        gracefulWaitMs: 1_500
      },
      run: async (ctx: JobRunContext, payload: SuggestRequestJobPayload) =>
        generateSuggestedRequestForJob(payload, {
          signal: ctx.signal,
          onTurnStarted: (threadId, turnId) => {
            ctx.setRunningContext({ threadId, turnId });
          }
        })
    });
  }

  definitions.push({
    type: "agent_instruction",
    version: 1,
    priority: "interactive",
    payloadSchema: agentInstructionJobPayloadSchema,
    resultSchema: agentInstructionJobResultSchema,
    dedupe: {
      key: (payload: AgentInstructionJobPayload) =>
        payload.dedupeKey
          ? `${payload.projectId}:${payload.dedupeKey}`
          : `${payload.projectId}:${payload.threadId}:${payload.turnId}:${payload.jobKind}`,
      mode: "single_flight"
    },
    retry: {
      maxAttempts: env.ORCHESTRATOR_QUEUE_MAX_ATTEMPTS,
      classify: (error: unknown) => {
        const message =
          error instanceof Error
            ? error.message.toLowerCase()
            : typeof error === "string"
              ? error.toLowerCase()
              : "";
        if (
          message.includes("timed out") ||
          message.includes("timeout") ||
          message.includes("temporarily unavailable") ||
          message.includes("thread not found") ||
          message.includes("conversation not found") ||
          message.includes("invalid thread id") ||
          message.includes("invalid conversation id") ||
          message.includes("no rollout found for thread id") ||
          message.includes("no rollout found for conversation id") ||
          message.includes("made no item progress") ||
          message.includes("includeturns is unavailable before first user message") ||
          (message.includes("not materialized yet") && message.includes("includeturns"))
        ) {
          return "retryable";
        }
        return "fatal";
      },
      baseDelayMs: 60,
      maxDelayMs: 10_000,
      jitter: false,
      delayForAttempt: agentRetryDelayMs
    },
    timeoutMs: Math.max(env.ORCHESTRATOR_QUEUE_DEFAULT_TIMEOUT_MS, 180_000),
    cancel: {
      strategy: "interrupt_turn",
      gracefulWaitMs: 1_500
    },
    run: async (ctx: JobRunContext, payload: AgentInstructionJobPayload) => {
      const expectsActionIntents = payload.expectResponse === "action_intents";
      const captureAssistantOutput = payload.expectResponse === "assistant_text";
      let latestOutputText: string | null = null;
      let latestOutputStatus: "streaming" | "complete" | null = null;
      initializeAgentInstructionSupplementalStreamingEntries(payload);

      const runner =
        payload.completionSignal?.kind === "suggested_request"
          ? runAgentInstructionJobWithSuggestedRequestDeadline
          : runAgentInstructionJob;

      const result = await runner(payload, {
        signal: ctx.signal,
        jobId: ctx.jobId,
        onTurnStarted: (threadId, turnId) => {
          ctx.setRunningContext({ threadId, turnId });
        },
        onOutputUpdate: captureAssistantOutput
          ? (update) => {
              const normalizedText = normalizeAgentOutputText(update.text);
              if (!normalizedText) {
                return;
              }
              if (latestOutputText === normalizedText && latestOutputStatus === update.status) {
                return;
              }

              latestOutputText = normalizedText;
              latestOutputStatus = update.status;
              ctx.emitProgress({
                stage: "assistant_output",
                status: update.status,
                text: normalizedText
              });
              upsertAgentInstructionOutputTranscript({
                payload,
                jobId: ctx.jobId,
                status: update.status === "complete" ? "complete" : "streaming",
                content: normalizedText
              });
            }
          : undefined
      });

      const finalOutputText = typeof result.outputText === "string" ? normalizeAgentOutputText(result.outputText) : "";
      if (captureAssistantOutput) {
        if (finalOutputText) {
          if (latestOutputText !== finalOutputText || latestOutputStatus !== "complete") {
            ctx.emitProgress({
              stage: "assistant_output",
              status: "complete",
              text: finalOutputText
            });
            upsertAgentInstructionOutputTranscript({
              payload,
              jobId: ctx.jobId,
              status: "complete",
              content: finalOutputText
            });
          }
        } else if (!latestOutputText) {
          upsertAgentInstructionOutputTranscript({
            payload,
            jobId: ctx.jobId,
            status: "complete",
            content: "Agent job completed with no assistant output."
          });
        }
      }

      const actionResults: Array<AgentRuntimeActionResult> = [];
      if (expectsActionIntents) {
        const intents = Array.isArray(result.actionIntents) ? result.actionIntents : [];
        const capability = resolveActionCapabilityContextForAgent(payload.agent);
        if (!capability.declaredCapabilities) {
          throw new Error(`agent ${payload.agent} has no loaded capabilities manifest; refusing action intent execution`);
        }
        for (const [index, intent] of intents.entries()) {
          const normalizedIntent = withCoreIdempotencyForActionIntent({
            payload,
            intent
          });
          const actionResult = await executeAgentRuntimeAction(normalizedIntent, {
            scope: {
              projectId: payload.projectId,
              sourceSessionId: payload.sourceSessionId,
              turnId: payload.turnId
            },
            capability
          });
          actionResults.push(actionResult);
          ctx.emitProgress({
            stage: "action_intent",
            index: index + 1,
            actionType: actionResult.actionType,
            status: actionResult.status
          });
        }
        const fatalActionResults = actionResults.filter(
          (entry) => entry.status === "failed" || entry.status === "invalid" || entry.status === "forbidden"
        );
        if (fatalActionResults.length > 0) {
          const fatalSummary = fatalActionResults.map((entry) => `${entry.actionType}:${entry.status}`).join(", ");
          throw new Error(`agent action intents returned fatal statuses: ${fatalSummary}`);
        }
        upsertAgentInstructionOutputTranscript({
          payload,
          jobId: ctx.jobId,
          status: "complete",
          content: summarizeActionIntentExecutionResults(actionResults)
        });
      }

      reconcileAgentInstructionSupplementalStreamingEntries({
        payload,
        terminalStatus: "complete"
      });

      const normalizedResult = finalOutputText ? { ...result, outputText: finalOutputText } : result;
      if (actionResults.length > 0) {
        return {
          ...normalizedResult,
          actionResults
        };
      }
      return normalizedResult;
    },
    onFailed: async (_ctx: JobRunContext, payload: AgentInstructionJobPayload, error: string, jobId: string) => {
      upsertAgentInstructionOutputTranscript({
        payload,
        jobId,
        status: "error",
        content: `Agent job failed: ${error}`
      });
      reconcileAgentInstructionSupplementalStreamingEntries({
        payload,
        terminalStatus: "error",
        errorMessage: error
      });
    },
    onCanceled: async (_ctx: JobRunContext, payload: AgentInstructionJobPayload, jobId: string) => {
      upsertAgentInstructionOutputTranscript({
        payload,
        jobId,
        status: "canceled",
        content: "Agent job canceled before completion."
      });
      reconcileAgentInstructionSupplementalStreamingEntries({
        payload,
        terminalStatus: "canceled"
      });
    }
  });

  return createJobDefinitionsRegistry(definitions);
}

function ensureOrchestratorQueue(reply: { code: (statusCode: number) => void }): OrchestratorQueue | null {
  if (!orchestratorQueue) {
    reply.code(503);
    return null;
  }
  return orchestratorQueue;
}

function sendOrchestratorQueueError(
  reply: { code: (statusCode: number) => void },
  error: unknown,
  sessionId: string
): {
  status: "error";
  code: "queue_full" | "job_conflict" | "invalid_payload";
  sessionId: string;
  message: string;
} {
  if (error instanceof OrchestratorQueueError) {
    if (error.code === "queue_full" || error.code === "job_conflict" || error.code === "invalid_payload") {
      reply.code(error.statusCode);
      return {
        status: "error",
        code: error.code,
        sessionId,
        message: error.message
      };
    }
  }

  throw error;
}

function toPublicApproval(record: PendingApprovalRecord): PendingApproval {
  const { rpcId: _rpcId, ...rest } = record;
  return rest;
}

function currentAuthStatus(): AuthStatus {
  const hasOpenAiApiKey = typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.trim().length > 0;
  const codexHomeAuthFile = codexHomeAuthFilePath ? existsSync(codexHomeAuthFilePath) : false;
  const likelyUnauthenticated = !hasOpenAiApiKey && !codexHomeAuthFile;

  return {
    hasOpenAiApiKey,
    codexHomeAuthFile,
    likelyUnauthenticated
  };
}

function isIncludeTurnsUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("includeturns is unavailable before first user message") ||
    (message.includes("not materialized yet") && message.includes("includeturns"))
  );
}

function buildApprovalSummary(method: ApprovalMethod, params: Record<string, unknown>): string {
  if (method === "item/commandExecution/requestApproval") {
    const command = typeof params.command === "string" ? params.command : null;
    const reason = typeof params.reason === "string" ? params.reason : null;
    if (command) {
      return `Command approval required: ${command}`;
    }
    if (reason) {
      return `Command approval required: ${reason}`;
    }
    return "Command approval required";
  }

  if (method === "item/fileChange/requestApproval") {
    const reason = typeof params.reason === "string" ? params.reason : null;
    return reason ? `File change approval required: ${reason}` : "File change approval required";
  }

  if (method === "execCommandApproval") {
    const command = Array.isArray(params.command)
      ? params.command.filter((entry): entry is string => typeof entry === "string").join(" ")
      : "";
    return command ? `Command approval required: ${command}` : "Command approval required";
  }

  const reason = typeof params.reason === "string" ? params.reason : null;
  return reason ? `Patch approval required: ${reason}` : "Patch approval required";
}

function createPendingApproval(serverRequest: JsonRpcServerRequest): PendingApprovalRecord | null {
  const supportedMethods = new Set<ApprovalMethod>([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "execCommandApproval",
    "applyPatchApproval"
  ]);

  if (!supportedMethods.has(serverRequest.method as ApprovalMethod)) {
    return null;
  }

  if (!isObjectRecord(serverRequest.params)) {
    return null;
  }

  const method = serverRequest.method as ApprovalMethod;
  const threadId = extractThreadId(serverRequest.params);
  if (!threadId) {
    return null;
  }

  const approvalId = String(serverRequest.id);
  return {
    approvalId,
    rpcId: serverRequest.id,
    method,
    threadId,
    turnId: extractTurnId(serverRequest.params),
    itemId: extractItemId(serverRequest.params),
    summary: buildApprovalSummary(method, serverRequest.params),
    details: serverRequest.params,
    createdAt: new Date().toISOString(),
    status: "pending"
  };
}

function approvalDecisionPayload(
  approval: PendingApprovalRecord,
  decision: ApprovalDecisionInput,
  scope: "turn" | "session"
): unknown {
  if (approval.method === "item/commandExecution/requestApproval") {
    const mappedDecision =
      decision === "accept"
        ? scope === "session"
          ? "acceptForSession"
          : "accept"
        : decision === "decline"
          ? "decline"
          : "cancel";

    return { decision: mappedDecision };
  }

  if (approval.method === "item/fileChange/requestApproval") {
    const mappedDecision =
      decision === "accept"
        ? scope === "session"
          ? "acceptForSession"
          : "accept"
        : decision === "decline"
          ? "decline"
          : "cancel";

    return { decision: mappedDecision };
  }

  const mappedDecision =
    decision === "accept"
      ? scope === "session"
        ? "approved_for_session"
        : "approved"
      : decision === "decline"
        ? "denied"
        : "abort";

  return { decision: mappedDecision };
}

function toTurnSandboxPolicy(
  mode: DefaultSandboxMode,
  networkAccess: NetworkAccess = "restricted"
): { type: "readOnly" | "workspaceWrite" | "dangerFullAccess"; networkAccess?: boolean } {
  const networkAccessEnabled = networkAccess === "enabled";

  if (mode === "read-only") {
    return networkAccessEnabled ? { type: "readOnly", networkAccess: true } : { type: "readOnly" };
  }

  if (mode === "workspace-write") {
    return { type: "workspaceWrite", networkAccess: networkAccessEnabled };
  }

  return networkAccessEnabled ? { type: "dangerFullAccess", networkAccess: true } : { type: "dangerFullAccess" };
}

function listPendingApprovalRecordsByThread(threadId: string): Array<PendingApprovalRecord> {
  const approvals: Array<PendingApprovalRecord> = [];
  for (const approval of pendingApprovals.values()) {
    if (approval.threadId === threadId && approval.status === "pending") {
      approvals.push(approval);
    }
  }

  approvals.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return approvals;
}

function listPendingApprovalsByThread(threadId: string): Array<PendingApproval> {
  return listPendingApprovalRecordsByThread(threadId).map((approval) => toPublicApproval(approval));
}

function clearPendingApprovalsForTurn(threadId: string, turnId: string): void {
  for (const [approvalId, approval] of pendingApprovals.entries()) {
    if (approval.threadId !== threadId) {
      continue;
    }

    if (approval.turnId !== turnId) {
      continue;
    }

    upsertSupplementalTranscriptEntry(threadId, approvalResolutionToTranscriptEntry(approval, { status: "expired" }));
    pendingApprovals.delete(approvalId);
    publishToSockets(
      "approval_resolved",
      {
        approvalId,
        status: "expired"
      },
      threadId
    );
  }
}

codexRuntime.on("notification", (notification: JsonRpcNotification) => {
  const threadId = extractThreadId(notification.params);
  observeRuntimeTurnNotification(notification, threadId);
  if (threadId && isSessionPurged(threadId)) {
    return;
  }

  if (notification.method === "thread/name/updated") {
    const params = notification.params as { threadId?: unknown; threadName?: unknown } | undefined;
    if (typeof params?.threadId === "string") {
      const hasTitleOverride = typeof sessionMetadata.titles[params.threadId] === "string";
      if (!hasTitleOverride && setSessionTitleOverride(params.threadId, typeof params.threadName === "string" ? params.threadName : null)) {
        void persistSessionMetadata().catch((error) => {
          app.log.warn({ error, threadId: params.threadId }, "failed to persist session metadata after rename notification");
        });
      }
    }
  }

  if (notification.method === "turn/started") {
    const params = notification.params as { threadId?: unknown; turn?: { id?: unknown } } | undefined;
    if (typeof params?.threadId === "string" && typeof params.turn?.id === "string") {
      const activeTurnId = activeTurnByThread.get(params.threadId);
      const incomingTurnId = params.turn.id;
      if (!activeTurnId || activeTurnId === incomingTurnId || incomingTurnId.localeCompare(activeTurnId) >= 0) {
        activeTurnByThread.set(params.threadId, incomingTurnId);
      }
      const turnRecord = params.turn as Record<string, unknown>;
      const startedAt =
        coerceEpochMs(turnRecord.startedAt) ??
        coerceEpochMs(turnRecord.started_at) ??
        coerceEpochMs(turnRecord.startTime) ??
        coerceEpochMs(turnRecord.start_time) ??
        Date.now();
      if (setTurnStartedAt(params.threadId, params.turn.id, startedAt)) {
        void persistSessionMetadata().catch((error) => {
          app.log.warn({ error, threadId: params.threadId, turnId: params.turn?.id }, "failed to persist turn started timing");
        });
      }
    }
  }

  if (notification.method === "turn/completed" || notification.method === "turn/failed") {
    const params = notification.params as { threadId?: unknown; turn?: { id?: unknown } } | undefined;
    if (typeof params?.threadId === "string") {
      const completedTurnId = typeof params.turn?.id === "string" ? params.turn.id : null;
      if (!completedTurnId || activeTurnByThread.get(params.threadId) === completedTurnId) {
        activeTurnByThread.delete(params.threadId);
      }

      if (typeof params.turn?.id === "string") {
        const turnRecord = params.turn as Record<string, unknown>;
        const startedAt =
          coerceEpochMs(turnRecord.startedAt) ??
          coerceEpochMs(turnRecord.started_at) ??
          coerceEpochMs(turnRecord.startTime) ??
          coerceEpochMs(turnRecord.start_time);
        const completedAt =
          coerceEpochMs(turnRecord.completedAt) ??
          coerceEpochMs(turnRecord.completed_at) ??
          coerceEpochMs(turnRecord.endTime) ??
          coerceEpochMs(turnRecord.end_time) ??
          Date.now();

        let timingChanged = false;
        if (startedAt !== null) {
          timingChanged = setTurnStartedAt(params.threadId, params.turn.id, startedAt) || timingChanged;
        }
        timingChanged = setTurnCompletedAt(params.threadId, params.turn.id, completedAt) || timingChanged;
        if (timingChanged) {
          void persistSessionMetadata().catch((error) => {
            app.log.warn({ error, threadId: params.threadId, turnId: params.turn?.id }, "failed to persist turn completed timing");
          });
        }

        clearPendingApprovalsForTurn(params.threadId, params.turn.id);
        clearPendingToolInputsForTurn(params.threadId, params.turn.id);

        if (notification.method === "turn/completed" && !isSystemOwnedSession(params.threadId)) {
          maybeEmitTurnCompletedAgentEvent(params.threadId, params.turn.id);
        }
      }
    }
  }

  if (notification.method === "turn/plan/updated") {
    publishToSockets("turn_plan_updated", notification.params ?? {}, threadId);
  }

  if (notification.method === "turn/diff/updated") {
    publishToSockets("turn_diff_updated", notification.params ?? {}, threadId);
  }

  if (
    (notification.method === "item/started" || notification.method === "item/completed") &&
    threadId &&
    isObjectRecord(notification.params) &&
    isObjectRecord(notification.params.item) &&
    typeof notification.params.item.id === "string"
  ) {
    const item = notification.params.item as CodexThreadItem;
    const turnId = extractTurnId(notification.params) ?? activeTurnByThread.get(threadId) ?? "turn";
    const observedAt = Date.now();
    const itemStartedAt = extractItemStartedAt(item);
    const itemCompletedAt = extractItemCompletedAt(item);
    const transcriptEntry = itemToTranscriptEntry(turnId, item);
    if (notification.method === "item/started") {
      transcriptEntry.status = "streaming";
      transcriptEntry.startedAt = itemStartedAt ?? observedAt;
    } else {
      transcriptEntry.status = "complete";
      if (itemStartedAt !== null) {
        transcriptEntry.startedAt = itemStartedAt;
      }
      transcriptEntry.completedAt = itemCompletedAt ?? observedAt;
    }
    upsertSupplementalTranscriptEntry(threadId, transcriptEntry);

  }

  if (notification.method === "thread/tokenUsage/updated") {
    publishToSockets("thread_token_usage_updated", notification.params ?? {}, threadId);
  }

  if (notification.method === "app/list/updated") {
    publishToSockets("app_list_updated", notification.params ?? {}, threadId, { broadcastToAll: true });
  }

  if (notification.method === "mcpServer/oauthLogin/completed") {
    publishToSockets("mcp_oauth_completed", notification.params ?? {}, threadId, { broadcastToAll: true });
  }

  if (notification.method === "account/updated") {
    publishToSockets("account_updated", notification.params ?? {}, threadId, { broadcastToAll: true });
  }

  if (notification.method === "account/login/completed") {
    publishToSockets("account_login_completed", notification.params ?? {}, threadId, { broadcastToAll: true });
  }

  if (notification.method === "account/rateLimits/updated") {
    publishToSockets("account_rate_limits_updated", notification.params ?? {}, threadId, { broadcastToAll: true });
  }

  publishToSockets("notification", notification, threadId);
});

codexRuntime.on("serverRequest", (serverRequest: JsonRpcServerRequest) => {
  const requestThreadId = extractThreadId(serverRequest.params);
  if (requestThreadId && isSystemOwnedSession(requestThreadId)) {
    const lifecycleTurnId = extractTurnId(serverRequest.params) ?? activeTurnByThread.get(requestThreadId) ?? "turn";
    const lifecycleMessageId = `agent-worker-lifecycle::system-request::${String(serverRequest.id)}`;
    const approval = createPendingApproval(serverRequest);
    if (approval) {
      upsertAgentWorkerLifecycleEntry({
        sessionId: requestThreadId,
        messageId: lifecycleMessageId,
        turnId: lifecycleTurnId,
        status: "complete",
        content: "Auto-declined approval request in system-owned session.",
        details: {
          phase: "system_request_reconciliation",
          requestId: String(serverRequest.id),
          method: serverRequest.method,
          decision: "decline"
        }
      });
      const payload = approvalDecisionPayload(approval, "decline", "turn");
      void codexRuntime
        .respond(serverRequest.id, payload)
        .catch((error) => {
          app.log.warn({ error, threadId: requestThreadId }, "failed to decline system session approval request");
        });
      return;
    }

    const toolInput = createPendingToolUserInput(serverRequest);
    if (toolInput) {
      upsertAgentWorkerLifecycleEntry({
        sessionId: requestThreadId,
        messageId: lifecycleMessageId,
        turnId: lifecycleTurnId,
        status: "complete",
        content: "Auto-canceled tool user-input request in system-owned session.",
        details: {
          phase: "system_request_reconciliation",
          requestId: String(serverRequest.id),
          method: serverRequest.method,
          decision: "cancel"
        }
      });
      const payload = toolUserInputResponsePayload({
        decision: "cancel"
      });
      void codexRuntime
        .respond(serverRequest.id, payload)
        .catch((error) => {
          app.log.warn({ error, threadId: requestThreadId }, "failed to cancel system session tool input request");
        });
      return;
    }

    upsertAgentWorkerLifecycleEntry({
      sessionId: requestThreadId,
      messageId: lifecycleMessageId,
      turnId: lifecycleTurnId,
      status: "error",
      content: "Rejected unsupported server request in system-owned session.",
      details: {
        phase: "system_request_reconciliation",
        requestId: String(serverRequest.id),
        method: serverRequest.method,
        decision: "error",
        code: -32600
      }
    });
    void codexRuntime
      .respondError(serverRequest.id, {
        code: -32600,
        message: "unsupported system-session server request"
      })
      .catch((error) => {
        app.log.warn({ error, threadId: requestThreadId }, "failed to reject server request for system-owned session");
      });
    return;
  }
  if (requestThreadId && isSessionPurged(requestThreadId)) {
    void codexRuntime
      .respondError(serverRequest.id, {
        code: -32600,
        message: `thread ${requestThreadId} is deleted`
      })
      .catch((error) => {
        app.log.warn({ error, threadId: requestThreadId }, "failed to reject server request for deleted session");
      });
    return;
  }

  const approval = createPendingApproval(serverRequest);

  if (approval) {
    pendingApprovals.set(approval.approvalId, approval);
    upsertSupplementalTranscriptEntry(approval.threadId, approvalToTranscriptEntry(approval));
    publishToSockets("approval", toPublicApproval(approval), approval.threadId);
    void enqueueFileChangeReviewEventFromApproval(approval, "approval_request").catch((error) => {
      app.log.warn(
        {
          error,
          threadId: approval.threadId,
          turnId: approval.turnId,
          itemId: approval.itemId,
          approvalId: approval.approvalId
        },
        "failed to enqueue file-change review event from approval request"
      );
    });

    return;
  }

  const toolUserInput = createPendingToolUserInput(serverRequest);
  if (toolUserInput) {
    pendingToolUserInputs.set(toolUserInput.requestId, toolUserInput);
    upsertSupplementalTranscriptEntry(toolUserInput.threadId, toolInputToTranscriptEntry(toolUserInput));
    publishToSockets("tool_user_input_requested", toPublicToolUserInput(toolUserInput), toolUserInput.threadId);
    return;
  }

  publishToSockets("server_request", serverRequest, requestThreadId);

  void codexRuntime
    .respondError(serverRequest.id, {
      code: -32601,
      message: `client does not support server-initiated method: ${serverRequest.method}`
    })
    .catch((error) => {
      app.log.warn({ error, method: serverRequest.method }, "failed to respond to server request");
    });
});

await app.register(websocket);

app.get("/api/stream", { websocket: true }, (socket, request) => {
  const ws = socket as unknown as WebSocketLike;
  const query = request.query as { threadId?: string };
  const initialThreadId = typeof query.threadId === "string" && query.threadId.length > 0 ? query.threadId : null;

  sockets.add(ws);
  socketThreadFilter.set(ws, initialThreadId);

  ws.send(
    JSON.stringify({
      type: "ready",
      threadId: initialThreadId
    })
  );

  ws.on("message", (raw: unknown) => {
    const rawText = socketMessageToString(raw);
    if (!rawText) {
      return;
    }

    try {
      const parsed = wsCommandSchema.parse(JSON.parse(rawText));

      if (parsed.type === "subscribe") {
        socketThreadFilter.set(ws, parsed.threadId);
      }

      if (parsed.type === "unsubscribe") {
        socketThreadFilter.set(ws, null);
      }

      if (parsed.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch {
      ws.send(
        JSON.stringify({
          type: "error",
          message: "invalid websocket command"
        })
      );
    }
  });

  const cleanup = (): void => {
    sockets.delete(ws);
    socketThreadFilter.delete(ws);
  };

  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

app.get("/api/health", async () => {
  const queueStats = orchestratorQueue ? orchestratorQueue.stats() : null;
  return {
    status: "ok",
    service: "api",
    codex: codexRuntime.status(),
    orchestratorQueue: queueStats
      ? {
          enabled: true,
          ...queueStats
        }
      : {
          enabled: false
        },
    auth: currentAuthStatus(),
    timestamp: new Date().toISOString()
  };
});

app.get("/api", async () => {
  return {
    name: "Codex Manager API",
    version: "0.1.0"
  };
});

app.get("/api/agents/extensions", async (request, reply) => {
  const access = await assertRoleAllowed(request, reply, ["member", "admin", "owner", "system"]);
  if (!access) {
    return;
  }

  const snapshot = agentEventsRuntime.snapshotInfo();
  return {
    status: "ok",
    snapshotVersion: snapshot.snapshotVersion,
    loadedAt: snapshot.loadedAt,
    modules: agentEventsRuntime.listLoadedModules()
  };
});

app.post("/api/agents/extensions/reload", async (request, reply) => {
  const reloadId = randomUUID();
  const snapshotBefore = agentEventsRuntime.snapshotInfo().snapshotVersion;
  const requestRole = await resolveAgentExtensionRequestRole({
    mode: env.AGENT_EXTENSION_RBAC_MODE,
    headers: request.headers as Record<string, unknown>,
    requestIp: typeof request.ip === "string" ? request.ip : null,
    header: {
      secret: env.AGENT_EXTENSION_RBAC_HEADER_SECRET ?? null
    },
    jwt: {
      secret: env.AGENT_EXTENSION_RBAC_JWT_SECRET ?? null,
      issuer: env.AGENT_EXTENSION_RBAC_JWT_ISSUER ?? null,
      audience: env.AGENT_EXTENSION_RBAC_JWT_AUDIENCE ?? null,
      roleClaim: env.AGENT_EXTENSION_RBAC_JWT_ROLE_CLAIM,
      actorClaim: env.AGENT_EXTENSION_RBAC_JWT_ACTOR_CLAIM
    }
  });
  const requestUserAgent = normalizeHeaderValue(request.headers["user-agent"]);

  if (!requestRole.ok) {
    await agentExtensionAuditStore.append({
      reloadId,
      recordedAt: new Date().toISOString(),
      actorRole: "unknown",
      actorId: null,
      requestOrigin: {
        ip: request.ip ?? null,
        userAgent: requestUserAgent
      },
      result: "forbidden",
      snapshotBefore,
      snapshotAfter: null,
      trustMode: env.AGENT_EXTENSION_TRUST_MODE,
      errorSummary: String(requestRole.payload.code ?? requestRole.payload.status ?? "missing_role"),
      impactedExtensions: []
    });
    reply.code(requestRole.statusCode).send(requestRole.payload);
    return;
  }

  if (!["admin", "owner", "system"].includes(requestRole.role)) {
    const payload = {
      status: "forbidden",
      code: "insufficient_role",
      required: ["admin", "owner", "system"],
      role: requestRole.role
    };
    await agentExtensionAuditStore.append({
      reloadId,
      recordedAt: new Date().toISOString(),
      actorRole: requestRole.role,
      actorId: requestRole.actorId,
      requestOrigin: {
        ip: request.ip ?? null,
        userAgent: requestUserAgent
      },
      result: "forbidden",
      snapshotBefore,
      snapshotAfter: null,
      trustMode: env.AGENT_EXTENSION_TRUST_MODE,
      errorSummary: "insufficient_role",
      impactedExtensions: []
    });
    reply.code(403).send(payload);
    return;
  }

  app.log.info(
    {
      reloadId,
      role: requestRole.role,
      actorId: requestRole.actorId,
      snapshotBefore
    },
    "agent extension reload requested"
  );

  const result = await agentEventsRuntime.reload(reloadId);
  if (result.status === "ok") {
    await agentExtensionAuditStore.append({
      reloadId,
      recordedAt: new Date().toISOString(),
      actorRole: requestRole.role,
      actorId: requestRole.actorId,
      requestOrigin: {
        ip: request.ip ?? null,
        userAgent: requestUserAgent
      },
      result: "success",
      snapshotBefore,
      snapshotAfter: result.snapshotVersion,
      trustMode: env.AGENT_EXTENSION_TRUST_MODE,
      errorSummary: null,
      impactedExtensions: result.modules.map((module) => module.name)
    });
    app.log.info(
      {
        reloadId,
        snapshotBefore,
        snapshotAfter: result.snapshotVersion,
        loadedCount: result.loadedCount
      },
      "agent extension reload completed"
    );
    return result;
  }

  await agentExtensionAuditStore.append({
    reloadId,
    recordedAt: new Date().toISOString(),
    actorRole: requestRole.role,
    actorId: requestRole.actorId,
    requestOrigin: {
      ip: request.ip ?? null,
      userAgent: requestUserAgent
    },
    result: "failed",
    snapshotBefore,
    snapshotAfter: null,
    trustMode: env.AGENT_EXTENSION_TRUST_MODE,
    errorSummary: result.errors.map((error) => `${error.code}:${error.message}`).join(" | "),
    impactedExtensions: result.errors.map((error) => error.extension)
  });
  app.log.warn(
    {
      reloadId,
      snapshotBefore,
      errors: result.errors
    },
    "agent extension reload failed"
  );
  reply.code(result.code === "reload_in_progress" ? 409 : 400);
  return result;
});

app.get("/api/capabilities", async (request) => {
  const query = capabilityQuerySchema.parse(request.query);
  if (query.refresh === "true" || !capabilitiesInitialized) {
    await refreshCapabilities();
  }

  const methods: Record<string, CapabilityStatus> = {};
  const details: Record<string, { status: CapabilityStatus; reason: string | null }> = {};

  for (const probe of capabilityMethodProbes) {
    const entry = capabilitiesByMethod.get(probe.method) ?? { status: "unknown", reason: null };
    methods[probe.method] = entry.status;
    details[probe.method] = entry;
  }

  return {
    status: "ok",
    runtime: {
      initialized: codexRuntime.status().initialized,
      capabilitiesLastUpdatedAt
    },
    methods,
    details,
    features: capabilityFeatures()
  };
});

app.get("/api/features/experimental", async (request, reply) => {
  const query = listQuerySchema.parse(request.query);
  try {
    const response = await codexRuntime.call<{ data: Array<Record<string, unknown>>; nextCursor: string | null }>(
      "experimentalFeature/list",
      {
        limit: query.limit ?? 100,
        cursor: query.cursor ?? null
      }
    );
    return response;
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to list experimental features", {
      method: "experimentalFeature/list"
    });
  }
});

app.get("/api/collaboration/modes", async (request, reply) => {
  const query = listQuerySchema.parse(request.query);
  try {
    const response = await codexRuntime.call<{ data: Array<Record<string, unknown>>; nextCursor?: string | null }>(
      "collaborationMode/list",
      {
        limit: query.limit ?? 100,
        cursor: query.cursor ?? null
      }
    );
    return {
      data: Array.isArray(response.data) ? response.data : [],
      nextCursor: typeof response.nextCursor === "string" ? response.nextCursor : null
    };
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to list collaboration modes", {
      method: "collaborationMode/list"
    });
  }
});

app.get("/api/apps", async (request, reply) => {
  const query = appsQuerySchema.parse(request.query);
  try {
    const response = await codexRuntime.call<{ data: Array<Record<string, unknown>>; nextCursor: string | null }>("app/list", {
      limit: query.limit ?? 100,
      cursor: query.cursor ?? null,
      threadId: query.threadId ?? null,
      forceRefetch: query.forceRefetch === "true"
    });
    return response;
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to list apps", {
      method: "app/list"
    });
  }
});

app.get("/api/skills", async (request, reply) => {
  const query = skillsListQuerySchema.parse(request.query);
  try {
    const response = await codexRuntime.call<{ data: Array<Record<string, unknown>>; nextCursor?: string | null }>("skills/list", {
      forceReload: query.forceReload === "true",
      cwds: query.cwd ? [query.cwd] : undefined
    });
    return {
      data: Array.isArray(response.data) ? response.data : [],
      nextCursor: typeof response.nextCursor === "string" ? response.nextCursor : null
    };
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to list skills", {
      method: "skills/list"
    });
  }
});

app.post("/api/skills/config", async (request, reply) => {
  const body = skillsConfigWriteBodySchema.parse(request.body);
  try {
    const response = await codexRuntime.call("skills/config/write", {
      path: body.path,
      enabled: body.enabled
    });
    return {
      status: "ok",
      result: response
    };
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to write skill config", {
      method: "skills/config/write",
      path: body.path
    });
  }
});

app.get("/api/skills/remote", async (_request, reply) => {
  try {
    const response = await codexRuntime.call("skills/remote/read", {});
    return {
      status: "ok",
      result: response
    };
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to read remote skills", {
      method: "skills/remote/read"
    });
  }
});

app.post("/api/skills/remote", async (request, reply) => {
  const body = skillsRemoteWriteBodySchema.parse(request.body);
  try {
    const response = await codexRuntime.call("skills/remote/write", {
      hazelnutId: body.hazelnutId,
      isPreload: body.isPreload
    });
    return {
      status: "ok",
      result: response
    };
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to write remote skill settings", {
      method: "skills/remote/write",
      hazelnutId: body.hazelnutId
    });
  }
});

app.post("/api/mcp/reload", async (_request, reply) => {
  try {
    const response = await codexRuntime.call("config/mcpServer/reload", undefined);
    return {
      status: "ok",
      result: response
    };
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to reload mcp config", {
      method: "config/mcpServer/reload"
    });
  }
});

app.post("/api/mcp/servers/:serverName/oauth/login", async (request, reply) => {
  const params = z.object({ serverName: z.string().min(1) }).parse(request.params);
  const body = mcpOauthLoginBodySchema.parse(request.body ?? {});
  try {
    const response = await codexRuntime.call("mcpServer/oauth/login", {
      name: params.serverName,
      scopes: body.scopes ?? null,
      timeoutSecs: body.timeoutSecs ?? null
    });
    return {
      status: "ok",
      result: response
    };
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to start mcp oauth login", {
      method: "mcpServer/oauth/login",
      name: params.serverName
    });
  }
});

app.get("/api/account", async (_request, reply) => {
  try {
    const response = await codexRuntime.call("account/read", {});
    return response;
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to read account state", {
      method: "account/read"
    });
  }
});

app.post("/api/account/login/start", async (request, reply) => {
  const body = accountLoginStartBodySchema.parse(request.body);
  try {
    const response = await codexRuntime.call("account/login/start", {
      ...(body.type === "apiKey"
        ? {
            type: "apiKey",
            apiKey: body.apiKey
          }
        : body.type === "chatgpt"
          ? {
              type: "chatgpt"
            }
          : {
              type: "chatgptAuthTokens",
              accessToken: body.accessToken,
              chatgptAccountId: body.chatgptAccountId,
              chatgptPlanType: body.chatgptPlanType ?? null
            })
    });
    return {
      status: "ok",
      result: response
    };
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to start account login", {
      method: "account/login/start",
      type: body.type
    });
  }
});

app.post("/api/account/login/cancel", async (request, reply) => {
  const body = accountLoginCancelBodySchema.parse(request.body);
  try {
    const response = await codexRuntime.call("account/login/cancel", {
      loginId: body.loginId
    });
    return {
      status: "ok",
      result: response
    };
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to cancel account login", {
      method: "account/login/cancel",
      loginId: body.loginId
    });
  }
});

app.post("/api/account/logout", async (_request, reply) => {
  try {
    const response = await codexRuntime.call("account/logout", undefined);
    return {
      status: "ok",
      result: response
    };
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to logout account", {
      method: "account/logout"
    });
  }
});

app.get("/api/account/rate-limits", async (_request, reply) => {
  try {
    const response = await codexRuntime.call("account/rateLimits/read", undefined);
    return response;
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to read rate limits", {
      method: "account/rateLimits/read"
    });
  }
});

app.get("/api/config", async (request, reply) => {
  const query = configReadQuerySchema.parse(request.query);
  try {
    const response = await codexRuntime.call("config/read", {
      cwd: query.cwd ?? null,
      includeLayers: query.includeLayers === "true"
    });
    return response;
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to read config", {
      method: "config/read"
    });
  }
});

app.get("/api/config/requirements", async (_request, reply) => {
  try {
    const response = await codexRuntime.call("configRequirements/read", undefined);
    return response;
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to read config requirements", {
      method: "configRequirements/read"
    });
  }
});

app.post("/api/config/value", async (request, reply) => {
  const body = configValueWriteBodySchema.parse(request.body);
  try {
    const response = await codexRuntime.call("config/value/write", {
      keyPath: body.keyPath,
      mergeStrategy: body.mergeStrategy,
      value: body.value,
      expectedVersion: body.expectedVersion ?? null,
      filePath: body.filePath ?? null
    });
    return {
      status: "ok",
      result: response
    };
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to write config value", {
      method: "config/value/write",
      keyPath: body.keyPath
    });
  }
});

app.post("/api/config/batch", async (request, reply) => {
  const body = configBatchWriteBodySchema.parse(request.body);
  try {
    const response = await codexRuntime.call("config/batchWrite", {
      edits: body.edits,
      expectedVersion: body.expectedVersion ?? null,
      filePath: body.filePath ?? null
    });
    return {
      status: "ok",
      result: response
    };
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to batch write config", {
      method: "config/batchWrite"
    });
  }
});

app.post("/api/commands/exec", async (request, reply) => {
  const body = commandExecBodySchema.parse(request.body);
  try {
    const response = await codexRuntime.call("command/exec", {
      command: body.command,
      cwd: body.cwd ?? null,
      timeoutMs: body.timeoutMs ?? null,
      sandboxPolicy: null
    });
    return {
      status: "ok",
      result: response
    };
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to execute command", {
      method: "command/exec",
      command: body.command.join(" ")
    });
  }
});

app.post("/api/feedback", async (request, reply) => {
  const body = feedbackUploadBodySchema.parse(request.body);
  try {
    const response = await codexRuntime.call("feedback/upload", {
      classification: body.classification,
      includeLogs: body.includeLogs,
      reason: body.reason ?? null,
      threadId: body.threadId ?? null
    });
    return {
      status: "ok",
      result: response
    };
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to upload feedback", {
      method: "feedback/upload"
    });
  }
});

app.get("/api/models", async (request) => {
  const query = listQuerySchema.parse(request.query);

  const response = await codexRuntime.call<{ data: Array<Record<string, unknown>>; nextCursor: string | null }>(
    "model/list",
    {
      limit: query.limit ?? 100,
      cursor: query.cursor
    }
  );

  return response;
});

app.get("/api/mcp/servers", async (request) => {
  const query = listQuerySchema.parse(request.query);

  const response = await codexRuntime.call<{ data: Array<Record<string, unknown>>; nextCursor: string | null }>(
    "mcpServerStatus/list",
    {
      limit: query.limit ?? 100,
      cursor: query.cursor
    }
  );

  return response;
});

app.get("/api/orchestrator/jobs/:jobId", async (request, reply) => {
  const params = z.object({ jobId: z.string().trim().min(1) }).parse(request.params);
  const queue = ensureOrchestratorQueue(reply);
  if (!queue) {
    return {
      status: "error",
      code: "job_conflict",
      message: "orchestrator queue is unavailable"
    };
  }

  const job = queue.get(params.jobId);
  if (!job) {
    reply.code(404);
    return {
      status: "not_found",
      jobId: params.jobId
    };
  }

  return {
    status: "ok",
    job
  };
});

app.get("/api/projects/:projectId/orchestrator/jobs", async (request, reply) => {
  const params = z.object({ projectId: z.string().trim().min(1) }).parse(request.params);
  const query = orchestratorJobsQuerySchema.parse(request.query);
  const queue = ensureOrchestratorQueue(reply);
  if (!queue) {
    return {
      status: "error",
      code: "job_conflict",
      message: "orchestrator queue is unavailable"
    };
  }

  return {
    data: queue.listByProject(params.projectId, query.state)
  };
});

app.post("/api/orchestrator/jobs/:jobId/cancel", async (request, reply) => {
  const params = z.object({ jobId: z.string().trim().min(1) }).parse(request.params);
  const queue = ensureOrchestratorQueue(reply);
  if (!queue) {
    return {
      status: "error",
      code: "job_conflict",
      message: "orchestrator queue is unavailable"
    };
  }

  const canceled = await queue.cancel(params.jobId, "api_cancel");
  if (canceled.status === "not_found") {
    reply.code(404);
    return {
      status: "not_found",
      jobId: params.jobId
    };
  }

  if (canceled.status === "already_terminal") {
    reply.code(409);
    return {
      status: "already_terminal",
      job: canceled.job
    };
  }

  return {
    status: "ok",
    job: canceled.job
  };
});

app.get("/api/projects", async () => ({
  data: listProjectSummaries()
}));

app.get("/api/projects/:projectId/agent-sessions", async (request, reply) => {
  const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
  const isKnownProject = params.projectId in sessionMetadata.projects || parseSessionScopedAgentOwnerId(params.projectId) !== null;
  if (!isKnownProject) {
    reply.code(404);
    return {
      status: "not_found",
      projectId: params.projectId
    };
  }

  const data = listProjectAgentSessionMappings(params.projectId).map((entry) => ({
    agent: entry.agent,
    sessionId: entry.sessionId,
    systemOwned: isSystemOwnedSession(entry.sessionId)
  }));
  return {
    status: "ok",
    projectId: params.projectId,
    data
  };
});

app.post("/api/projects", async (request, reply) => {
  const body = upsertProjectBodySchema.parse(request.body);

  const duplicateProjectId = findProjectIdByName(body.name);
  if (duplicateProjectId) {
    reply.code(409);
    return {
      status: "duplicate_name",
      projectId: duplicateProjectId
    };
  }

  const now = new Date().toISOString();
  const projectId = randomUUID();
  const project: ProjectRecord = {
    name: body.name.trim(),
    workingDirectory: normalizeProjectWorkingDirectory(body.workingDirectory),
    createdAt: now,
    updatedAt: now
  };
  sessionMetadata.projects[projectId] = project;
  await persistSessionMetadata();

  const payload = toProjectSummary(projectId, project);
  publishToSockets("project_upserted", { project: payload }, undefined, { broadcastToAll: true });
  return {
    status: "ok",
    project: payload,
    orchestrationSession: null
  };
});

app.post("/api/projects/:projectId/rename", async (request, reply) => {
  const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
  const body = upsertProjectBodySchema.parse(request.body);

  const current = sessionMetadata.projects[params.projectId];
  if (!current) {
    reply.code(404);
    return {
      status: "not_found",
      projectId: params.projectId
    };
  }

  const duplicateProjectId = findProjectIdByName(body.name);
  if (duplicateProjectId && duplicateProjectId !== params.projectId) {
    reply.code(409);
    return {
      status: "duplicate_name",
      projectId: duplicateProjectId
    };
  }

  const nextName = body.name.trim();
  const nextWorkingDirectory =
    body.workingDirectory === undefined ? current.workingDirectory : normalizeProjectWorkingDirectory(body.workingDirectory);
  const shouldUpdateName = current.name !== nextName;
  const shouldUpdateWorkingDirectory = current.workingDirectory !== nextWorkingDirectory;

  if (shouldUpdateName || shouldUpdateWorkingDirectory) {
    current.name = nextName;
    current.workingDirectory = nextWorkingDirectory;
    current.updatedAt = new Date().toISOString();

    if (shouldUpdateWorkingDirectory) {
      const agentSessionIds = listProjectAgentSessionIds(params.projectId);
      for (const sessionId of agentSessionIds) {
        try {
          await hardDeleteSession(sessionId);
        } catch (error) {
          app.log.warn({ error, projectId: params.projectId, sessionId }, "failed to clean up project agent session");
        }
      }
      clearProjectAgentSessionMappingsForProject(params.projectId);
    }

    await persistSessionMetadata();
  }

  const payload = toProjectSummary(params.projectId, current);
  publishToSockets("project_upserted", { project: payload }, undefined, { broadcastToAll: true });
  return {
    status: "ok",
    project: payload
  };
});

app.delete("/api/projects/:projectId", async (request, reply) => {
  const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
  const existing = sessionMetadata.projects[params.projectId];

  if (!existing) {
    reply.code(404);
    return {
      status: "not_found",
      projectId: params.projectId
    };
  }

  const assignedSessionIds = listSessionIdsForProject(params.projectId);
  let existingSessionIds = assignedSessionIds;

  if (assignedSessionIds.length > 0) {
    const assignmentClassification = await classifyProjectSessionAssignments(assignedSessionIds);
    existingSessionIds = assignmentClassification.existingSessionIds;

    if (assignmentClassification.staleSessionIds.length > 0) {
      let metadataChanged = false;
      for (const sessionId of assignmentClassification.staleSessionIds) {
        if (setSessionProjectAssignment(sessionId, null)) {
          metadataChanged = true;
        }
      }

      if (metadataChanged) {
        await persistSessionMetadata();
      }
    }
  }

  if (existingSessionIds.length > 0) {
    reply.code(409);
    return {
      status: "project_not_empty",
      projectId: params.projectId,
      sessionCount: existingSessionIds.length
    };
  }

  const agentSessionIds = listProjectAgentSessionIds(params.projectId);
  for (const sessionId of agentSessionIds) {
    const outcome = await hardDeleteSession(sessionId);
    if (outcome.status === "not_found") {
      setSessionProjectAssignment(sessionId, null);
      setSessionTitleOverride(sessionId, null);
    }
  }

  delete sessionMetadata.projects[params.projectId];
  clearProjectAgentSessionMappingsForProject(params.projectId);
  await persistSessionMetadata();
  publishToSockets(
    "project_deleted",
    {
      projectId: params.projectId,
      sessionIds: []
    },
    undefined,
    { broadcastToAll: true }
  );

  return {
    status: "ok",
    projectId: params.projectId,
    unassignedSessionCount: 0
  };
});

app.post("/api/projects/:projectId/chats/move-all", async (request, reply) => {
  const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
  const body = moveProjectChatsBodySchema.parse(request.body);
  const project = sessionMetadata.projects[params.projectId];
  if (!project) {
    reply.code(404);
    return {
      status: "not_found",
      projectId: params.projectId
    };
  }

  const projectSessionIds = listSessionIdsForProject(params.projectId);
  if (projectSessionIds.length === 0) {
    return {
      status: "ok",
      projectId: params.projectId,
      destination: body.destination,
      movedSessionCount: 0,
      archivedSessionCount: 0,
      alreadyArchivedSessionCount: 0
    };
  }

  let archivedSessionCount = 0;
  let alreadyArchivedSessionCount = 0;

  if (body.destination === "archive") {
    const classification = await classifyProjectSessionsForArchive(projectSessionIds);
    if (classification.notMaterializedSessionIds.length > 0) {
      reply.code(409);
      return {
        status: "not_materialized_sessions",
        projectId: params.projectId,
        sessionIds: classification.notMaterializedSessionIds
      };
    }

    for (const sessionId of classification.archivableSessionIds) {
      try {
        await codexRuntime.call("thread/archive", {
          threadId: sessionId
        });
        archivedSessionCount += 1;
      } catch (error) {
        if (isNoRolloutFoundError(error)) {
          reply.code(409);
          return {
            status: "not_materialized_sessions",
            projectId: params.projectId,
            sessionIds: [sessionId]
          };
        }
        throw error;
      }
    }

    alreadyArchivedSessionCount = classification.alreadyArchivedSessionIds.length;
  }

  const changedSessionIds: Array<string> = [];
  for (const sessionId of projectSessionIds) {
    if (setSessionProjectAssignment(sessionId, null)) {
      changedSessionIds.push(sessionId);
    }
  }

  if (changedSessionIds.length > 0) {
    await persistSessionMetadata();
    for (const sessionId of changedSessionIds) {
      publishToSockets(
        "session_project_updated",
        {
          sessionId,
          projectId: null
        },
        sessionId,
        { broadcastToAll: true }
      );
    }
  }

  return {
    status: "ok",
    projectId: params.projectId,
    destination: body.destination,
    movedSessionCount: changedSessionIds.length,
    archivedSessionCount,
    alreadyArchivedSessionCount
  };
});

app.post("/api/projects/:projectId/chats/delete-all", async (request, reply) => {
  const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
  const project = sessionMetadata.projects[params.projectId];
  if (!project) {
    reply.code(404);
    return {
      status: "not_found",
      projectId: params.projectId
    };
  }

  const projectSessionIds = listSessionIdsForProject(params.projectId);
  if (projectSessionIds.length === 0) {
    return {
      status: "ok",
      projectId: params.projectId,
      deletedSessionCount: 0,
      skippedSessionCount: 0
    };
  }

  let deletedSessionCount = 0;
  const staleSessionIds: Array<string> = [];

  for (const sessionId of projectSessionIds) {
    const outcome = await hardDeleteSession(sessionId);
    if (outcome.status === "deleted") {
      deletedSessionCount += 1;
      continue;
    }

    staleSessionIds.push(sessionId);
  }

  let metadataChanged = false;
  for (const sessionId of staleSessionIds) {
    if (setSessionProjectAssignment(sessionId, null)) {
      metadataChanged = true;
    }
  }

  if (metadataChanged) {
    await persistSessionMetadata();
  }

  return {
    status: "ok",
    projectId: params.projectId,
    deletedSessionCount,
    skippedSessionCount: staleSessionIds.length
  };
});

app.get("/api/sessions", async (request) => {
  const query = listSessionsQuerySchema.parse(request.query);
  const archived = query.archived === "true";
  const cursor = query.cursor;
  const limit = query.limit ?? 100;
  const includeSystemOwned = query.includeSystemOwned === "true";

  const response = await codexRuntime.call<{ data: Array<CodexThread>; nextCursor: string | null }>("thread/list", {
    limit,
    archived,
    cursor
  });

  const threads = response.data.filter(
    (thread) => !isSessionPurged(thread.id) && (includeSystemOwned || !isSystemOwnedSession(thread.id))
  );
  const materializedByThreadId = new Map<string, boolean>();
  for (const thread of threads) {
    materializedByThreadId.set(thread.id, true);
  }

  if (!archived && !cursor) {
    try {
      const loaded = await codexRuntime.call<{ data: Array<string> }>("thread/loaded/list", {});
      const existingIds = new Set(threads.map((thread) => thread.id));
      const missingThreadIds = loaded.data.filter(
        (threadId) =>
          !existingIds.has(threadId) &&
          !isSessionPurged(threadId) &&
          (includeSystemOwned || !isSystemOwnedSession(threadId))
      );

      if (missingThreadIds.length > 0) {
        const loadedThreads = await Promise.all(
          missingThreadIds.map(async (threadId) => {
            try {
              const readWithTurns = await codexRuntime.call<{ thread: CodexThread }>("thread/read", {
                threadId,
                includeTurns: true
              });
              return {
                thread: readWithTurns.thread,
                materialized: true
              };
            } catch (error) {
              if (!isIncludeTurnsUnavailableError(error)) {
                app.log.debug({ error, threadId }, "failed to read loaded thread while listing sessions");
                return null;
              }

              const readWithoutTurns = await codexRuntime.call<{ thread: CodexThread }>("thread/read", {
                threadId,
                includeTurns: false
              });
              return {
                thread: readWithoutTurns.thread,
                materialized: false
              };
            }
          })
        );

        for (const item of loadedThreads) {
          if (item && !existingIds.has(item.thread.id)) {
            existingIds.add(item.thread.id);
            materializedByThreadId.set(item.thread.id, item.materialized);
            threads.push(item.thread);
          }
        }
      }
    } catch (error) {
      app.log.warn({ error }, "failed to merge loaded sessions into session list");
    }
  }

  if (!cursor) {
    threads.sort((left, right) => {
      if (left.updatedAt !== right.updatedAt) {
        return right.updatedAt - left.updatedAt;
      }
      return right.createdAt - left.createdAt;
    });
  }

  return {
    data: threads.map((thread) => toSessionSummary(thread, materializedByThreadId.get(thread.id) ?? true)),
    nextCursor: response.nextCursor,
    archived
  };
});

app.post("/api/sessions", async (request) => {
  const body = createSessionBodySchema.parse(request.body);
  const defaultControls = resolveDefaultSessionControls();
  const requestedControls: SessionControlsTuple = {
    model: body?.model?.trim() ? body.model.trim() : defaultControls.model,
    approvalPolicy: body?.approvalPolicy
      ? sessionControlApprovalPolicyFromProtocol(body.approvalPolicy)
      : defaultControls.approvalPolicy,
    networkAccess: body?.networkAccess ?? defaultControls.networkAccess,
    filesystemSandbox: body?.filesystemSandbox ?? defaultControls.filesystemSandbox
  };

  const response = await callThreadMethodWithRawEventsFallback<{
    thread: CodexThread;
  }>("thread/start", {
    cwd: body?.cwd ?? env.WORKSPACE_ROOT,
    model: requestedControls.model ?? undefined,
    sandbox: requestedControls.filesystemSandbox,
    approvalPolicy: protocolApprovalPolicyFromSessionControl(requestedControls.approvalPolicy)
  });

  await setSessionTitle(response.thread.id, defaultSessionTitle());
  const controlsChanged = setSessionControls(response.thread.id, requestedControls);
  const systemOwnedChanged = setSystemOwnedSession(response.thread.id, false);
  if (controlsChanged || systemOwnedChanged) {
    await persistSessionMetadata();
  }

  return {
    session: toSessionSummary(response.thread, false),
    thread: response.thread
  };
});

app.get("/api/sessions/:sessionId", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  let response: { thread: CodexThread };
  let transcript: Array<TranscriptEntry> = [];
  let materialized = true;

  try {
    response = await codexRuntime.call<{ thread: CodexThread }>("thread/read", {
      threadId: params.sessionId,
      includeTurns: true
    });
    transcript = turnsToTranscript(params.sessionId, Array.isArray(response.thread.turns) ? response.thread.turns : []);
  } catch (error) {
    if (!isIncludeTurnsUnavailableError(error)) {
      throw error;
    }

    response = await codexRuntime.call<{ thread: CodexThread }>("thread/read", {
      threadId: params.sessionId,
      includeTurns: false
    });
    transcript = [];
    materialized = false;
  }

  transcript = mergeTranscriptWithSupplemental(params.sessionId, transcript);

  return {
    session: toSessionSummary(response.thread, materialized),
    thread: response.thread,
    transcript
  };
});

app.post("/api/sessions/:sessionId/transcript/upsert", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  const exists = await sessionExistsForProjectAssignment(params.sessionId);
  if (!exists) {
    reply.code(404);
    return {
      status: "not_found",
      sessionId: params.sessionId
    };
  }

  const body = transcriptUpsertBodySchema.parse(request.body);
  const entry: TranscriptEntry = {
    messageId: body.messageId,
    turnId: body.turnId,
    role: body.role,
    type: body.type,
    content: body.content,
    ...(typeof body.details === "string" ? { details: body.details } : {}),
    ...(typeof body.startedAt === "number" ? { startedAt: body.startedAt } : {}),
    ...(typeof body.completedAt === "number" ? { completedAt: body.completedAt } : {}),
    status: body.status
  };

  upsertSupplementalTranscriptEntry(params.sessionId, entry);
  publishTranscriptUpdated(params.sessionId, {
    turnId: entry.turnId,
    messageId: entry.messageId,
    type: entry.type,
    entry
  });

  return {
    status: "ok",
    sessionId: params.sessionId,
    entry
  };
});

app.post("/api/sessions/:sessionId/fork", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }

  try {
    const sourceControls = resolveSessionControls(params.sessionId);
    const response = await callThreadMethodWithRawEventsFallback<{ thread: CodexThread }>("thread/fork", {
      threadId: params.sessionId,
      sandbox: sourceControls.filesystemSandbox,
      approvalPolicy: protocolApprovalPolicyFromSessionControl(sourceControls.approvalPolicy)
    });
    if (setSessionControls(response.thread.id, sourceControls)) {
      await persistSessionMetadata();
    }

    return {
      status: "ok",
      sourceSessionId: params.sessionId,
      session: toSessionSummary(response.thread, true),
      thread: response.thread
    };
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to fork session", {
      method: "thread/fork",
      sessionId: params.sessionId
    });
  }
});

app.post("/api/sessions/:sessionId/compact", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }

  try {
    const response = await codexRuntime.call("thread/compact/start", {
      threadId: params.sessionId
    });
    return {
      status: "ok",
      sessionId: params.sessionId,
      result: response
    };
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to compact session context", {
      method: "thread/compact/start",
      sessionId: params.sessionId
    });
  }
});

app.post("/api/sessions/:sessionId/rollback", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }
  const body = rollbackBodySchema.parse(request.body);

  try {
    const response = await codexRuntime.call("thread/rollback", {
      threadId: params.sessionId,
      numTurns: body.numTurns
    });
    return {
      status: "ok",
      sessionId: params.sessionId,
      numTurns: body.numTurns,
      result: response
    };
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to rollback session", {
      method: "thread/rollback",
      sessionId: params.sessionId,
      numTurns: body.numTurns
    });
  }
});

app.post("/api/sessions/:sessionId/background-terminals/clean", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }

  try {
    const response = await codexRuntime.call("thread/backgroundTerminals/clean", {
      threadId: params.sessionId
    });
    return {
      status: "ok",
      sessionId: params.sessionId,
      result: response
    };
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to clean background terminals", {
      method: "thread/backgroundTerminals/clean",
      sessionId: params.sessionId
    });
  }
});

app.post("/api/sessions/:sessionId/review", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }
  const body = reviewBodySchema.parse(request.body ?? {});

  const targetType = body.targetType ?? "custom";
  const target =
    targetType === "uncommittedChanges"
      ? { type: "uncommittedChanges" }
      : targetType === "baseBranch"
        ? { type: "baseBranch", branch: body.branch ?? "main" }
        : targetType === "commit"
          ? { type: "commit", sha: body.sha ?? "", title: body.title ?? null }
          : { type: "custom", instructions: body.instructions ?? "Review this thread's current changes." };

  try {
    const response = await codexRuntime.call("review/start", {
      threadId: params.sessionId,
      delivery: body.delivery ?? "inline",
      target
    });
    return {
      status: "ok",
      sessionId: params.sessionId,
      result: response
    };
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to start review", {
      method: "review/start",
      sessionId: params.sessionId
    });
  }
});

app.post("/api/sessions/:sessionId/turns/:turnId/steer", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1), turnId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }
  const body = steerBodySchema.parse(request.body);

  const steerResult = await runtimeProfileAdapter.steerTurn({
    sessionId: params.sessionId,
    turnId: params.turnId,
    input: body.input
  });

  if (steerResult.status !== "performed") {
    reply.code(
      steerResult.status === "already_resolved" || steerResult.status === "not_eligible" || steerResult.status === "conflict"
        ? 409
        : 400
    );
    return {
      status: "error",
      code: steerResult.status,
      sessionId: params.sessionId,
      turnId: params.turnId,
      result: steerResult
    };
  }

  return {
    status: "ok",
    sessionId: params.sessionId,
    turnId: params.turnId,
    result: steerResult
  };
});

app.post("/api/sessions/:sessionId/rename", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }
  const body = renameSessionBodySchema.parse(request.body);

  await setSessionTitle(params.sessionId, body.title);

  let response: { thread: CodexThread };
  let materialized = true;
  try {
    response = await codexRuntime.call<{ thread: CodexThread }>("thread/read", {
      threadId: params.sessionId,
      includeTurns: true
    });
  } catch (error) {
    if (!isIncludeTurnsUnavailableError(error)) {
      throw error;
    }

    response = await codexRuntime.call<{ thread: CodexThread }>("thread/read", {
      threadId: params.sessionId,
      includeTurns: false
    });
    materialized = false;
  }

  return {
    status: "ok",
    session: toSessionSummary(response.thread, materialized)
  };
});

app.post("/api/sessions/:sessionId/project", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }

  const body = setSessionProjectBodySchema.parse(request.body);
  const nextProjectId = typeof body.projectId === "string" ? body.projectId.trim() : null;
  if (nextProjectId && !(nextProjectId in sessionMetadata.projects)) {
    reply.code(404);
    return {
      status: "project_not_found",
      sessionId: params.sessionId,
      projectId: nextProjectId
    };
  }

  const exists = await sessionExistsForProjectAssignment(params.sessionId);
  if (!exists) {
    reply.code(404);
    return {
      status: "not_found",
      sessionId: params.sessionId
    };
  }

  const previousProjectId = resolveSessionProjectId(params.sessionId);
  const changed = setSessionProjectAssignment(params.sessionId, nextProjectId);
  if (changed) {
    await persistSessionMetadata();
  }

  const payload = {
    status: "ok",
    sessionId: params.sessionId,
    projectId: nextProjectId,
    previousProjectId
  };
  if (changed) {
    publishToSockets("session_project_updated", payload, params.sessionId, { broadcastToAll: true });
  }

  return payload;
});

app.post("/api/sessions/:sessionId/archive", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }

  try {
    await codexRuntime.call("thread/archive", {
      threadId: params.sessionId
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("no rollout found for thread id")) {
      reply.code(409);
      return {
        status: "not_materialized",
        sessionId: params.sessionId
      };
    }

    throw error;
  }

  return {
    status: "ok",
    sessionId: params.sessionId
  };
});

app.post("/api/sessions/:sessionId/unarchive", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }

  const response = await codexRuntime.call<{ thread: CodexThread }>("thread/unarchive", {
    threadId: params.sessionId
  });

  return {
    status: "ok",
    session: toSessionSummary(response.thread, true),
    thread: response.thread
  };
});

app.delete("/api/sessions/:sessionId", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }
  const outcome = await hardDeleteSession(params.sessionId);
  if (outcome.status === "gone") {
    reply.code(410);
    return outcome.payload;
  }

  if (outcome.status === "not_found") {
    reply.code(404);
    return {
      status: "not_found",
      sessionId: params.sessionId
    };
  }

  return {
    status: "ok",
    sessionId: params.sessionId,
    title: outcome.title,
    deletedFileCount: outcome.deletedFileCount
  };
});

app.get("/api/sessions/:sessionId/approvals", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }

  const approvals = listPendingApprovalRecordsByThread(params.sessionId);
  for (const approval of approvals) {
    void enqueueFileChangeReviewEventFromApproval(approval, "approvals_reconcile").catch((error) => {
      app.log.warn(
        {
          error,
          threadId: approval.threadId,
          turnId: approval.turnId,
          itemId: approval.itemId,
          approvalId: approval.approvalId
        },
        "failed to enqueue file-change review event during approvals reconcile"
      );
    });
  }

  return {
    data: approvals.map((approval) => toPublicApproval(approval))
  };
});

app.get("/api/sessions/:sessionId/tool-input", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }

  return {
    data: listPendingToolInputsByThread(params.sessionId)
  };
});

app.post("/api/sessions/:sessionId/resume", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }

  const sessionControls = resolveSessionControls(params.sessionId);
  const response = await callThreadMethodWithRawEventsFallback<{ thread: CodexThread }>("thread/resume", {
    threadId: params.sessionId,
    sandbox: sessionControls.filesystemSandbox,
    approvalPolicy: protocolApprovalPolicyFromSessionControl(sessionControls.approvalPolicy)
  });

  return {
    session: toSessionSummary(response.thread, true),
    thread: response.thread
  };
});

app.get("/api/sessions/:sessionId/session-controls", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }

  const exists = await sessionExistsForProjectAssignment(params.sessionId);
  if (!exists) {
    reply.code(404);
    return {
      status: "not_found",
      sessionId: params.sessionId
    };
  }

  return {
    status: "ok",
    ...sessionControlsResponse(params.sessionId)
  };
});

app.post("/api/sessions/:sessionId/session-controls", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }

  const exists = await sessionExistsForProjectAssignment(params.sessionId);
  if (!exists) {
    reply.code(404);
    return {
      status: "not_found",
      sessionId: params.sessionId
    };
  }

  const body = applySessionControlsBodySchema.parse(request.body);
  const actor = body.actor ?? "user";
  const source = body.source ?? "ui";
  const requestedControls = parseSessionControlsTuple(body.controls);

  if (!requestedControls) {
    reply.code(400);
    return {
      status: "error",
      code: "invalid_request",
      message: "session controls payload is invalid"
    };
  }

  if (body.scope === "default" && env.SESSION_DEFAULTS_LOCKED) {
    reply.code(423);
    return {
      status: "locked",
      scope: body.scope,
      message: "Managed by harness configuration",
      ...sessionControlsResponse(params.sessionId)
    };
  }

  const previousSessionControls = resolveSessionControls(params.sessionId);
  const previousDefaultControls = resolveDefaultSessionControls();
  const previous = body.scope === "default" ? previousDefaultControls : previousSessionControls;

  const changed =
    body.scope === "default"
      ? setDefaultSessionControls(requestedControls)
      : setSessionControls(params.sessionId, requestedControls);

  const nextSessionControls = resolveSessionControls(params.sessionId);
  const nextDefaultControls = resolveDefaultSessionControls();
  const next = body.scope === "default" ? nextDefaultControls : nextSessionControls;

  if (changed) {
    appendSessionControlsAuditEntry({
      sessionId: params.sessionId,
      scope: body.scope,
      actor,
      source,
      previous,
      next
    });
    await persistSessionMetadata();
  }

  return {
    status: changed ? "ok" : "unchanged",
    scope: body.scope,
    applied: next,
    summary: formatSessionControlsTuple(next),
    ...sessionControlsResponse(params.sessionId)
  };
});

app.post("/api/sessions/:sessionId/approval-policy", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }

  const exists = await sessionExistsForProjectAssignment(params.sessionId);
  if (!exists) {
    reply.code(404);
    return {
      status: "not_found",
      sessionId: params.sessionId
    };
  }

  const body = sessionApprovalPolicyBodySchema.parse(request.body);
  if (setSessionApprovalPolicy(params.sessionId, body.approvalPolicy)) {
    await persistSessionMetadata();
  }

  return {
    status: "ok",
    sessionId: params.sessionId,
    approvalPolicy: resolveSessionApprovalPolicy(params.sessionId)
  };
});

app.post("/api/sessions/:sessionId/suggested-request/jobs", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }

  const exists = await sessionExistsForProjectAssignment(params.sessionId);
  if (!exists) {
    reply.code(404);
    return {
      status: "not_found",
      sessionId: params.sessionId
    };
  }

  const queue = ensureOrchestratorQueue(reply);
  if (!queue) {
    return {
      status: "error",
      code: "job_conflict",
      sessionId: params.sessionId,
      message: "orchestrator queue is unavailable"
    };
  }

  const body = suggestedRequestBodySchema.parse(request.body);
  const projectId = suggestionQueueProjectId(params.sessionId);
  const requestKey = randomUUID();

  try {
    const queued = await enqueueSuggestedRequestViaAgentEvent({
      sessionId: params.sessionId,
      projectId,
      requestKey,
      model: body?.model,
      effort: body?.effort,
      draft: body?.draft
    });

    reply.code(202);
    return {
      status: "queued",
      jobId: queued.job.id,
      requestKey,
      sessionId: params.sessionId,
      projectId,
      dedupe: queued.status === "already_queued" ? "already_queued" : "enqueued"
    };
  } catch (error) {
    return sendOrchestratorQueueError(reply, error, params.sessionId);
  }
});

app.post("/api/sessions/:sessionId/suggested-request", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }

  const exists = await sessionExistsForProjectAssignment(params.sessionId);
  if (!exists) {
    reply.code(404);
    return {
      status: "not_found",
      sessionId: params.sessionId
    };
  }

  const queue = ensureOrchestratorQueue(reply);
  if (!queue) {
    return {
      status: "error",
      code: "job_conflict",
      sessionId: params.sessionId,
      message: "orchestrator queue is unavailable"
    };
  }

  const body = suggestedRequestBodySchema.parse(request.body);
  const projectId = suggestionQueueProjectId(params.sessionId);
  const requestKey = randomUUID();

  let queued;
  try {
    queued = await enqueueSuggestedRequestViaAgentEvent({
      sessionId: params.sessionId,
      projectId,
      requestKey,
      model: body?.model,
      effort: body?.effort,
      draft: body?.draft
    });
  } catch (error) {
    return sendOrchestratorQueueError(reply, error, params.sessionId);
  }

  const terminal = await queue.waitForTerminal(queued.job.id, env.ORCHESTRATOR_SUGGEST_REQUEST_WAIT_MS);
  if (!terminal) {
    reply.code(202);
    return {
      status: "queued",
      jobId: queued.job.id,
      requestKey,
      sessionId: params.sessionId,
      projectId,
      dedupe: queued.status === "already_queued" ? "already_queued" : "enqueued"
    };
  }

  if (terminal.state === "completed") {
    const suggestion = typeof terminal.result?.suggestion === "string" ? terminal.result.suggestion.trim() : "";
    if (suggestion.length > 0) {
      return {
        status: "ok",
        sessionId: params.sessionId,
        requestKey,
        suggestion
      };
    }
  }

  if (terminal.state === "failed" && typeof terminal.error === "string" && terminal.error.includes("no_context")) {
    reply.code(409);
    return {
      status: "no_context",
      sessionId: params.sessionId,
      requestKey,
      message: "No chat messages available to build a suggested request."
    };
  }

  const fallbackSuggestion = buildFallbackSuggestedRequest([], body?.draft);
  return {
    status: "fallback",
    sessionId: params.sessionId,
    requestKey,
    suggestion: fallbackSuggestion
  };
});

app.post("/api/sessions/:sessionId/suggested-request/upsert", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }

  const exists = await sessionExistsForProjectAssignment(params.sessionId);
  if (!exists) {
    reply.code(404);
    return {
      status: "not_found",
      sessionId: params.sessionId
    };
  }

  const body = suggestedRequestUpsertBodySchema.parse(request.body);
  if (body.status === "complete" && (!body.suggestion || body.suggestion.trim().length === 0)) {
    reply.code(400);
    return {
      status: "invalid_request",
      code: "missing_suggestion",
      message: "suggestion is required when status is complete"
    };
  }

  const entry = upsertSuggestedRequestRuntimeState({
    sessionId: params.sessionId,
    requestKey: body.requestKey,
    status: body.status,
    suggestion: body.suggestion,
    error: body.error
  });

  return {
    status: "ok",
    sessionId: params.sessionId,
    requestKey: entry.requestKey,
    entry: {
      status: entry.status,
      ...(entry.suggestion ? { suggestion: entry.suggestion } : {}),
      ...(entry.error ? { error: entry.error } : {}),
      updatedAt: entry.updatedAt
    }
  };
});

app.post("/api/sessions/:sessionId/messages", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }

  const exists = await sessionExistsForProjectAssignment(params.sessionId);
  if (!exists) {
    reply.code(404);
    return {
      status: "not_found",
      sessionId: params.sessionId
    };
  }

  const body = sendMessageBodySchema.parse(request.body);

  const currentControls = resolveSessionControls(params.sessionId);
  const requestedControls: SessionControlsTuple = {
    model: body.model?.trim() ? body.model.trim() : currentControls.model,
    approvalPolicy: body.approvalPolicy
      ? sessionControlApprovalPolicyFromProtocol(body.approvalPolicy)
      : currentControls.approvalPolicy,
    networkAccess: body.networkAccess ?? currentControls.networkAccess,
    filesystemSandbox: body.filesystemSandbox ?? currentControls.filesystemSandbox
  };

  const approvalPolicy = protocolApprovalPolicyFromSessionControl(requestedControls.approvalPolicy);

  const startTurn = async (): Promise<{ turn: { id: string } }> =>
    codexRuntime.call<{ turn: { id: string } }>("turn/start", {
      threadId: params.sessionId,
      model: requestedControls.model ?? undefined,
      effort: body.effort as ReasoningEffort | undefined,
      sandboxPolicy: toTurnSandboxPolicy(requestedControls.filesystemSandbox, requestedControls.networkAccess),
      approvalPolicy,
      input: [
        {
          type: "text",
          text: body.text,
          text_elements: []
        }
      ]
    });

  let turn: { turn: { id: string } };
  try {
    turn = await startTurn();
  } catch (error) {
    if (isNoRolloutFoundError(error)) {
      try {
        await callThreadMethodWithRawEventsFallback("thread/resume", {
          threadId: params.sessionId,
          sandbox: requestedControls.filesystemSandbox,
          approvalPolicy
        });
        turn = await startTurn();
      } catch (retryError) {
        return sendMappedCodexError(reply, retryError, "failed to send message", {
          method: "turn/start",
          sessionId: params.sessionId
        });
      }
    } else {
      return sendMappedCodexError(reply, error, "failed to send message", {
        method: "turn/start",
        sessionId: params.sessionId
      });
    }
  }

  if (!isSessionPurged(params.sessionId) && setSessionControls(params.sessionId, requestedControls)) {
    void persistSessionMetadata().catch((error) => {
      app.log.warn({ error, sessionId: params.sessionId }, "failed to persist session controls after message send");
    });
  }

  activeTurnByThread.set(params.sessionId, turn.turn.id);
  const startedAt = Date.now();
  if (setTurnStartedAt(params.sessionId, turn.turn.id, startedAt)) {
    void persistSessionMetadata().catch((error) => {
      app.log.warn({ error, threadId: params.sessionId, turnId: turn.turn.id }, "failed to persist turn start timing after message send");
    });
  }

  reply.code(202);
  return {
    status: "accepted",
    sessionId: params.sessionId,
    turnId: turn.turn.id
  };
});

app.post("/api/sessions/:sessionId/interrupt", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }
  const body = interruptBodySchema.parse(request.body);

  const turnId = body?.turnId ?? activeTurnByThread.get(params.sessionId);
  if (!turnId) {
    reply.code(409);
    return {
      status: "no_active_turn",
      sessionId: params.sessionId
    };
  }

  await codexRuntime.call("turn/interrupt", {
    threadId: params.sessionId,
    turnId
  });

  return {
    status: "ok",
    sessionId: params.sessionId,
    turnId
  };
});

app.post("/api/tool-input/:requestId/decision", async (request, reply) => {
  const params = z.object({ requestId: z.string().min(1) }).parse(request.params);
  const body = toolUserInputDecisionBodySchema.parse(request.body);

  const pending = pendingToolUserInputs.get(params.requestId);
  if (!pending) {
    reply.code(404);
    return {
      status: "not_found",
      requestId: params.requestId
    };
  }

  try {
    await codexRuntime.respond(pending.rpcId, toolUserInputResponsePayload(body));
    upsertSupplementalTranscriptEntry(
      pending.threadId,
      toolInputResolutionToTranscriptEntry(pending, {
        status: "resolved",
        decision: body.decision
      })
    );
    pendingToolUserInputs.delete(params.requestId);
    publishToSockets(
      "tool_user_input_resolved",
      {
        requestId: params.requestId,
        status: "resolved",
        decision: body.decision
      },
      pending.threadId
    );

    return {
      status: "ok",
      requestId: params.requestId,
      threadId: pending.threadId
    };
  } catch (error) {
    app.log.error({ error, requestId: params.requestId }, "failed to submit tool user input decision");
    reply.code(500);
    return {
      status: "error",
      requestId: params.requestId
    };
  }
});

app.post("/api/approvals/:approvalId/decision", async (request, reply) => {
  const params = z.object({ approvalId: z.string().min(1) }).parse(request.params);
  const body = approvalDecisionBodySchema.parse(request.body);

  const approval = pendingApprovals.get(params.approvalId);
  if (!approval) {
    reply.code(404);
    return {
      status: "not_found",
      approvalId: params.approvalId
    };
  }

  try {
    const rawPayload = approvalDecisionPayload(approval, body.decision, body.scope ?? "turn");
    const payload = isObjectRecord(rawPayload) ? rawPayload : {};
    const decisionResult = await runtimeProfileAdapter.decideApproval({
      rpcId: approval.rpcId,
      payload,
      approvalId: params.approvalId,
      threadId: approval.threadId,
      actionType: body.decision === "accept" ? "approval.accept" : "approval.decline"
    });

    if (decisionResult.status !== "performed") {
      if (
        decisionResult.status === "already_resolved" ||
        decisionResult.status === "not_eligible" ||
        decisionResult.status === "conflict"
      ) {
        reply.code(409);
        return {
          status: "reconciled",
          approvalId: params.approvalId,
          threadId: approval.threadId,
          code: decisionResult.status
        };
      }

      reply.code(500);
      return {
        status: "error",
        approvalId: params.approvalId
      };
    }

    upsertSupplementalTranscriptEntry(
      approval.threadId,
      approvalResolutionToTranscriptEntry(approval, {
        status: "resolved",
        decision: body.decision,
        scope: body.scope ?? "turn"
      })
    );
    pendingApprovals.delete(params.approvalId);
    publishToSockets(
      "approval_resolved",
      {
        approvalId: params.approvalId,
        status: "resolved",
        decision: body.decision,
        scope: body.scope ?? "turn"
      },
      approval.threadId
    );

    return {
      status: "ok",
      approvalId: params.approvalId,
      threadId: approval.threadId
    };
  } catch (error) {
    app.log.error({ error, approvalId: params.approvalId }, "failed to submit approval decision");

    reply.code(500);
    return {
      status: "error",
      approvalId: params.approvalId
    };
  }
});

app.addHook("onClose", async () => {
  if (supplementalTranscriptPersistTimer !== null) {
    clearTimeout(supplementalTranscriptPersistTimer);
    supplementalTranscriptPersistTimer = null;
  }
  await flushSupplementalTranscriptPersistence();

  for (const socket of sockets) {
    try {
      socket.close();
    } catch {
      // Ignore socket close errors during shutdown.
    }
  }

  sockets.clear();
  socketThreadFilter.clear();
  activeTurnByThread.clear();
  fileChangeEventAnchorsByTurn.clear();
  turnCompletedEventDispatchInFlight.clear();
  coreQueueWorkerOrientationCompletedBySession.clear();
  agentExtensionBootstrapCompletedBySession.clear();
  coreQueueWorkerOrientationInFlightBySession.clear();
  agentExtensionBootstrapInFlightByKey.clear();
  runtimeObservedTurnsByKey.clear();
  runtimeTurnSignalWaitersByKey.clear();
  projectAgentSessionEnsureInFlightByKey.clear();
  pendingApprovals.clear();
  pendingToolUserInputs.clear();
  if (orchestratorQueue) {
    await orchestratorQueue.stop({ drainMs: 2_000 });
  }
  await codexRuntime.stop();
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  app.log.info({ signal }, "shutting down api");

  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ error }, "api shutdown failed");
    process.exit(1);
  }
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

await codexRuntime.start();
try {
  const prunedControlEntries = await pruneStaleSessionControlMetadata();
  if (prunedControlEntries > 0) {
    app.log.info({ prunedControlEntries }, "pruned stale session-control metadata entries");
  }
  if (orchestratorQueue) {
    await orchestratorQueue.start();
  }
  await refreshCapabilities();
} catch (error) {
  app.log.warn({ error }, "failed to initialize capability snapshot");
}
const authStatus = currentAuthStatus();
if (authStatus.likelyUnauthenticated) {
  app.log.warn(
    {
      codeHome: env.CODEX_HOME ?? null,
      hasOpenAiApiKey: authStatus.hasOpenAiApiKey,
      codexHomeAuthFile: authStatus.codexHomeAuthFile
    },
    "codex authentication may be missing: set OPENAI_API_KEY or ensure CODEX_HOME has auth.json"
  );
}

try {
  await app.listen({
    host: env.HOST,
    port: env.PORT
  });
} catch (error) {
  app.log.error({ error }, "api failed to start");
  process.exit(1);
}
