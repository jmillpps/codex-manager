import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { FastifyBaseLogger } from "fastify";

type JsonRpcId = number | string;

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

type JsonRpcServerRequest = {
  method: string;
  id: JsonRpcId;
  params?: unknown;
};

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export type CodexSupervisorOptions = {
  bin: string;
  codeHome?: string;
  dataDir: string;
  cwd: string;
  logger: FastifyBaseLogger;
};

export type CodexStatus = {
  running: boolean;
  pid: number | null;
  initialized: boolean;
  lastExit?: {
    code: number | null;
    signal: NodeJS.Signals | null;
    at: string;
  };
};

export class CodexSupervisor extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private codexLogStream: WriteStream | undefined;
  private lastExit: { code: number | null; signal: NodeJS.Signals | null; at: string } | undefined;
  private pendingRequests = new Map<string, PendingRequest>();
  private nextRequestId = 1;
  private stdoutLineBuffer = "";
  private initialized = false;

  constructor(private readonly options: CodexSupervisorOptions) {
    super();
  }

  public async start(): Promise<void> {
    if (this.child && !this.child.killed) {
      return;
    }

    await mkdir(path.join(this.options.dataDir, "logs"), { recursive: true });
    if (this.options.codeHome) {
      await mkdir(this.options.codeHome, { recursive: true });
    }
    const codexLogPath = path.join(this.options.dataDir, "logs", "codex.log");
    this.codexLogStream = createWriteStream(codexLogPath, { flags: "a" });

    const child = spawn(this.options.bin, ["app-server"], {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...(this.options.codeHome ? { CODEX_HOME: this.options.codeHome } : {})
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    child.on("error", (error) => {
      this.options.logger.error({ error }, "codex app-server process failed");
    });

    child.on("exit", (code, signal) => {
      this.lastExit = {
        code,
        signal,
        at: new Date().toISOString()
      };
      this.initialized = false;
      this.child = undefined;
      this.rejectAllPending(new Error("codex app-server exited before responding"));
      this.options.logger.warn({ code, signal }, "codex app-server exited");
    });

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.appendCodexLog(text);
      this.handleStdoutText(text);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      this.appendCodexLog(chunk.toString("utf8"));
    });

    this.child = child;
    this.stdoutLineBuffer = "";
    this.options.logger.info({ pid: child.pid }, "codex app-server started");

    try {
      await this.call("initialize", {
        clientInfo: {
          name: "codex_manager_api",
          title: "Codex Manager API",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: false
        }
      });
      await this.notify("initialized");
      this.initialized = true;
    } catch (error) {
      this.options.logger.error({ error }, "failed to initialize codex app-server");
      await this.stop();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.initialized = false;
    this.rejectAllPending(new Error("codex app-server stopped"));

    if (!this.child) {
      this.codexLogStream?.end();
      this.codexLogStream = undefined;
      return;
    }

    const child = this.child;
    child.kill("SIGTERM");

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, 3_000);

    await once(child, "exit").catch(() => {
      this.options.logger.warn("failed to observe codex app-server exit event");
    });

    clearTimeout(timeout);
    this.child = undefined;
    this.codexLogStream?.end();
    this.codexLogStream = undefined;
  }

  public status(): CodexStatus {
    return {
      running: Boolean(this.child && !this.child.killed),
      pid: this.child?.pid ?? null,
      initialized: this.initialized,
      ...(this.lastExit ? { lastExit: this.lastExit } : {})
    };
  }

  public async call<T>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    if (!this.child || this.child.killed) {
      throw new Error("codex app-server is not running");
    }

    const id = this.nextRequestId++;
    const key = String(id);

    const resultPromise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(key);
        reject(new Error(`codex request timed out: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(key, {
        resolve: (result: unknown) => resolve(result as T),
        reject,
        timeout
      });
    });

    const request: { method: string; id: JsonRpcId; params?: unknown } = { method, id };
    if (params !== undefined) {
      request.params = params;
    }

    try {
      await this.writeMessage(request);
    } catch (error) {
      const pending = this.pendingRequests.get(key);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(key);
        pending.reject(error instanceof Error ? error : new Error("request write failed"));
      }
    }

    return resultPromise;
  }

  public async notify(method: string, params?: unknown): Promise<void> {
    const notification: { method: string; params?: unknown } = { method };
    if (params !== undefined) {
      notification.params = params;
    }
    await this.writeMessage(notification);
  }

  public async respond(id: JsonRpcId, result: unknown): Promise<void> {
    await this.writeMessage({ id, result });
  }

  public async respondError(id: JsonRpcId, error: JsonRpcError): Promise<void> {
    await this.writeMessage({ id, error });
  }

  private appendCodexLog(line: string): void {
    this.codexLogStream?.write(line);
  }

  private rejectAllPending(error: Error): void {
    for (const [key, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(key);
      pending.reject(error);
    }
  }

  private async writeMessage(message: unknown): Promise<void> {
    if (!this.child || this.child.killed) {
      throw new Error("codex app-server is not running");
    }

    const serialized = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.child?.stdin.write(serialized, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private handleStdoutText(text: string): void {
    this.stdoutLineBuffer += text;
    let newlineIndex = this.stdoutLineBuffer.indexOf("\n");

    while (newlineIndex >= 0) {
      const rawLine = this.stdoutLineBuffer.slice(0, newlineIndex).trim();
      this.stdoutLineBuffer = this.stdoutLineBuffer.slice(newlineIndex + 1);

      if (rawLine.length > 0) {
        this.handleMessageLine(rawLine);
      }

      newlineIndex = this.stdoutLineBuffer.indexOf("\n");
    }
  }

  private handleMessageLine(rawLine: string): void {
    let parsed: unknown;

    try {
      parsed = JSON.parse(rawLine) as unknown;
    } catch {
      this.options.logger.warn({ line: rawLine }, "failed to parse codex message line");
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      return;
    }

    const message = parsed as Record<string, unknown>;
    const maybeMethod = message.method;
    const maybeId = message.id;
    const hasId = typeof maybeId === "number" || typeof maybeId === "string";
    const hasMethod = typeof maybeMethod === "string";

    if (hasMethod && hasId) {
      this.emit("serverRequest", {
        method: maybeMethod,
        id: maybeId,
        params: message.params
      } satisfies JsonRpcServerRequest);
      return;
    }

    if (hasMethod) {
      this.emit("notification", {
        method: maybeMethod,
        params: message.params
      } satisfies JsonRpcNotification);
      return;
    }

    if (hasId) {
      this.handleResponse(message);
    }
  }

  private handleResponse(response: Record<string, unknown>): void {
    const id = response.id;
    if (typeof id !== "string" && typeof id !== "number") {
      return;
    }

    const key = String(id);
    const pending = this.pendingRequests.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(key);

    if (response.error && typeof response.error === "object") {
      const rpcError = response.error as Partial<JsonRpcError>;
      const code = typeof rpcError.code === "number" ? rpcError.code : -1;
      const message = typeof rpcError.message === "string" ? rpcError.message : "unknown error";
      pending.reject(new Error(`codex rpc error ${code}: ${message}`));
      return;
    }

    pending.resolve(response.result);
  }
}
