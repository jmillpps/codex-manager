import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { OrchestratorJob, OrchestratorQueueLogger, OrchestratorQueueSnapshot, OrchestratorQueueStore } from "./orchestrator-types.js";

const runningContextSchema = z.object({
  threadId: z.string().min(1).nullable(),
  turnId: z.string().min(1).nullable()
});

const orchestratorJobSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  version: z.number().int().positive(),
  projectId: z.string().min(1),
  sourceSessionId: z.string().min(1).nullable(),
  priority: z.enum(["interactive", "background"]),
  state: z.enum(["queued", "running", "completed", "failed", "canceled"]),
  dedupeKey: z.string().min(1).nullable(),
  payload: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  createdAt: z.string().min(1),
  startedAt: z.string().min(1).nullable(),
  completedAt: z.string().min(1).nullable(),
  cancelRequestedAt: z.string().min(1).nullable(),
  nextAttemptAt: z.string().min(1).nullable(),
  lastAttemptAt: z.string().min(1).nullable(),
  runningContext: runningContextSchema
});

const snapshotSchema = z.object({
  version: z.literal(1),
  jobs: z.array(orchestratorJobSchema)
});

function defaultSnapshot(): OrchestratorQueueSnapshot {
  return {
    version: 1,
    jobs: []
  };
}

async function fsyncDirectory(targetPath: string): Promise<void> {
  const directory = path.dirname(targetPath);
  let directoryHandle: Awaited<ReturnType<typeof open>> | null = null;

  try {
    directoryHandle = await open(directory, "r");
    await directoryHandle.sync();
  } catch {
    // Best effort only; some filesystems do not support directory fsync.
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}

function normalizeSnapshot(parsed: unknown): OrchestratorQueueSnapshot {
  const normalized = snapshotSchema.parse(parsed);
  const byId = new Map<string, OrchestratorJob>();

  for (const job of normalized.jobs) {
    byId.set(job.id, job);
  }

  return {
    version: 1,
    jobs: Array.from(byId.values())
  };
}

export class FileOrchestratorQueueStore implements OrchestratorQueueStore {
  constructor(
    private readonly filePath: string,
    private readonly logger: OrchestratorQueueLogger | null
  ) {}

  public async load(): Promise<OrchestratorQueueSnapshot> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return normalizeSnapshot(parsed);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return defaultSnapshot();
      }

      await this.quarantineCorruptFile(error);
      return defaultSnapshot();
    }
  }

  public async save(snapshot: OrchestratorQueueSnapshot): Promise<void> {
    const normalized = normalizeSnapshot(snapshot);
    await mkdir(path.dirname(this.filePath), { recursive: true });

    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    const serialized = `${JSON.stringify(normalized, null, 2)}\n`;

    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(tempPath, "w");
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle?.close().catch(() => undefined);
    }

    await rename(tempPath, this.filePath);
    await fsyncDirectory(this.filePath);
  }

  private async quarantineCorruptFile(error: unknown): Promise<void> {
    try {
      const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await rename(this.filePath, corruptPath);
      this.logger?.warn(
        {
          error,
          filePath: this.filePath,
          corruptPath
        },
        "orchestrator queue store corrupted; quarantined original file"
      );
      return;
    } catch {
      // Fall through and overwrite with an empty snapshot to recover startup.
    }

    try {
      await writeFile(this.filePath, `${JSON.stringify(defaultSnapshot(), null, 2)}\n`, "utf8");
    } catch {
      // Ignore secondary recovery failures.
    }

    this.logger?.warn(
      {
        error,
        filePath: this.filePath
      },
      "orchestrator queue store corrupted and could not be quarantined"
    );
  }
}
