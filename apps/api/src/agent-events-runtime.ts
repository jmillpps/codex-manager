import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { EnqueueJobInput, EnqueueJobResult } from "./orchestrator-types.js";

export type AgentRuntimeLogger = {
  debug: (input: Record<string, unknown>, message?: string) => void;
  info: (input: Record<string, unknown>, message?: string) => void;
  warn: (input: Record<string, unknown>, message?: string) => void;
  error: (input: Record<string, unknown>, message?: string) => void;
};

export type AgentRuntimeEvent = {
  type: string;
  payload: Record<string, unknown>;
};

export type AgentRuntimeTools = {
  enqueueJob: (input: EnqueueJobInput) => Promise<EnqueueJobResult>;
  logger: AgentRuntimeLogger;
};

export type AgentEventHandler = (event: AgentRuntimeEvent, tools: AgentRuntimeTools) => Promise<unknown> | unknown;

type AgentEventRegistration = {
  on: (eventType: string, handler: AgentEventHandler) => void;
};

type RegisteredHandler = {
  moduleName: string;
  handler: AgentEventHandler;
};

type AgentEventsRuntimeOptions = {
  agentsRoot: string;
  logger: AgentRuntimeLogger;
};

type AgentModuleNamespace = {
  registerAgentEvents?: (registration: AgentEventRegistration) => void;
  default?: {
    registerAgentEvents?: (registration: AgentEventRegistration) => void;
  } | ((registration: AgentEventRegistration) => void);
};

function resolveRegisterFunction(namespace: AgentModuleNamespace): ((registration: AgentEventRegistration) => void) | null {
  if (typeof namespace.registerAgentEvents === "function") {
    return namespace.registerAgentEvents;
  }

  if (typeof namespace.default === "function") {
    return namespace.default;
  }

  if (namespace.default && typeof namespace.default === "object" && typeof namespace.default.registerAgentEvents === "function") {
    return namespace.default.registerAgentEvents;
  }

  return null;
}

export class AgentEventsRuntime {
  private readonly agentsRoot: string;
  private readonly logger: AgentRuntimeLogger;
  private readonly handlersByEventType = new Map<string, Array<RegisteredHandler>>();
  private loaded = false;

  constructor(options: AgentEventsRuntimeOptions) {
    this.agentsRoot = options.agentsRoot;
    this.logger = options.logger;
  }

  public async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    if (!existsSync(this.agentsRoot)) {
      this.loaded = true;
      this.logger.info(
        {
          agentsRoot: this.agentsRoot
        },
        "agents runtime root not found; skipping dynamic agent event module load"
      );
      return;
    }

    const dirEntries = await readdir(this.agentsRoot, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name === "lib" || entry.name === "runtime" || entry.name.startsWith(".")) {
        continue;
      }

      const moduleBase = path.join(this.agentsRoot, entry.name);
      const eventModulePath = this.resolveEventModulePath(moduleBase);
      if (!eventModulePath) {
        continue;
      }

      await this.loadSingleModule(entry.name, eventModulePath);
    }

    this.loaded = true;
  }

  public async emit(event: AgentRuntimeEvent, tools: AgentRuntimeTools): Promise<Array<unknown>> {
    if (!this.loaded) {
      await this.load();
    }

    const handlers = this.handlersByEventType.get(event.type) ?? [];
    if (handlers.length === 0) {
      return [];
    }

    const results: Array<unknown> = [];
    for (const registration of handlers) {
      try {
        results.push(await registration.handler(event, tools));
      } catch (error) {
        this.logger.warn(
          {
            error,
            eventType: event.type,
            moduleName: registration.moduleName
          },
          "agent event handler failed; continuing with remaining handlers"
        );
        results.push({
          status: "handler_error",
          moduleName: registration.moduleName,
          eventType: event.type,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return results;
  }

  private resolveEventModulePath(moduleBase: string): string | null {
    const candidates = ["events.js", "events.mjs", "events.ts"];
    for (const candidate of candidates) {
      const resolved = path.join(moduleBase, candidate);
      if (existsSync(resolved)) {
        return resolved;
      }
    }
    return null;
  }

  private async loadSingleModule(moduleName: string, eventModulePath: string): Promise<void> {
    const moduleUrl = pathToFileURL(eventModulePath).href;
    let namespace: AgentModuleNamespace;
    try {
      namespace = (await import(moduleUrl)) as AgentModuleNamespace;
    } catch (error) {
      this.logger.warn(
        {
          error,
          moduleName,
          eventModulePath
        },
        "failed to load agent events module"
      );
      return;
    }

    const register = resolveRegisterFunction(namespace);
    if (!register) {
      this.logger.warn(
        {
          moduleName,
          eventModulePath
        },
        "agent events module has no registerAgentEvents export; skipping"
      );
      return;
    }

    const registration: AgentEventRegistration = {
      on: (eventType: string, handler: AgentEventHandler) => {
        if (typeof eventType !== "string" || eventType.trim().length === 0) {
          return;
        }
        const normalizedEventType = eventType.trim();
        const current = this.handlersByEventType.get(normalizedEventType) ?? [];
        current.push({
          moduleName,
          handler
        });
        this.handlersByEventType.set(normalizedEventType, current);
      }
    };

    try {
      register(registration);
      this.logger.info(
        {
          moduleName,
          eventModulePath
        },
        "loaded agent events module"
      );
    } catch (error) {
      this.logger.warn(
        {
          error,
          moduleName,
          eventModulePath
        },
        "failed during agent events module registration"
      );
    }
  }
}
