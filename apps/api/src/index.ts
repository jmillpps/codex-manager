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
};

type CodexThreadItem = { type: string; id: string; [key: string]: unknown };

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

type ProjectRecord = {
  name: string;
  createdAt: string;
  updatedAt: string;
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

type ApprovalDecisionInput = "accept" | "decline" | "cancel";
type DefaultSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type AuthStatus = {
  hasOpenAiApiKey: boolean;
  codexHomeAuthFile: boolean;
  likelyUnauthenticated: boolean;
};

type SessionMetadataStore = {
  titles: Record<string, string>;
  projects: Record<string, ProjectRecord>;
  sessionProjectById: Record<string, string>;
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
    model: z.string().min(1).optional()
  })
  .optional();

const sendMessageBodySchema = z.object({
  text: z.string().trim().min(1),
  model: z.string().min(1).optional()
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

const interruptBodySchema = z
  .object({
    turnId: z.string().min(1).optional()
  })
  .optional();

const renameSessionBodySchema = z.object({
  title: z.string().trim().min(1).max(200)
});

const upsertProjectBodySchema = z.object({
  name: z.string().trim().min(1).max(120)
});

const setSessionProjectBodySchema = z.object({
  projectId: z.string().trim().min(1).max(200).nullable()
});

const moveProjectChatsBodySchema = z.object({
  destination: z.enum(["unassigned", "archive"])
});

const approvalDecisionBodySchema = z.object({
  decision: z.enum(["accept", "decline", "cancel"]),
  scope: z.enum(["turn", "session"]).optional()
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
const pendingApprovals = new Map<string, PendingApprovalRecord>();
const purgedSessionIds = new Set<string>();
const sockets = new Set<WebSocketLike>();
const socketThreadFilter = new Map<WebSocketLike, string | null>();
const codexHomeAuthFilePath = env.CODEX_HOME ? path.join(env.CODEX_HOME, "auth.json") : null;
const sessionMetadataPath = path.join(env.DATA_DIR, "session-metadata.json");
const sessionMetadata = await loadSessionMetadata();
const deletedSessionMessage = "This chat was permanently deleted and is no longer available.";

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

async function loadSessionMetadata(): Promise<SessionMetadataStore> {
  try {
    const raw = await readFile(sessionMetadataPath, "utf8");
    const parsed = JSON.parse(raw);
    const titles: Record<string, string> = {};
    const projects: Record<string, ProjectRecord> = {};
    const sessionProjectById: Record<string, string> = {};
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

    return {
      titles,
      projects,
      sessionProjectById
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      app.log.warn({ error }, "failed to load session metadata");
    }
    return {
      titles: {},
      projects: {},
      sessionProjectById: {}
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

function toProjectSummary(projectId: string, project: ProjectRecord): ProjectSummary {
  return {
    projectId,
    name: project.name,
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

function setSessionProjectAssignment(sessionId: string, nextProjectId: string | null): boolean {
  const currentProjectId = resolveSessionProjectId(sessionId);
  if (nextProjectId === null) {
    if (sessionId in sessionMetadata.sessionProjectById) {
      delete sessionMetadata.sessionProjectById[sessionId];
      return true;
    }
    return false;
  }

  if (currentProjectId === nextProjectId) {
    return false;
  }

  sessionMetadata.sessionProjectById[sessionId] = nextProjectId;
  return true;
}

function listSessionIdsForProject(projectId: string): Array<string> {
  const sessionIds: Array<string> = [];
  for (const [sessionId, assignedProjectId] of Object.entries(sessionMetadata.sessionProjectById)) {
    if (assignedProjectId === projectId) {
      sessionIds.push(sessionId);
    }
  }
  return sessionIds;
}

function resolveSessionTitle(thread: CodexThread): string {
  const maybeNamedThread = thread as CodexThread & { threadName?: unknown; name?: unknown };
  if (typeof maybeNamedThread.threadName === "string" && maybeNamedThread.threadName.trim().length > 0) {
    return maybeNamedThread.threadName.trim();
  }

  if (typeof maybeNamedThread.name === "string" && maybeNamedThread.name.trim().length > 0) {
    return maybeNamedThread.name.trim();
  }

  const storedTitle = sessionMetadata.titles[thread.id];
  if (typeof storedTitle === "string" && storedTitle.trim().length > 0) {
    return storedTitle.trim();
  }

  return thread.preview?.trim() || "New chat";
}

function toSessionSummary(thread: CodexThread, materialized = true): SessionSummary {
  return {
    sessionId: thread.id,
    title: resolveSessionTitle(thread),
    materialized,
    modelProvider: thread.modelProvider,
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

function itemToTranscriptEntry(turnId: string, item: CodexThreadItem): TranscriptEntry {
  if (item.type === "userMessage") {
    const contentItems = Array.isArray(item.content)
      ? (item.content as Array<{ type?: unknown; text?: unknown; url?: unknown; path?: unknown }>)
      : [];

    return {
      messageId: item.id,
      turnId,
      role: "user",
      type: item.type,
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
    content: systemSummary.summary,
    details: systemSummary.details,
    status: "complete"
  };
}

function turnsToTranscript(turns: Array<CodexTurn>): Array<TranscriptEntry> {
  const entries: Array<TranscriptEntry> = [];

  for (const turn of turns) {
    for (const item of turn.items) {
      entries.push(itemToTranscriptEntry(turn.id, item));
    }
  }

  return entries;
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

  return typeof params.turnId === "string" ? params.turnId : null;
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

function isSessionPurged(sessionId: string): boolean {
  return purgedSessionIds.has(sessionId);
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

async function hardDeleteSession(sessionId: string): Promise<HardDeleteSessionOutcome> {
  if (isSessionPurged(sessionId)) {
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
    activeTurnByThread.has(sessionId) || hasPendingApprovalsForThread(sessionId) || sessionReadSucceeded || knownPath !== null;
  if (!existsInMemory && deletedPaths.length === 0) {
    return {
      status: "not_found",
      sessionId
    };
  }

  if (!knownTitle) {
    knownTitle = await resolveKnownSessionTitle(sessionId);
  }

  activeTurnByThread.delete(sessionId);
  clearPendingApprovalsForThread(sessionId);
  purgedSessionIds.add(sessionId);

  const titleMetadataChanged = setSessionTitleOverride(sessionId, null);
  const projectMetadataChanged = setSessionProjectAssignment(sessionId, null);
  if (titleMetadataChanged || projectMetadataChanged) {
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

function toTurnSandboxPolicy(mode: DefaultSandboxMode): { type: "readOnly" | "workspaceWrite" | "dangerFullAccess" } {
  if (mode === "read-only") {
    return { type: "readOnly" };
  }

  if (mode === "workspace-write") {
    return { type: "workspaceWrite" };
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
  if (threadId && isSessionPurged(threadId)) {
    return;
  }

  if (notification.method === "thread/name/updated") {
    const params = notification.params as { threadId?: unknown; threadName?: unknown } | undefined;
    if (typeof params?.threadId === "string") {
      if (setSessionTitleOverride(params.threadId, typeof params.threadName === "string" ? params.threadName : null)) {
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
    }
  }

  if (notification.method === "turn/completed") {
    const params = notification.params as { threadId?: unknown; turn?: { id?: unknown } } | undefined;
    if (typeof params?.threadId === "string") {
      activeTurnByThread.delete(params.threadId);

      if (typeof params.turn?.id === "string") {
        clearPendingApprovalsForTurn(params.threadId, params.turn.id);
      }
    }
  }

  publishToSockets("notification", notification, threadId);
});

supervisor.on("serverRequest", (serverRequest: JsonRpcServerRequest) => {
  const requestThreadId = extractThreadId(serverRequest.params);
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
    publishToSockets("approval", toPublicApproval(approval), approval.threadId);
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
  return {
    status: "ok",
    service: "api",
    codex: supervisor.status(),
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

app.get("/api/projects", async () => {
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
    createdAt: now,
    updatedAt: now
  };
  sessionMetadata.projects[projectId] = project;
  await persistSessionMetadata();

  const payload = toProjectSummary(projectId, project);
  publishToSockets("project_upserted", { project: payload }, undefined, { broadcastToAll: true });
  return {
    status: "ok",
    project: payload
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
  if (current.name !== nextName) {
    current.name = nextName;
    current.updatedAt = new Date().toISOString();
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

  const projectSessionIds = listSessionIdsForProject(params.projectId);
  if (projectSessionIds.length > 0) {
    reply.code(409);
    return {
      status: "project_not_empty",
      projectId: params.projectId,
      sessionCount: projectSessionIds.length
    };
  }

  delete sessionMetadata.projects[params.projectId];
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
  const query = listSessionsQuerySchema.parse(request.query);
  const archived = query.archived === "true";
  const cursor = query.cursor;
  const limit = query.limit ?? 100;

  const response = await supervisor.call<{ data: Array<CodexThread>; nextCursor: string | null }>("thread/list", {
    limit,
    archived,
    cursor
  });

  const threads = response.data.filter((thread) => !isSessionPurged(thread.id));
  const materializedByThreadId = new Map<string, boolean>();
  for (const thread of threads) {
    materializedByThreadId.set(thread.id, true);
  }

  if (!archived && !cursor) {
    try {
      const loaded = await supervisor.call<{ data: Array<string> }>("thread/loaded/list", {});
      const existingIds = new Set(threads.map((thread) => thread.id));
      const missingThreadIds = loaded.data.filter((threadId) => !existingIds.has(threadId) && !isSessionPurged(threadId));

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

  const response = await supervisor.call<{
    thread: CodexThread;
  }>("thread/start", {
    cwd: body?.cwd ?? env.WORKSPACE_ROOT,
    model: body?.model,
    sandbox: env.DEFAULT_SANDBOX_MODE,
    approvalPolicy: env.DEFAULT_APPROVAL_POLICY,
    experimentalRawEvents: false
  });

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
    response = await supervisor.call<{ thread: CodexThread }>("thread/read", {
      threadId: params.sessionId,
      includeTurns: true
    });
    transcript = turnsToTranscript(Array.isArray(response.thread.turns) ? response.thread.turns : []);
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

  return {
    session: toSessionSummary(response.thread, materialized),
    thread: response.thread,
    transcript
  };
});

app.post("/api/sessions/:sessionId/rename", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }
  const body = renameSessionBodySchema.parse(request.body);

  await supervisor.call("thread/name/set", {
    threadId: params.sessionId,
    name: body.title
  });

  if (setSessionTitleOverride(params.sessionId, body.title)) {
    await persistSessionMetadata();
  }

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

  return {
    data: listPendingApprovalsByThread(params.sessionId)
  };
});

app.post("/api/sessions/:sessionId/resume", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }

  const response = await supervisor.call<{ thread: CodexThread }>("thread/resume", {
    threadId: params.sessionId,
    sandbox: env.DEFAULT_SANDBOX_MODE,
    approvalPolicy: env.DEFAULT_APPROVAL_POLICY
  });

  return {
    session: toSessionSummary(response.thread, true),
    thread: response.thread
  };
});

app.post("/api/sessions/:sessionId/messages", async (request, reply) => {
  const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
  if (isSessionPurged(params.sessionId)) {
    reply.code(410);
    return deletedSessionPayload(params.sessionId, sessionMetadata.titles[params.sessionId]);
  }
  const body = sendMessageBodySchema.parse(request.body);

  const turn = await supervisor.call<{ turn: { id: string } }>("turn/start", {
    threadId: params.sessionId,
    model: body.model,
    sandboxPolicy: toTurnSandboxPolicy(env.DEFAULT_SANDBOX_MODE),
    approvalPolicy: env.DEFAULT_APPROVAL_POLICY,
    input: [
      {
        type: "text",
        text: body.text,
        text_elements: []
      }
    ]
  });

  activeTurnByThread.set(params.sessionId, turn.turn.id);

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
  pendingApprovals.clear();
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
