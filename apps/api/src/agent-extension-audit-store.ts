import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type AgentExtensionReloadAuditResult = "success" | "failed" | "forbidden";

export type AgentExtensionReloadAuditRecord = {
  reloadId: string;
  recordedAt: string;
  actorRole: string;
  actorId: string | null;
  requestOrigin: {
    ip: string | null;
    userAgent: string | null;
  };
  result: AgentExtensionReloadAuditResult;
  snapshotBefore: string;
  snapshotAfter: string | null;
  trustMode: "disabled" | "warn" | "enforced";
  errorSummary: string | null;
  impactedExtensions: Array<string>;
};

type AgentExtensionAuditFile = {
  version: 1;
  records: Array<AgentExtensionReloadAuditRecord>;
};

export class AgentExtensionAuditStore {
  private readonly filePath: string;
  private readonly logger: {
    warn: (input: Record<string, unknown>, message?: string) => void;
  };
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(input: {
    dataDir: string;
    logger: {
      warn: (input: Record<string, unknown>, message?: string) => void;
    };
  }) {
    this.filePath = path.join(input.dataDir, "agent-extension-audit.json");
    this.logger = input.logger;
  }

  public get path(): string {
    return this.filePath;
  }

  public async append(record: AgentExtensionReloadAuditRecord): Promise<void> {
    const runAppend = async (): Promise<void> => {
      const state = await this.read();
      state.records.push(record);
      await this.write(state);
    };

    const queued = this.appendQueue.then(runAppend, runAppend);
    this.appendQueue = queued.then(
      () => undefined,
      () => undefined
    );
    await queued;
  }

  public async list(): Promise<Array<AgentExtensionReloadAuditRecord>> {
    await this.appendQueue;
    const state = await this.read();
    return [...state.records];
  }

  private async read(): Promise<AgentExtensionAuditFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as { version?: number }).version === 1 &&
        Array.isArray((parsed as { records?: unknown }).records)
      ) {
        return parsed as AgentExtensionAuditFile;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
        this.logger.warn({ error, filePath: this.filePath }, "failed to read extension audit store; using empty state");
      }
    }

    return {
      version: 1,
      records: []
    };
  }

  private async write(state: AgentExtensionAuditFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}
