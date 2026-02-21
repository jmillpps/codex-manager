import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { env } from "./env.js";
import { CodexSupervisor } from "./codex-supervisor.js";
import { OrchestratorQueue, OrchestratorQueueError } from "./orchestrator-queue.js";
import { FileOrchestratorQueueStore } from "./orchestrator-store.js";
import { createJobDefinitionsRegistry } from "./orchestrator-job-definitions.js";
import {
  fileChangeExplainJobPayloadSchema,
  fileChangeExplainJobResultSchema,
  type FileChangeExplainJobPayload,
  type FileChangeExplainJobResult,
  suggestReplyJobPayloadSchema,
  suggestReplyJobResultSchema,
  type SuggestReplyJobPayload,
  type SuggestReplyJobResult
} from "./orchestrator-processors.js";
import type { JobDefinitionsMap, JobRunContext } from "./orchestrator-types.js";

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
  on: (event: string, handler: (...args: Array<unknown>) => void) => void;
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
  projectOrchestratorSessionById: Record<string, string>;
  suggestionHelperSessionIds: Record<string, true>;
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

const sendMessageBodySchema = z.object({
  text: z.string().trim().min(1),
  model: z.string().min(1).optional(),
  effort: reasoningEffortSchema.optional(),
  approvalPolicy: approvalPolicySchema.optional(),
  networkAccess: networkAccessSchema.optional(),
  filesystemSandbox: filesystemSandboxSchema.optional()
});

const suggestedReplyBodySchema = z
  .object({
    model: z.string().min(1).optional(),
    effort: reasoningEffortSchema.optional(),
    draft: z.string().trim().min(1).max(4000).optional()
  })
  .optional();

const sessionApprovalPolicyBodySchema = z.object({
  approvalPolicy: approvalPolicySchema
});

const listSessionsQuerySchema = z.object({
  archived: z.enum(["true", "false"]).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
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

const supervisor = new CodexSupervisor({
  bin: env.CODEX_BIN,
  codeHome: env.CODEX_HOME,
  dataDir: env.DATA_DIR,
  cwd: env.WORKSPACE_ROOT,
  logger: app.log
});

const activeTurnByThread = new Map<string, string>();
const suggestionThreadBySession = new Map<string, string>();
const suggestionThreadIds = new Set<string>();
const pendingApprovals = new Map<string, PendingApprovalRecord>();
const pendingToolUserInputs = new Map<string, PendingToolUserInputRecord>();
const purgedSessionIds = new Set<string>();
const supplementalTranscriptByThread = new Map<string, Map<string, SupplementalTranscriptEntry>>();
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
const syntheticTranscriptMessageIdPattern = /^item-\d+$/i;
const sessionMetadata = await loadSessionMetadata();
await loadSupplementalTranscriptStore();
const deletedSessionMessage = "This chat was permanently deleted and is no longer available.";
const capabilitiesByMethod = new Map<string, CapabilityEntry>();
let capabilitiesLastUpdatedAt: string | null = null;
let capabilitiesInitialized = false;
let capabilitiesRefreshInFlight: Promise<void> | null = null;
let experimentalRawEventsCapability: "unknown" | "supported" | "unsupported" = "unknown";
let projectOrchestratorsEnsureInFlight: Promise<void> | null = null;
let suggestionHelpersCleanupInFlight: Promise<void> | null = null;
let orchestratorQueue: OrchestratorQueue | null = null;

if (env.ORCHESTRATOR_QUEUE_ENABLED) {
  orchestratorQueue = new OrchestratorQueue({
    definitions: buildOrchestratorJobDefinitions(),
    store: new FileOrchestratorQueueStore(orchestratorJobsPath, app.log),
    hooks: {
      emitEvent: (event) => {
        publishToSockets(event.type, event.payload, event.threadId ?? undefined);
      },
      interruptTurn: async (threadId: string, turnId: string) => {
        await supervisor.call("turn/interrupt", {
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

function sourceLabel(source: unknown): string {
  if (typeof source === "string") {
    return source;
  }

  if (source && typeof source === "object" && "subAgent" in source) {
    return "subAgent";
  }

  return "unknown";
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

    const mergedEntry: TranscriptEntry = {
      ...existing.entry,
      ...entry,
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
    const projectOrchestratorSessionById: Record<string, string> = {};
    const suggestionHelperSessionIds: Record<string, true> = {};
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

    if (isObjectRecord(parsed) && isObjectRecord(parsed.projectOrchestratorSessionById)) {
      for (const [projectId, sessionId] of Object.entries(parsed.projectOrchestratorSessionById)) {
        if (typeof sessionId !== "string" || sessionId.trim().length === 0 || !(projectId in projects)) {
          continue;
        }
        projectOrchestratorSessionById[projectId] = sessionId;
        systemOwnedSessionIds[sessionId] = true;
      }
    }

    if (isObjectRecord(parsed) && isObjectRecord(parsed.suggestionHelperSessionIds)) {
      for (const [sessionId, enabled] of Object.entries(parsed.suggestionHelperSessionIds)) {
        if (enabled === true) {
          suggestionHelperSessionIds[sessionId] = true;
          systemOwnedSessionIds[sessionId] = true;
        }
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
      projectOrchestratorSessionById,
      suggestionHelperSessionIds,
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
      projectOrchestratorSessionById: {},
      suggestionHelperSessionIds: {},
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
  let orchestratorMappingChanged = false;
  for (const [projectId, mappedSessionId] of Object.entries(sessionMetadata.projectOrchestratorSessionById)) {
    if (mappedSessionId !== sessionId) {
      continue;
    }
    if (nextProjectId === projectId) {
      continue;
    }
    delete sessionMetadata.projectOrchestratorSessionById[projectId];
    orchestratorMappingChanged = true;
  }

  if (nextProjectId === null) {
    if (sessionId in sessionMetadata.sessionProjectById) {
      delete sessionMetadata.sessionProjectById[sessionId];
      return true;
    }
    return orchestratorMappingChanged;
  }

  if (currentProjectId === nextProjectId) {
    return orchestratorMappingChanged;
  }

  sessionMetadata.sessionProjectById[sessionId] = nextProjectId;
  return true;
}

function defaultSessionTitle(): string {
  return "New chat";
}

function buildProjectOrchestratorTitle(projectName: string): string {
  const trimmed = projectName.trim();
  if (!trimmed) {
    return "Project Orchestrator";
  }

  const cappedName = trimmed.length > 140 ? `${trimmed.slice(0, 140).trim()}...` : trimmed;
  return `${cappedName} Orchestrator`;
}

async function setSessionTitle(threadId: string, title: string): Promise<void> {
  const normalized = title.trim();
  if (!normalized) {
    return;
  }

  try {
    await supervisor.call("thread/name/set", {
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

async function createProjectOrchestrationSession(
  projectId: string,
  projectName: string,
  workingDirectory: string | null
): Promise<CodexThread> {
  const startResponse = await callThreadMethodWithRawEventsFallback<{ thread: CodexThread }>("thread/start", {
    cwd: workingDirectory ?? env.WORKSPACE_ROOT,
    sandbox: env.DEFAULT_SANDBOX_MODE,
    approvalPolicy: env.DEFAULT_APPROVAL_POLICY
  });
  const orchestrationThread = startResponse.thread;
  sessionMetadata.sessionProjectById[orchestrationThread.id] = projectId;
  sessionMetadata.projectOrchestratorSessionById[projectId] = orchestrationThread.id;
  setSystemOwnedSession(orchestrationThread.id, true);
  await setSessionTitle(orchestrationThread.id, buildProjectOrchestratorTitle(projectName));
  await persistSessionMetadata();
  return orchestrationThread;
}

async function ensureProjectOrchestrationSessions(): Promise<void> {
  if (projectOrchestratorsEnsureInFlight) {
    await projectOrchestratorsEnsureInFlight;
    return;
  }

  projectOrchestratorsEnsureInFlight = (async () => {
    for (const [projectId, project] of Object.entries(sessionMetadata.projects)) {
      const mappedSessionId = sessionMetadata.projectOrchestratorSessionById[projectId];
      if (typeof mappedSessionId === "string" && mappedSessionId.trim().length > 0) {
        const systemOwnedChanged = setSystemOwnedSession(mappedSessionId, true);
        const exists = await sessionExistsForProjectAssignment(mappedSessionId);
        if (exists) {
          if (systemOwnedChanged) {
            await persistSessionMetadata();
          }
          continue;
        }

        setSessionProjectAssignment(mappedSessionId, null);
        setSessionTitleOverride(mappedSessionId, null);
        delete sessionMetadata.projectOrchestratorSessionById[projectId];
      }

      const created = await createProjectOrchestrationSession(projectId, project.name, project.workingDirectory);
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
  })();

  try {
    await projectOrchestratorsEnsureInFlight;
  } finally {
    projectOrchestratorsEnsureInFlight = null;
  }
}

function clearProjectOrchestratorSessionForSession(sessionId: string): boolean {
  let changed = false;
  for (const [projectId, mappedSessionId] of Object.entries(sessionMetadata.projectOrchestratorSessionById)) {
    if (mappedSessionId !== sessionId) {
      continue;
    }
    delete sessionMetadata.projectOrchestratorSessionById[projectId];
    changed = true;
  }
  return changed;
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

function isSuggestionHelperSession(sessionId: string): boolean {
  return sessionMetadata.suggestionHelperSessionIds[sessionId] === true;
}

function setSuggestionHelperSession(sessionId: string, enabled: boolean): boolean {
  let changed = false;
  if (enabled) {
    if (sessionMetadata.suggestionHelperSessionIds[sessionId] === true) {
      return setSystemOwnedSession(sessionId, true);
    }
    sessionMetadata.suggestionHelperSessionIds[sessionId] = true;
    changed = true;
    changed = setSystemOwnedSession(sessionId, true) || changed;
    return changed;
  }

  if (sessionId in sessionMetadata.suggestionHelperSessionIds) {
    delete sessionMetadata.suggestionHelperSessionIds[sessionId];
    changed = true;
  }

  return changed;
}

async function cleanupSuggestionHelperSessions(): Promise<void> {
  if (suggestionHelpersCleanupInFlight) {
    await suggestionHelpersCleanupInFlight;
    return;
  }

  const helperSessionIds = Object.keys(sessionMetadata.suggestionHelperSessionIds);
  if (helperSessionIds.length === 0) {
    return;
  }

  suggestionHelpersCleanupInFlight = (async () => {
    for (const sessionId of helperSessionIds) {
      if (suggestionThreadIds.has(sessionId)) {
        continue;
      }
      try {
        await hardDeleteSession(sessionId);
      } catch (error) {
        app.log.warn({ error, sessionId }, "failed to clean up suggestion helper session");
      }
    }
  })();

  try {
    await suggestionHelpersCleanupInFlight;
  } finally {
    suggestionHelpersCleanupInFlight = null;
  }
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
  return status === "in_progress" || status === "pending" || status === "running";
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

function buildSuggestionPrompt(contextEntries: Array<TranscriptEntry>, draft?: string): string {
  const lines = contextEntries
    .map((entry) => {
      const cleaned = entry.content
        .replace(/\s+/g, " ")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("Documentation Impact Assessment:"))
        .filter((line) => !line.includes("You are preparing a suggested next user reply for a chat conversation."))
        .filter((line) => !line.includes("Conversation excerpt:"))
        .filter((line) => !line.includes("Suggested reply:"))
        .join(" ");
      return cleaned.length > 0 ? `${entry.role.toUpperCase()}: ${cleaned}` : "";
    })
    .filter((line) => line.length > 0);
  const cleanedDraft = typeof draft === "string" ? draft.trim() : "";

  return [
    "You are preparing a suggested next user reply for a chat conversation.",
    "Return only the suggested message text that the user should send next.",
    "Do not include role labels, markdown code fences, or any explanation.",
    "Keep it concise, practical, and aligned with the latest user intent.",
    "",
    "Conversation excerpt:",
    lines.join("\n"),
    "",
    cleanedDraft ? `Current user draft to refine:\n${cleanedDraft}\n` : "",
    "Suggested reply:"
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

function stripSuggestionScaffolding(text: string): string {
  let next = text.trim();
  if (!next) {
    return "";
  }

  const suggestedReplyMarker = "Suggested reply:";
  const markerIndex = next.lastIndexOf(suggestedReplyMarker);
  if (markerIndex !== -1) {
    next = next.slice(markerIndex + suggestedReplyMarker.length).trim();
  }

  if (next.startsWith("You are preparing a suggested next user reply")) {
    return "";
  }

  next = next
    .replace(/You are preparing a suggested next user reply for a chat conversation\./gi, "")
    .replace(/Return only the suggested message text that the user should send next\./gi, "")
    .replace(/Do not include role labels, markdown code fences, or any explanation\./gi, "")
    .replace(/Keep it concise, practical, and aligned with the latest user intent\./gi, "")
    .replace(/Conversation excerpt:/gi, "")
    .replace(/Current user draft to refine:/gi, "")
    .replace(/Suggested reply:/gi, "")
    .replace(/\b(USER|ASSISTANT):/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("Conversation excerpt:"))
    .filter((line) => !line.startsWith("Current user draft to refine:"))
    .filter((line) => !line.startsWith("USER:"))
    .filter((line) => !line.startsWith("ASSISTANT:"))
    .join("\n")
    .trim();

  return next;
}

function buildFallbackSuggestedReply(contextEntries: Array<TranscriptEntry>, draft?: string): string {
  const cleanedDraft = typeof draft === "string" ? draft.trim() : "";
  if (cleanedDraft.length > 0) {
    return cleanedDraft;
  }

  const lastUser = [...contextEntries].reverse().find((entry) => entry.role === "user" && entry.content.trim().length > 0);
  if (lastUser) {
    const request = lastUser.content.replace(/\s+/g, " ").trim().slice(0, 220);
    return `Please continue from your last response and focus on this request: ${request}`;
  }

  const lastAssistant = [...contextEntries].reverse().find((entry) => entry.role === "assistant" && entry.content.trim().length > 0);
  if (lastAssistant) {
    const summarized = lastAssistant.content.replace(/\s+/g, " ").trim().slice(0, 260);
    return `Please continue from your last response and focus on the concrete next step. (${summarized})`;
  }

  return "Please continue with the next concrete step and include exact commands or code changes.";
}

function suggestionContextEntriesFromTranscript(transcript: Array<TranscriptEntry>): Array<TranscriptEntry> {
  return transcript
    .filter((entry) => (entry.role === "user" || entry.role === "assistant") && entry.content.trim().length > 0)
    .slice(-12);
}

async function loadSuggestionContext(sessionId: string): Promise<{
  sourceThread: CodexThread;
  transcript: Array<TranscriptEntry>;
  contextEntries: Array<TranscriptEntry>;
}> {
  let sourceThread: CodexThread;
  let transcript: Array<TranscriptEntry>;

  try {
    const source = await supervisor.call<{ thread: CodexThread }>("thread/read", {
      threadId: sessionId,
      includeTurns: true
    });
    sourceThread = source.thread;
    transcript = turnsToTranscript(sessionId, Array.isArray(source.thread.turns) ? source.thread.turns : []);
  } catch (error) {
    if (!isIncludeTurnsUnavailableError(error)) {
      throw error;
    }

    const source = await supervisor.call<{ thread: CodexThread }>("thread/read", {
      threadId: sessionId,
      includeTurns: false
    });
    sourceThread = source.thread;
    transcript = [];
  }

  transcript = mergeTranscriptWithSupplemental(sessionId, transcript);
  return {
    sourceThread,
    transcript,
    contextEntries: suggestionContextEntriesFromTranscript(transcript)
  };
}

function suggestionQueueProjectId(sessionId: string): string {
  const projectId = resolveSessionProjectId(sessionId);
  if (projectId) {
    return projectId;
  }
  return `session:${sessionId}`;
}

async function generateSuggestedReplyForJob(
  payload: SuggestReplyJobPayload,
  options?: {
    signal?: AbortSignal;
    onTurnStarted?: (threadId: string, turnId: string) => void;
  }
): Promise<SuggestReplyJobResult> {
  throwIfAborted(options?.signal);
  const context = await loadSuggestionContext(payload.sessionId);
  const contextEntries = context.contextEntries;
  const helperFallbackEnabled = env.ORCHESTRATOR_SUGGEST_REPLY_ALLOW_HELPER_FALLBACK;

  if (contextEntries.length === 0) {
    const fallbackSuggestion = buildFallbackSuggestedReply(contextEntries, payload.draft);
    if (fallbackSuggestion.trim().length > 0 && typeof payload.draft === "string" && payload.draft.trim().length > 0) {
      return {
        suggestion: fallbackSuggestion,
        requestKey: payload.requestKey
      };
    }
    throw new Error("no_context");
  }

  let helperThreadId: string | null = null;
  let targetThreadId: string | null = null;
  let fallbackReason = "unknown";
  const suggestionPrompt = buildSuggestionPrompt(contextEntries, payload.draft);
  const runSuggestionTurn = async (threadId: string): Promise<string> => {
    throwIfAborted(options?.signal);
    const turn = await supervisor.call<{ turn: { id: string } }>("turn/start", {
      threadId,
      model: payload.model,
      effort: payload.effort as ReasoningEffort | undefined,
      sandboxPolicy: toTurnSandboxPolicy("read-only"),
      approvalPolicy: "never",
      input: [
        {
          type: "text",
          text: suggestionPrompt,
          text_elements: []
        }
      ]
    });
    options?.onTurnStarted?.(threadId, turn.turn.id);
    throwIfAborted(options?.signal);

    const rawSuggestion = await waitForSuggestedReply(threadId, turn.turn.id, options?.signal);
    const suggestion = stripSuggestionScaffolding(rawSuggestion);
    if (!suggestion) {
      throw new Error("suggestion output contained only orchestration scaffolding");
    }
    return suggestion;
  };

  try {
    const projectId = resolveSessionProjectId(payload.sessionId);
    if (projectId) {
      await ensureProjectOrchestrationSessions();
      const orchestrationSessionId = sessionMetadata.projectOrchestratorSessionById[projectId];
      if (typeof orchestrationSessionId === "string" && orchestrationSessionId.trim().length > 0) {
        targetThreadId = orchestrationSessionId;
      }
    }

    if (targetThreadId) {
      try {
        const suggestion = await runSuggestionTurn(targetThreadId);
        return {
          suggestion,
          requestKey: payload.requestKey
        };
      } catch (orchestratorError) {
        fallbackReason = "project_orchestrator_failed";
        app.log.warn(
          { error: orchestratorError, sessionId: payload.sessionId, targetThreadId },
          "project orchestrator suggestion turn failed"
        );
      }
    }

    if (!helperFallbackEnabled) {
      if (fallbackReason === "unknown") {
        fallbackReason = targetThreadId ? "project_orchestrator_unavailable" : "project_orchestrator_not_configured";
      }
      const fallbackSuggestion = buildFallbackSuggestedReply(contextEntries, payload.draft);
      return {
        suggestion: fallbackSuggestion,
        requestKey: payload.requestKey
      };
    }

    helperThreadId = await ensureSuggestionThread(payload.sessionId, context.sourceThread, payload.model);
    targetThreadId = helperThreadId;
    try {
      const suggestion = await runSuggestionTurn(targetThreadId);
      return {
        suggestion,
        requestKey: payload.requestKey
      };
    } catch (helperError) {
      fallbackReason = targetThreadId === helperThreadId ? "helper_first_attempt_failed" : fallbackReason;
      app.log.warn(
        { error: helperError, sessionId: payload.sessionId, helperThreadId },
        "helper suggestion turn failed; retrying with fresh helper thread"
      );
    }

    helperThreadId = await ensureSuggestionThread(payload.sessionId, context.sourceThread, payload.model);
    targetThreadId = helperThreadId;
    const suggestion = await runSuggestionTurn(targetThreadId);
    return {
      suggestion,
      requestKey: payload.requestKey
    };
  } catch (error) {
    if (isAbortError(error) || options?.signal?.aborted) {
      throw error;
    }
    if (fallbackReason === "unknown") {
      fallbackReason = "unexpected_error";
    }
    app.log.warn({ error, sessionId: payload.sessionId, fallbackReason }, "failed to generate suggested reply");
    const fallbackSuggestion = buildFallbackSuggestedReply(contextEntries, payload.draft);
    return {
      suggestion: fallbackSuggestion,
      requestKey: payload.requestKey
    };
  } finally {
    if (helperThreadId) {
      await cleanupSuggestionThread(payload.sessionId, helperThreadId);
    }
  }
}

function fileChangeExplainMessageId(payload: { threadId: string; turnId: string; itemId: string }): string {
  return `file-change-explain-${payload.threadId}-${payload.turnId}-${payload.itemId}`;
}

function fileChangeExplainDetails(anchorItemId: string, metadata?: Record<string, unknown>): string {
  return JSON.stringify(
    {
      anchorItemId,
      ...(metadata ?? {})
    },
    null,
    2
  );
}

function upsertFileChangeExplainabilityEntry(
  payload: FileChangeExplainJobPayload,
  input: {
    status: TranscriptEntry["status"];
    content: string;
    completedAt?: number;
  }
): void {
  const now = Date.now();
  const messageId = fileChangeExplainMessageId(payload);
  upsertSupplementalTranscriptEntry(payload.threadId, {
    messageId,
    turnId: payload.turnId,
    role: "system",
    type: "fileChange.explainability",
    content: input.content,
    details: fileChangeExplainDetails(payload.anchorItemId),
    startedAt: now,
    ...(typeof input.completedAt === "number" ? { completedAt: input.completedAt } : {}),
    status: input.status
  });
}

function buildFileChangeExplainPrompt(payload: FileChangeExplainJobPayload): string {
  return [
    "You are explaining a completed code diff to a developer.",
    "Write a concise markdown explanation with these sections:",
    "1) What changed",
    "2) Why it likely changed",
    "3) Potential risks or follow-up checks",
    "Keep it factual and avoid speculation beyond reasonable inference.",
    "",
    `Diff summary: ${payload.summary}`,
    "",
    "Diff details JSON:",
    payload.details
  ].join("\n");
}

function fallbackFileChangeExplanation(payload: FileChangeExplainJobPayload): string {
  return [
    "### What changed",
    payload.summary,
    "",
    "### Why it likely changed",
    "The update appears to align with the current turn intent and requested modifications.",
    "",
    "### Potential risks or follow-up checks",
    "- Review touched files for edge cases.",
    "- Run relevant tests for modified paths."
  ].join("\n");
}

async function generateFileChangeExplainabilityForJob(
  payload: FileChangeExplainJobPayload,
  options?: {
    signal?: AbortSignal;
    onTurnStarted?: (threadId: string, turnId: string) => void;
  }
): Promise<FileChangeExplainJobResult> {
  throwIfAborted(options?.signal);
  await ensureProjectOrchestrationSessions();
  const orchestrationSessionId = sessionMetadata.projectOrchestratorSessionById[payload.projectId];
  if (!orchestrationSessionId) {
    throw new Error(`missing project orchestrator session for ${payload.projectId}`);
  }

  const turn = await supervisor.call<{ turn: { id: string } }>("turn/start", {
    threadId: orchestrationSessionId,
    sandboxPolicy: toTurnSandboxPolicy("read-only"),
    approvalPolicy: "never",
    input: [
      {
        type: "text",
        text: buildFileChangeExplainPrompt(payload),
        text_elements: []
      }
    ]
  });
  options?.onTurnStarted?.(orchestrationSessionId, turn.turn.id);
  throwIfAborted(options?.signal);

  const rawExplanation = await waitForSuggestedReply(orchestrationSessionId, turn.turn.id, options?.signal);
  const explanation = rawExplanation.trim().length > 0 ? rawExplanation.trim() : fallbackFileChangeExplanation(payload);

  return {
    messageId: fileChangeExplainMessageId(payload),
    explanation,
    anchorItemId: payload.anchorItemId
  };
}

function buildFileChangeExplainJobPayload(input: {
  threadId: string;
  turnId: string;
  itemId: string;
  item: CodexThreadItem;
}): FileChangeExplainJobPayload | null {
  const projectId = resolveSessionProjectId(input.threadId);
  if (!projectId) {
    return null;
  }
  if (isSystemOwnedSession(input.threadId)) {
    return null;
  }

  const status = typeof input.item.status === "string" ? input.item.status.toLowerCase() : "";
  if (status.includes("fail") || status.includes("error") || status.includes("cancel")) {
    return null;
  }

  const changes = Array.isArray(input.item.changes) ? input.item.changes : [];
  if (changes.length === 0) {
    return null;
  }

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

  if (normalizedChanges.length === 0 || !hasAnyDiff) {
    return null;
  }

  const summary = `File change completed: ${normalizedChanges.length} change${normalizedChanges.length === 1 ? "" : "s"}`;
  const detailsRecord = {
    status: typeof input.item.status === "string" ? input.item.status : "completed",
    changes: normalizedChanges
  };
  let details = JSON.stringify(detailsRecord, null, 2);
  if (details.length > env.ORCHESTRATOR_DIFF_EXPLAIN_MAX_DIFF_CHARS) {
    details = `${details.slice(0, env.ORCHESTRATOR_DIFF_EXPLAIN_MAX_DIFF_CHARS)}\n... (truncated)`;
  }

  return {
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: input.itemId,
    projectId,
    sourceSessionId: input.threadId,
    summary,
    details,
    anchorItemId: input.itemId
  };
}

async function ensureSuggestionThread(sessionId: string, sourceThread: CodexThread, model?: string): Promise<string> {
  const previousThreadId = suggestionThreadBySession.get(sessionId);
  if (previousThreadId) {
    await cleanupSuggestionThread(sessionId, previousThreadId);
  }

  const created = await supervisor.call<{ thread: CodexThread }>("thread/start", {
    cwd: sourceThread.cwd,
    model: model || undefined,
    sandbox: "read-only",
    approvalPolicy: "never",
    experimentalRawEvents: false
  });
  const helperThreadId = created.thread.id;
  suggestionThreadBySession.set(sessionId, helperThreadId);
  suggestionThreadIds.add(helperThreadId);
  if (setSuggestionHelperSession(helperThreadId, true)) {
    await persistSessionMetadata();
  }

  try {
    await supervisor.call("thread/archive", {
      threadId: helperThreadId
    });
  } catch (error) {
    app.log.warn({ error, sessionId, helperThreadId }, "failed to archive suggestion helper thread");
  }

  return helperThreadId;
}

async function cleanupSuggestionThread(sessionId: string, helperThreadId: string): Promise<void> {
  if (suggestionThreadBySession.get(sessionId) === helperThreadId) {
    suggestionThreadBySession.delete(sessionId);
  }
  suggestionThreadIds.delete(helperThreadId);

  try {
    await hardDeleteSession(helperThreadId);
  } catch (error) {
    app.log.warn({ error, sessionId, helperThreadId }, "failed to cleanup suggestion helper thread");
  }
}

async function waitForSuggestedReply(threadId: string, turnId: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const startedAt = Date.now();
  const timeoutMs = 30_000;
  let sawCompletedTurnWithoutOutput = false;

  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(signal);
    const response = await supervisor.call<{ thread: CodexThread }>("thread/read", {
      threadId,
      includeTurns: true
    });
    const turn = response.thread.turns.find((entry) => entry.id === turnId);
    if (!turn) {
      await delayWithSignal(350, signal);
      continue;
    }

    const suggestion = latestAgentMessageFromTurn(turn);
    if (!isTurnStillRunning(turn.status)) {
      if (suggestion) {
        return suggestion;
      }
      sawCompletedTurnWithoutOutput = true;
      await delayWithSignal(350, signal);
      continue;
    }

    await delayWithSignal(350, signal);
  }

  if (sawCompletedTurnWithoutOutput) {
    throw new Error("suggestion turn completed but no assistant message was readable before timeout");
  }

  throw new Error("timed out waiting for suggested reply");
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
    return supervisor.call<T>(method, params);
  }

  try {
    const response = await supervisor.call<T>(method, {
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
    return supervisor.call<T>(method, params);
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
        await supervisor.call(probe.method, probe.probeParams);
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
    const response = await supervisor.call<{ thread: CodexThread & { threadName?: unknown; name?: unknown } }>(
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
    const response: { data: Array<CodexThread>; nextCursor: string | null } = await supervisor.call("thread/list", {
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
    await supervisor.call("thread/read", {
      threadId: sessionId,
      includeTurns: false
    });
    return true;
  } catch (error) {
    if (isInvalidThreadIdError(error)) {
      return false;
    }

    if (!isNoRolloutFoundError(error)) {
      throw error;
    }
  }

  const loaded = await supervisor.call<{ data: Array<string> }>("thread/loaded/list", {});
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
    supervisor.call<{ data: Array<string> }>("thread/loaded/list", {})
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
    const helperMetadataChanged = setSuggestionHelperSession(sessionId, false);
    const systemMetadataChanged = setSystemOwnedSession(sessionId, false);
    const policyMetadataChanged = setSessionApprovalPolicy(sessionId, null);
    const turnTimingMetadataChanged = clearSessionTurnTimings(sessionId);
    clearSupplementalTranscriptEntries(sessionId);
    if (helperMetadataChanged || systemMetadataChanged || policyMetadataChanged || turnTimingMetadataChanged) {
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
      await supervisor.call("turn/interrupt", {
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
    const response = await supervisor.call<{
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
    const titleMetadataChanged = setSessionTitleOverride(sessionId, null);
    const projectMetadataChanged = setSessionProjectAssignment(sessionId, null);
    const orchestratorMetadataChanged = clearProjectOrchestratorSessionForSession(sessionId);
    const helperMetadataChanged = setSuggestionHelperSession(sessionId, false);
    const policyMetadataChanged = setSessionApprovalPolicy(sessionId, null);
    const turnTimingMetadataChanged = clearSessionTurnTimings(sessionId);
    clearSupplementalTranscriptEntries(sessionId);
    if (
      titleMetadataChanged ||
      projectMetadataChanged ||
      orchestratorMetadataChanged ||
      helperMetadataChanged ||
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
  const helperThreadId = suggestionThreadBySession.get(sessionId);
  suggestionThreadBySession.delete(sessionId);
  if (helperThreadId) {
    suggestionThreadIds.delete(helperThreadId);
  }
  clearSupplementalTranscriptEntries(sessionId);
  clearPendingApprovalsForThread(sessionId);
  clearPendingToolInputsForThread(sessionId);
  purgedSessionIds.add(sessionId);

  const titleMetadataChanged = setSessionTitleOverride(sessionId, null);
  const projectMetadataChanged = setSessionProjectAssignment(sessionId, null);
  const orchestratorMetadataChanged = clearProjectOrchestratorSessionForSession(sessionId);
  const helperMetadataChanged = setSuggestionHelperSession(sessionId, false);
  const systemMetadataChanged = setSystemOwnedSession(sessionId, false);
  const policyMetadataChanged = setSessionApprovalPolicy(sessionId, null);
  const turnTimingMetadataChanged = clearSessionTurnTimings(sessionId);
  if (
    titleMetadataChanged ||
    projectMetadataChanged ||
    orchestratorMetadataChanged ||
    helperMetadataChanged ||
    systemMetadataChanged ||
    policyMetadataChanged ||
    turnTimingMetadataChanged
  ) {
    await persistSessionMetadata();
  }

  const payload = deletedSessionPayload(sessionId, knownTitle);
  publishToSockets("session_deleted", payload, sessionId, { broadcastToAll: true });

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

function publishToSockets(type: string, payload: unknown, threadId?: string, options?: { broadcastToAll?: boolean }): void {
  const envelope = JSON.stringify({
    type,
    threadId: threadId ?? null,
    payload
  });

  for (const socket of sockets) {
    const filter = socketThreadFilter.get(socket) ?? null;
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

function buildOrchestratorJobDefinitions(): JobDefinitionsMap {
  const definitions: Array<any> = [];

  if (env.ORCHESTRATOR_SUGGEST_REPLY_ENABLED) {
    definitions.push({
      type: "suggest_reply",
      version: 1,
      priority: "interactive",
      payloadSchema: suggestReplyJobPayloadSchema,
      resultSchema: suggestReplyJobResultSchema,
      dedupe: {
        key: (payload: SuggestReplyJobPayload) => `${payload.projectId}:${payload.sessionId}:suggest_reply`,
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
          if (message.includes("timed out") || message.includes("timeout")) {
            return "retryable";
          }
          return "fatal";
        },
        baseDelayMs: 500,
        maxDelayMs: 5_000,
        jitter: true
      },
      timeoutMs: env.ORCHESTRATOR_QUEUE_DEFAULT_TIMEOUT_MS,
      cancel: {
        strategy: "interrupt_turn",
        gracefulWaitMs: 1_500
      },
      run: async (ctx: JobRunContext, payload: SuggestReplyJobPayload) =>
        generateSuggestedReplyForJob(payload, {
          signal: ctx.signal,
          onTurnStarted: (threadId, turnId) => {
            ctx.setRunningContext({ threadId, turnId });
          }
        })
    });
  }

  if (env.ORCHESTRATOR_DIFF_EXPLAIN_ENABLED) {
    definitions.push({
      type: "file_change_explain",
      version: 1,
      priority: "background",
      payloadSchema: fileChangeExplainJobPayloadSchema,
      resultSchema: fileChangeExplainJobResultSchema,
      dedupe: {
        key: (payload: FileChangeExplainJobPayload) => `${payload.projectId}:${payload.threadId}:${payload.turnId}:${payload.itemId}`,
        mode: "drop_duplicate"
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
          if (message.includes("timed out") || message.includes("timeout")) {
            return "retryable";
          }
          return "fatal";
        },
        baseDelayMs: 1_000,
        maxDelayMs: 10_000,
        jitter: true
      },
      timeoutMs: Math.max(env.ORCHESTRATOR_QUEUE_DEFAULT_TIMEOUT_MS, 90_000),
      cancel: {
        strategy: "interrupt_turn",
        gracefulWaitMs: 1_500
      },
      onQueued: async (_ctx: unknown, payload: FileChangeExplainJobPayload) => {
        upsertFileChangeExplainabilityEntry(payload, {
          status: "streaming",
          content: "Queued explainability analysis..."
        });
      },
      onStarted: async (_ctx: unknown, payload: FileChangeExplainJobPayload) => {
        upsertFileChangeExplainabilityEntry(payload, {
          status: "streaming",
          content: "Analyzing completed file change..."
        });
      },
      onCompleted: async (_ctx: unknown, payload: FileChangeExplainJobPayload, result: FileChangeExplainJobResult) => {
        upsertFileChangeExplainabilityEntry(payload, {
          status: "complete",
          content: result.explanation,
          completedAt: Date.now()
        });
      },
      onFailed: async (_ctx: unknown, payload: FileChangeExplainJobPayload, error: string) => {
        upsertFileChangeExplainabilityEntry(payload, {
          status: "error",
          content: `Explainability failed: ${error}`,
          completedAt: Date.now()
        });
      },
      onCanceled: async (_ctx: unknown, payload: FileChangeExplainJobPayload) => {
        upsertFileChangeExplainabilityEntry(payload, {
          status: "canceled",
          content: "Explainability canceled before completion.",
          completedAt: Date.now()
        });
      },
      run: async (ctx: JobRunContext, payload: FileChangeExplainJobPayload) =>
        generateFileChangeExplainabilityForJob(payload, {
          signal: ctx.signal,
          onTurnStarted: (threadId, turnId) => {
            ctx.setRunningContext({ threadId, turnId });
          }
        })
    });
  }

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
  return error instanceof Error && error.message.includes("includeTurns is unavailable before first user message");
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
  if (mode === "read-only") {
    return { type: "readOnly" };
  }

  if (mode === "workspace-write") {
    return { type: "workspaceWrite", networkAccess: networkAccess === "enabled" };
  }

  return { type: "dangerFullAccess" };
}

function listPendingApprovalsByThread(threadId: string): Array<PendingApproval> {
  const approvals: Array<PendingApproval> = [];

  for (const approval of pendingApprovals.values()) {
    if (approval.threadId === threadId && approval.status === "pending") {
      approvals.push(toPublicApproval(approval));
    }
  }

  approvals.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return approvals;
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

supervisor.on("notification", (notification: JsonRpcNotification) => {
  const threadId = extractThreadId(notification.params);
  if (threadId && (suggestionThreadIds.has(threadId) || isSuggestionHelperSession(threadId) || isSystemOwnedSession(threadId))) {
    return;
  }
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
      activeTurnByThread.set(params.threadId, params.turn.id);
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
      activeTurnByThread.delete(params.threadId);

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

    if (notification.method === "item/completed" && item.type === "fileChange" && orchestratorQueue) {
      const explainPayload = buildFileChangeExplainJobPayload({
        threadId,
        turnId,
        itemId: item.id,
        item
      });
      if (explainPayload) {
        void orchestratorQueue
          .enqueue({
            type: "file_change_explain",
            projectId: explainPayload.projectId,
            sourceSessionId: threadId,
            payload: explainPayload
          })
          .catch((error) => {
            app.log.warn(
              {
                error,
                threadId,
                turnId,
                itemId: item.id
              },
              "failed to enqueue file-change explainability job"
            );
          });
      }
    }
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

supervisor.on("serverRequest", (serverRequest: JsonRpcServerRequest) => {
  const requestThreadId = extractThreadId(serverRequest.params);
  if (
    requestThreadId &&
    (suggestionThreadIds.has(requestThreadId) || isSuggestionHelperSession(requestThreadId) || isSystemOwnedSession(requestThreadId))
  ) {
    const approval = createPendingApproval(serverRequest);
    if (approval) {
      const payload = approvalDecisionPayload(approval, "decline", "turn");
      void supervisor
        .respond(serverRequest.id, payload)
        .catch((error) => {
          app.log.warn({ error, threadId: requestThreadId }, "failed to decline suggestion helper approval request");
        });
      return;
    }

    const toolInput = createPendingToolUserInput(serverRequest);
    if (toolInput) {
      const payload = toolUserInputResponsePayload({
        decision: "cancel"
      });
      void supervisor
        .respond(serverRequest.id, payload)
        .catch((error) => {
          app.log.warn({ error, threadId: requestThreadId }, "failed to cancel suggestion helper tool input request");
        });
      return;
    }

    void supervisor
      .respondError(serverRequest.id, {
        code: -32600,
        message: "unsupported helper-thread server request"
      })
      .catch((error) => {
        app.log.warn({ error, threadId: requestThreadId }, "failed to reject server request for suggestion helper thread");
      });
    return;
  }
  if (requestThreadId && isSessionPurged(requestThreadId)) {
    void supervisor
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

  void supervisor
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
    codex: supervisor.status(),
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
      initialized: supervisor.status().initialized,
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
    const response = await supervisor.call<{ data: Array<Record<string, unknown>>; nextCursor: string | null }>(
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
    const response = await supervisor.call<{ data: Array<Record<string, unknown>>; nextCursor?: string | null }>(
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
    const response = await supervisor.call<{ data: Array<Record<string, unknown>>; nextCursor: string | null }>("app/list", {
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
    const response = await supervisor.call<{ data: Array<Record<string, unknown>>; nextCursor?: string | null }>("skills/list", {
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
    const response = await supervisor.call("skills/config/write", {
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
    const response = await supervisor.call("skills/remote/read", {});
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
    const response = await supervisor.call("skills/remote/write", {
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
    const response = await supervisor.call("config/mcpServer/reload", undefined);
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
    const response = await supervisor.call("mcpServer/oauth/login", {
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
    const response = await supervisor.call("account/read", {});
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
    const response = await supervisor.call("account/login/start", {
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
    const response = await supervisor.call("account/login/cancel", {
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
    const response = await supervisor.call("account/logout", undefined);
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
    const response = await supervisor.call("account/rateLimits/read", undefined);
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
    const response = await supervisor.call("config/read", {
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
    const response = await supervisor.call("configRequirements/read", undefined);
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
    const response = await supervisor.call("config/value/write", {
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
    const response = await supervisor.call("config/batchWrite", {
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
    const response = await supervisor.call("command/exec", {
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
    const response = await supervisor.call("feedback/upload", {
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

  const response = await supervisor.call<{ data: Array<Record<string, unknown>>; nextCursor: string | null }>(
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

  const response = await supervisor.call<{ data: Array<Record<string, unknown>>; nextCursor: string | null }>(
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

app.get("/api/projects", async () => {
  await ensureProjectOrchestrationSessions();
  return {
    data: listProjectSummaries()
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

  let orchestrationThread: CodexThread | null = null;
  try {
    orchestrationThread = await createProjectOrchestrationSession(projectId, project.name, project.workingDirectory);
  } catch (error) {
    delete sessionMetadata.projects[projectId];
    delete sessionMetadata.projectOrchestratorSessionById[projectId];
    if (orchestrationThread) {
      delete sessionMetadata.sessionProjectById[orchestrationThread.id];
      if (sessionMetadata.titles[orchestrationThread.id]) {
        delete sessionMetadata.titles[orchestrationThread.id];
      }
      void hardDeleteSession(orchestrationThread.id).catch((cleanupError) => {
        app.log.warn({ error: cleanupError, threadId: orchestrationThread?.id }, "failed to cleanup orchestration session");
      });
    }
    return sendMappedCodexError(reply, error, "failed to create project orchestration session", {
      method: "thread/start",
      projectId
    });
  }

  const payload = toProjectSummary(projectId, project);
  publishToSockets("project_upserted", { project: payload }, undefined, { broadcastToAll: true });
  if (orchestrationThread) {
    publishToSockets(
      "session_project_updated",
      {
        sessionId: orchestrationThread.id,
        projectId
      },
      orchestrationThread.id,
      { broadcastToAll: true }
    );
  }
  return {
    status: "ok",
    project: payload,
    orchestrationSession: orchestrationThread ? toSessionSummary(orchestrationThread, false) : null
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
  const previousName = current.name;
  const shouldUpdateName = current.name !== nextName;
  const shouldUpdateWorkingDirectory = current.workingDirectory !== nextWorkingDirectory;

  if (shouldUpdateName || shouldUpdateWorkingDirectory) {
    let replacementOrchestratorThread: CodexThread | null = null;
    const previousOrchestratorSessionId = sessionMetadata.projectOrchestratorSessionById[params.projectId] ?? null;
    if (shouldUpdateWorkingDirectory) {
      try {
        replacementOrchestratorThread = await createProjectOrchestrationSession(params.projectId, nextName, nextWorkingDirectory);
      } catch (error) {
        return sendMappedCodexError(reply, error, "failed to update project orchestration session", {
          method: "thread/start",
          projectId: params.projectId
        });
      }
    }

    current.name = nextName;
    current.workingDirectory = nextWorkingDirectory;
    current.updatedAt = new Date().toISOString();
    const orchestratorSessionId = sessionMetadata.projectOrchestratorSessionById[params.projectId];
    if (
      shouldUpdateName &&
      !shouldUpdateWorkingDirectory &&
      typeof orchestratorSessionId === "string" &&
      orchestratorSessionId.trim().length > 0
    ) {
      const currentStoredTitle = sessionMetadata.titles[orchestratorSessionId];
      const expectedPreviousTitle = buildProjectOrchestratorTitle(previousName);
      if (!currentStoredTitle || currentStoredTitle === expectedPreviousTitle) {
        await setSessionTitle(orchestratorSessionId, buildProjectOrchestratorTitle(nextName));
      }
    }
    await persistSessionMetadata();

    if (replacementOrchestratorThread) {
      publishToSockets(
        "session_project_updated",
        {
          sessionId: replacementOrchestratorThread.id,
          projectId: params.projectId
        },
        replacementOrchestratorThread.id,
        { broadcastToAll: true }
      );
    }

    if (
      replacementOrchestratorThread &&
      typeof previousOrchestratorSessionId === "string" &&
      previousOrchestratorSessionId.trim().length > 0 &&
      previousOrchestratorSessionId !== replacementOrchestratorThread.id
    ) {
      try {
        await hardDeleteSession(previousOrchestratorSessionId);
      } catch (error) {
        const detached = setSessionProjectAssignment(previousOrchestratorSessionId, null);
        if (detached) {
          await persistSessionMetadata();
          publishToSockets(
            "session_project_updated",
            {
              sessionId: previousOrchestratorSessionId,
              projectId: null
            },
            previousOrchestratorSessionId,
            { broadcastToAll: true }
          );
        }
        app.log.warn(
          { error, projectId: params.projectId, sessionId: previousOrchestratorSessionId, detached },
          "failed to cleanup previous project orchestration session after working directory update; detached assignment fallback applied"
        );
      }
    }
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

  const orchestrationSessionId = sessionMetadata.projectOrchestratorSessionById[params.projectId] ?? null;
  const blockingSessionIds = orchestrationSessionId
    ? existingSessionIds.filter((sessionId) => sessionId !== orchestrationSessionId)
    : existingSessionIds;

  if (blockingSessionIds.length > 0) {
    reply.code(409);
    return {
      status: "project_not_empty",
      projectId: params.projectId,
      sessionCount: blockingSessionIds.length
    };
  }

  if (orchestrationSessionId) {
    const outcome = await hardDeleteSession(orchestrationSessionId);
    if (outcome.status === "not_found") {
      setSessionProjectAssignment(orchestrationSessionId, null);
      setSessionTitleOverride(orchestrationSessionId, null);
    }
  }

  delete sessionMetadata.projects[params.projectId];
  delete sessionMetadata.projectOrchestratorSessionById[params.projectId];
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
        await supervisor.call("thread/archive", {
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
  await cleanupSuggestionHelperSessions();
  await ensureProjectOrchestrationSessions();
  const query = listSessionsQuerySchema.parse(request.query);
  const archived = query.archived === "true";
  const cursor = query.cursor;
  const limit = query.limit ?? 100;

  const response = await supervisor.call<{ data: Array<CodexThread>; nextCursor: string | null }>("thread/list", {
    limit,
    archived,
    cursor
  });

  const threads = response.data.filter(
    (thread) => !isSessionPurged(thread.id) && !isSuggestionHelperSession(thread.id) && !isSystemOwnedSession(thread.id)
  );
  const materializedByThreadId = new Map<string, boolean>();
  for (const thread of threads) {
    materializedByThreadId.set(thread.id, true);
  }

  if (!archived && !cursor) {
    try {
      const loaded = await supervisor.call<{ data: Array<string> }>("thread/loaded/list", {});
      const existingIds = new Set(threads.map((thread) => thread.id));
      const missingThreadIds = loaded.data.filter(
        (threadId) =>
          !existingIds.has(threadId) &&
          !isSessionPurged(threadId) &&
          !isSuggestionHelperSession(threadId) &&
          !isSystemOwnedSession(threadId)
      );

      if (missingThreadIds.length > 0) {
        const loadedThreads = await Promise.all(
          missingThreadIds.map(async (threadId) => {
            try {
              const readWithTurns = await supervisor.call<{ thread: CodexThread }>("thread/read", {
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

              const readWithoutTurns = await supervisor.call<{ thread: CodexThread }>("thread/read", {
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

  if (isSystemOwnedSession(params.sessionId)) {
    reply.code(403);
    return systemSessionPayload(params.sessionId);
  }

  let response: { thread: CodexThread };
  let transcript: Array<TranscriptEntry> = [];
  let materialized = true;

  try {
    response = await supervisor.call<{ thread: CodexThread }>("thread/read", {
      threadId: params.sessionId,
      includeTurns: true
    });
    transcript = turnsToTranscript(params.sessionId, Array.isArray(response.thread.turns) ? response.thread.turns : []);
  } catch (error) {
    if (!isIncludeTurnsUnavailableError(error)) {
      throw error;
    }

    response = await supervisor.call<{ thread: CodexThread }>("thread/read", {
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
    const response = await supervisor.call("thread/compact/start", {
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
    const response = await supervisor.call("thread/rollback", {
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
    const response = await supervisor.call("thread/backgroundTerminals/clean", {
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
    const response = await supervisor.call("review/start", {
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

  try {
    const response = await supervisor.call("turn/steer", {
      threadId: params.sessionId,
      expectedTurnId: params.turnId,
      input: [
        {
          type: "text",
          text: body.input,
          text_elements: []
        }
      ]
    });
    return {
      status: "ok",
      sessionId: params.sessionId,
      turnId: params.turnId,
      result: response
    };
  } catch (error) {
    return sendMappedCodexError(reply, error, "failed to steer active turn", {
      method: "turn/steer",
      sessionId: params.sessionId,
      turnId: params.turnId
    });
  }
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
    response = await supervisor.call<{ thread: CodexThread }>("thread/read", {
      threadId: params.sessionId,
      includeTurns: true
    });
  } catch (error) {
    if (!isIncludeTurnsUnavailableError(error)) {
      throw error;
    }

    response = await supervisor.call<{ thread: CodexThread }>("thread/read", {
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
    await supervisor.call("thread/archive", {
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

  const response = await supervisor.call<{ thread: CodexThread }>("thread/unarchive", {
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

  return {
    data: listPendingApprovalsByThread(params.sessionId)
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

app.post("/api/sessions/:sessionId/suggested-reply/jobs", async (request, reply) => {
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

  const body = suggestedReplyBodySchema.parse(request.body);
  const projectId = suggestionQueueProjectId(params.sessionId);
  const requestKey = randomUUID();

  try {
    const queued = await queue.enqueue({
      type: "suggest_reply",
      projectId,
      sourceSessionId: params.sessionId,
      payload: {
        sessionId: params.sessionId,
        projectId,
        requestKey,
        model: body?.model,
        effort: body?.effort,
        draft: body?.draft
      }
    });

    reply.code(202);
    return {
      status: "queued",
      jobId: queued.job.id,
      sessionId: params.sessionId,
      projectId,
      dedupe: queued.status === "already_queued" ? "already_queued" : "enqueued"
    };
  } catch (error) {
    return sendOrchestratorQueueError(reply, error, params.sessionId);
  }
});

app.post("/api/sessions/:sessionId/suggested-reply", async (request, reply) => {
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

  const body = suggestedReplyBodySchema.parse(request.body);
  const projectId = suggestionQueueProjectId(params.sessionId);
  const requestKey = randomUUID();

  let queued;
  try {
    queued = await queue.enqueue({
      type: "suggest_reply",
      projectId,
      sourceSessionId: params.sessionId,
      payload: {
        sessionId: params.sessionId,
        projectId,
        requestKey,
        model: body?.model,
        effort: body?.effort,
        draft: body?.draft
      }
    });
  } catch (error) {
    return sendOrchestratorQueueError(reply, error, params.sessionId);
  }

  const terminal = await queue.waitForTerminal(queued.job.id, env.ORCHESTRATOR_SUGGEST_REPLY_WAIT_MS);
  if (!terminal) {
    reply.code(202);
    return {
      status: "queued",
      jobId: queued.job.id,
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
        suggestion
      };
    }
  }

  if (terminal.state === "failed" && typeof terminal.error === "string" && terminal.error.includes("no_context")) {
    reply.code(409);
    return {
      status: "no_context",
      sessionId: params.sessionId,
      message: "No chat messages available to build a suggestion."
    };
  }

  const fallbackSuggestion = buildFallbackSuggestedReply([], body?.draft);
  return {
    status: "fallback",
    sessionId: params.sessionId,
    suggestion: fallbackSuggestion
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
    supervisor.call<{ turn: { id: string } }>("turn/start", {
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

  await supervisor.call("turn/interrupt", {
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
    await supervisor.respond(pending.rpcId, toolUserInputResponsePayload(body));
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
    const payload = approvalDecisionPayload(approval, body.decision, body.scope ?? "turn");
    await supervisor.respond(approval.rpcId, payload);

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
  suggestionThreadBySession.clear();
  suggestionThreadIds.clear();
  pendingApprovals.clear();
  pendingToolUserInputs.clear();
  if (orchestratorQueue) {
    await orchestratorQueue.stop({ drainMs: 2_000 });
  }
  await supervisor.stop();
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

await supervisor.start();
try {
  const prunedControlEntries = await pruneStaleSessionControlMetadata();
  if (prunedControlEntries > 0) {
    app.log.info({ prunedControlEntries }, "pruned stale session-control metadata entries");
  }
  await cleanupSuggestionHelperSessions();
  await ensureProjectOrchestrationSessions();
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
