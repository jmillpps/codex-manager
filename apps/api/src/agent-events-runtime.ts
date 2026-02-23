import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  isAgentRuntimeActionRequest,
  selectActionExecutionPlan,
  selectEnqueueWinner,
  toAgentEventEmitResult,
  toAgentEventHandlerError,
  type AgentEventActionResult,
  type AgentRuntimeActionExecutor,
  type AgentEventEmitResult,
  type AgentEventHandler,
  type AgentEventRegistry,
  type AgentRuntimeEvent,
  type AgentRuntimeLogger,
  type AgentRuntimeTools
} from "@codex-manager/agent-runtime-sdk";
import {
  evaluateCompatibility,
  readExtensionManifest,
  resolveEventsEntrypoint,
  type AgentExtensionOrigin,
  type AgentExtensionOriginType,
  type AgentRuntimeCompatibilityInput,
  type LoadedAgentExtensionInventory
} from "./agent-extension-inventory.js";
import {
  evaluateActionCapability,
  evaluateExtensionTrust,
  type AgentExtensionCapabilityDeclaration,
  type AgentExtensionTrustMode
} from "./agent-extension-trust.js";

export type { AgentRuntimeEvent, AgentRuntimeTools, AgentRuntimeLogger, AgentEventHandler, AgentEventEmitResult };

type RegisteredHandler = {
  moduleName: string;
  extensionName: string;
  handler: AgentEventHandler;
  priority: number;
  registrationIndex: number;
  timeoutMs: number;
  declaredCapabilities: AgentExtensionCapabilityDeclaration | null;
};

type AgentEventsRuntimeSnapshot = {
  snapshotVersion: string;
  loadedAt: string;
  handlersByEventType: Map<string, Array<RegisteredHandler>>;
  modules: Array<LoadedAgentExtensionInventory>;
};

export type AgentExtensionSourceRoot = {
  type: AgentExtensionOriginType;
  path: string;
};

export type AgentEventsRuntimeOptions = {
  agentsRoot: string;
  logger: AgentRuntimeLogger;
  runtimeCompatibility: AgentRuntimeCompatibilityInput;
  trustMode?: AgentExtensionTrustMode;
  extensionSources?: Array<AgentExtensionSourceRoot>;
  defaultHandlerTimeoutMs?: number;
};

type AgentModuleNamespace = {
  registerAgentEvents?: (registration: AgentEventRegistry) => void;
  default?:
    | {
        registerAgentEvents?: (registration: AgentEventRegistry) => void;
      }
    | ((registration: AgentEventRegistry) => void);
};

type RuntimeModuleLoadError = {
  extension: string;
  code:
    | "missing_entrypoint"
    | "invalid_manifest"
    | "incompatible_runtime"
    | "import_failed"
    | "missing_register"
    | "registration_failed"
    | "trust_denied"
    | "agent_id_conflict";
  message: string;
};

type RuntimeModuleCandidate = {
  moduleName: string;
  extensionRoot: string;
  origin: AgentExtensionOrigin;
};

export type AgentEventsRuntimeReloadSuccess = {
  status: "ok";
  reloadId: string;
  loadedCount: number;
  failedCount: number;
  snapshotVersion: string;
  loadedAt: string;
  modules: Array<{
    name: string;
    version: string;
    agentId: string;
    events: Array<string>;
  }>;
};

export type AgentEventsRuntimeReloadFailure = {
  status: "error";
  code: "reload_failed" | "reload_in_progress";
  reloadId: string;
  message: string;
  snapshotVersion: string;
  errors: Array<RuntimeModuleLoadError>;
};

const DEFAULT_HANDLER_PRIORITY = 100;
const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;
const SOURCE_PRECEDENCE: Record<AgentExtensionOriginType, number> = {
  repo_local: 0,
  installed_package: 1,
  configured_root: 2
};

function createEmptySnapshot(): AgentEventsRuntimeSnapshot {
  return {
    snapshotVersion: "bootstrap",
    loadedAt: new Date(0).toISOString(),
    handlersByEventType: new Map(),
    modules: []
  };
}

function resolveRegisterFunction(namespace: AgentModuleNamespace): ((registration: AgentEventRegistry) => void) | null {
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

function compareRegisteredHandlers(left: RegisteredHandler, right: RegisteredHandler): number {
  if (left.priority !== right.priority) {
    return left.priority - right.priority;
  }

  const moduleComparison = left.moduleName.localeCompare(right.moduleName);
  if (moduleComparison !== 0) {
    return moduleComparison;
  }

  return left.registrationIndex - right.registrationIndex;
}

function ensurePositiveFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

function normalizePriority(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  return DEFAULT_HANDLER_PRIORITY;
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;

  try {
    const timeoutPromise = new Promise<T>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, timeoutMs);
    });

    return await Promise.race([work, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function defaultIdentityFromCandidate(candidate: RuntimeModuleCandidate): {
  extensionName: string;
  extensionVersion: string;
  agentId: string;
  displayName: string;
} {
  return {
    extensionName: candidate.moduleName,
    extensionVersion: "0.0.0",
    agentId: candidate.moduleName,
    displayName: candidate.moduleName
  };
}

function toCapabilityDeclaration(input: { events?: Array<string>; actions?: Array<string> } | null): AgentExtensionCapabilityDeclaration | null {
  if (!input) {
    return null;
  }

  return {
    events: Array.isArray(input.events) ? [...input.events] : [],
    actions: Array.isArray(input.actions) ? [...input.actions] : []
  };
}

export class AgentEventsRuntime {
  private readonly agentsRoot: string;
  private readonly logger: AgentRuntimeLogger;
  private readonly defaultHandlerTimeoutMs: number;
  private readonly trustMode: AgentExtensionTrustMode;
  private readonly runtimeCompatibility: AgentRuntimeCompatibilityInput;
  private readonly extensionSources: Array<AgentExtensionSourceRoot>;

  private activeSnapshot = createEmptySnapshot();
  private loaded = false;
  private reloadInFlight: Promise<AgentEventsRuntimeReloadSuccess | AgentEventsRuntimeReloadFailure> | null = null;

  constructor(options: AgentEventsRuntimeOptions) {
    this.agentsRoot = options.agentsRoot;
    this.logger = options.logger;
    this.defaultHandlerTimeoutMs = ensurePositiveFiniteNumber(options.defaultHandlerTimeoutMs, DEFAULT_HANDLER_TIMEOUT_MS);
    this.trustMode = options.trustMode ?? "warn";
    this.runtimeCompatibility = options.runtimeCompatibility;

    const additionalSources = Array.isArray(options.extensionSources) ? options.extensionSources : [];
    const mergedSources: Array<AgentExtensionSourceRoot> = [
      {
        type: "repo_local",
        path: this.agentsRoot
      },
      ...additionalSources
    ];

    const dedupe = new Map<string, AgentExtensionSourceRoot>();
    for (const source of mergedSources) {
      const normalizedPath = path.resolve(source.path);
      dedupe.set(`${source.type}::${normalizedPath}`, {
        type: source.type,
        path: normalizedPath
      });
    }

    this.extensionSources = [...dedupe.values()].sort((left, right) => {
      const precedenceDelta = SOURCE_PRECEDENCE[left.type] - SOURCE_PRECEDENCE[right.type];
      if (precedenceDelta !== 0) {
        return precedenceDelta;
      }
      return left.path.localeCompare(right.path);
    });
  }

  public async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    const initial = await this.buildSnapshot({ strict: false });
    this.activeSnapshot = initial.snapshot;
    this.loaded = true;

    if (initial.errors.length > 0) {
      this.logger.warn(
        {
          errors: initial.errors,
          errorCount: initial.errors.length
        },
        "agent extension runtime loaded with module diagnostics"
      );
    }
  }

  public async emit(
    event: AgentRuntimeEvent,
    tools: AgentRuntimeTools,
    options?: {
      executeAction?: AgentRuntimeActionExecutor;
    }
  ): Promise<Array<AgentEventEmitResult>> {
    if (!this.loaded) {
      await this.load();
    }

    const snapshot = this.activeSnapshot;
    const handlers = [...(snapshot.handlersByEventType.get(event.type) ?? [])].sort(compareRegisteredHandlers);
    if (handlers.length === 0) {
      return [];
    }

    const results: Array<AgentEventEmitResult> = [];
    let actionWinner: AgentEventActionResult | null = null;
    for (const registration of handlers) {
      let handlerInvocationOpen = true;
      const handlerTools: AgentRuntimeTools = {
        enqueueJob: async (input) => {
          if (!handlerInvocationOpen) {
            throw new Error("agent handler invocation is no longer active");
          }
          return tools.enqueueJob(input);
        },
        logger: tools.logger
      };
      const handlerWork = Promise.resolve().then(() => registration.handler(event, handlerTools));
      try {
        const output = await withTimeout(handlerWork, registration.timeoutMs, `agent event handler timed out after ${registration.timeoutMs}ms`);

        if (isAgentRuntimeActionRequest(output)) {
          if (actionWinner) {
            results.push({
              kind: "action_result",
              moduleName: registration.moduleName,
              actionType: output.actionType,
              status: "not_eligible",
              ...(typeof output.requestId === "string" ? { requestId: output.requestId } : {}),
              ...(typeof output.idempotencyKey === "string" ? { idempotencyKey: output.idempotencyKey } : {}),
              details: {
                code: "action_winner_already_selected",
                winnerModuleName: actionWinner.moduleName,
                winnerActionType: actionWinner.actionType
              }
            });
            continue;
          }

          const actionCapability = evaluateActionCapability({
            mode: this.trustMode,
            extensionName: registration.extensionName,
            declaredCapabilities: registration.declaredCapabilities,
            actionType: output.actionType
          });

          if (!actionCapability.allowed) {
            results.push({
              kind: "action_result",
              moduleName: registration.moduleName,
              actionType: output.actionType,
              status: "forbidden",
              ...(typeof output.requestId === "string" ? { requestId: output.requestId } : {}),
              ...(typeof output.idempotencyKey === "string" ? { idempotencyKey: output.idempotencyKey } : {}),
              details: {
                code: "undeclared_capability",
                reason: actionCapability.reason
              }
            });
            continue;
          }

          if (actionCapability.reason) {
            this.logger.warn(
              {
                moduleName: registration.moduleName,
                actionType: output.actionType,
                reason: actionCapability.reason
              },
              "extension action capability was not declared"
            );
          }

          if (!options?.executeAction) {
            results.push({
              kind: "action_result",
              moduleName: registration.moduleName,
              actionType: output.actionType,
              status: "failed",
              ...(typeof output.requestId === "string" ? { requestId: output.requestId } : {}),
              ...(typeof output.idempotencyKey === "string" ? { idempotencyKey: output.idempotencyKey } : {}),
              details: {
                code: "action_executor_unavailable",
                message: "action executor is unavailable for this runtime invocation"
              }
            });
            continue;
          }

          const actionOutput = await options.executeAction(output);
          const normalizedAction = toAgentEventEmitResult(registration.moduleName, event.type, actionOutput);
          if (normalizedAction && normalizedAction.kind === "action_result") {
            results.push(normalizedAction);
            if (normalizedAction.status === "performed" && actionWinner === null) {
              actionWinner = normalizedAction;
            }
            continue;
          }
          results.push({
            kind: "action_result",
            moduleName: registration.moduleName,
            actionType: output.actionType,
            status: "failed",
            ...(typeof output.requestId === "string" ? { requestId: output.requestId } : {}),
            ...(typeof output.idempotencyKey === "string" ? { idempotencyKey: output.idempotencyKey } : {}),
            details: {
              code: "invalid_action_result",
              message: "action executor returned a non-action result"
            }
          });
          continue;
        }

        const normalized = toAgentEventEmitResult(registration.moduleName, event.type, output);
        if (!normalized) {
          continue;
        }

        if (normalized.kind === "action_result") {
          results.push({
            ...normalized,
            status: "invalid",
            details: {
              ...(normalized.details ?? {}),
              code: "direct_action_result_disallowed",
              message: "handlers must return kind=action_request so runtime can execute and reconcile actions"
            }
          });
          continue;
        }

        results.push(normalized);
      } catch (error) {
        this.logger.warn(
          {
            error,
            eventType: event.type,
            moduleName: registration.moduleName
          },
          "agent event handler failed; continuing with remaining handlers"
        );
        results.push(toAgentEventHandlerError(registration.moduleName, event.type, error));
      } finally {
        handlerInvocationOpen = false;
        void handlerWork.catch(() => undefined);
      }
    }

    const enqueueWinner = selectEnqueueWinner(results);
    const actionPlan = selectActionExecutionPlan(results);

    this.logger.info(
      {
        eventType: event.type,
        handlerCount: handlers.length,
        enqueueCount: results.filter((result) => result.kind === "enqueue_result").length,
        actionCount: results.filter((result) => result.kind === "action_result").length,
        handlerErrorCount: results.filter((result) => result.kind === "handler_error").length,
        enqueueWinner: enqueueWinner
          ? {
              moduleName: enqueueWinner.moduleName,
              status: enqueueWinner.status,
              jobId: enqueueWinner.job.id
            }
          : null,
        actionWinner: actionPlan.winner
          ? {
              moduleName: actionPlan.winner.moduleName,
              actionType: actionPlan.winner.actionType,
              status: actionPlan.winner.status
            }
          : null,
        reconciledStatuses: actionPlan.reconciled.map((entry) => entry.status)
      },
      "agent event fanout dispatch completed"
    );

    return results;
  }

  public listLoadedModules(): Array<LoadedAgentExtensionInventory> {
    return this.activeSnapshot.modules.map((module) => ({
      ...module,
      events: [...module.events],
      capabilities: {
        events: [...module.capabilities.events],
        actions: [...module.capabilities.actions]
      },
      compatibility: {
        ...module.compatibility,
        reasons: [...module.compatibility.reasons]
      },
      trust: {
        ...module.trust,
        warnings: [...module.trust.warnings],
        errors: [...module.trust.errors]
      },
      diagnostics: [...module.diagnostics],
      origin: {
        ...module.origin
      }
    }));
  }

  public snapshotInfo(): { snapshotVersion: string; loadedAt: string } {
    return {
      snapshotVersion: this.activeSnapshot.snapshotVersion,
      loadedAt: this.activeSnapshot.loadedAt
    };
  }

  public async reload(reloadId: string = randomUUID()): Promise<AgentEventsRuntimeReloadSuccess | AgentEventsRuntimeReloadFailure> {
    if (this.reloadInFlight) {
      return {
        status: "error",
        code: "reload_in_progress",
        reloadId,
        message: "extension reload already in progress",
        snapshotVersion: this.activeSnapshot.snapshotVersion,
        errors: []
      };
    }

    this.reloadInFlight = (async () => {
      const next = await this.buildSnapshot({ strict: true });
      if (next.errors.length > 0) {
        return {
          status: "error" as const,
          code: "reload_failed" as const,
          reloadId,
          message: "extension reload failed; prior snapshot preserved",
          snapshotVersion: this.activeSnapshot.snapshotVersion,
          errors: next.errors
        };
      }

      this.activeSnapshot = next.snapshot;
      this.loaded = true;

      return {
        status: "ok" as const,
        reloadId,
        loadedCount: next.snapshot.modules.length,
        failedCount: 0,
        snapshotVersion: next.snapshot.snapshotVersion,
        loadedAt: next.snapshot.loadedAt,
        modules: next.snapshot.modules.map((module) => ({
          name: module.name,
          version: module.version,
          agentId: module.agentId,
          events: [...module.events]
        }))
      };
    })();

    try {
      return await this.reloadInFlight;
    } finally {
      this.reloadInFlight = null;
    }
  }

  private async buildSnapshot(input: { strict: boolean }): Promise<{
    snapshot: AgentEventsRuntimeSnapshot;
    errors: Array<RuntimeModuleLoadError>;
  }> {
    const handlersByEventType = new Map<string, Array<RegisteredHandler>>();
    const modules: Array<LoadedAgentExtensionInventory> = [];
    const errors: Array<RuntimeModuleLoadError> = [];
    const candidates = await this.discoverModuleCandidates();
    const seenAgentIds = new Map<string, string>();
    let registrationCounter = 0;

    for (const candidate of candidates) {
      const loaded = await this.loadCandidateModule(candidate, {
        handlersByEventType,
        nextRegistrationIndex: () => registrationCounter++
      });

      if (loaded.error) {
        errors.push(loaded.error);
        continue;
      }

      if (!loaded.module) {
        continue;
      }

      const existingAgent = seenAgentIds.get(loaded.module.agentId);
      if (existingAgent) {
        errors.push({
          extension: loaded.module.name,
          code: "agent_id_conflict",
          message: `agentId \"${loaded.module.agentId}\" conflicts with module ${existingAgent}`
        });
        continue;
      }

      seenAgentIds.set(loaded.module.agentId, loaded.module.moduleName);
      modules.push(loaded.module);
    }

    if (input.strict && errors.length > 0) {
      return {
        snapshot: this.activeSnapshot,
        errors
      };
    }

    const snapshot: AgentEventsRuntimeSnapshot = {
      snapshotVersion: randomUUID(),
      loadedAt: new Date().toISOString(),
      handlersByEventType,
      modules
    };

    return {
      snapshot,
      errors
    };
  }

  private async discoverModuleCandidates(): Promise<Array<RuntimeModuleCandidate>> {
    const candidates = new Map<string, RuntimeModuleCandidate>();

    for (const source of this.extensionSources) {
      if (!existsSync(source.path)) {
        continue;
      }

      const discovered = await this.discoverSourceCandidates(source);
      for (const candidate of discovered) {
        const existing = candidates.get(candidate.extensionRoot);
        if (!existing) {
          candidates.set(candidate.extensionRoot, candidate);
          continue;
        }

        const existingPrecedence = SOURCE_PRECEDENCE[existing.origin.type];
        const candidatePrecedence = SOURCE_PRECEDENCE[candidate.origin.type];
        if (candidatePrecedence < existingPrecedence) {
          candidates.set(candidate.extensionRoot, candidate);
          continue;
        }

        if (candidatePrecedence === existingPrecedence && candidate.moduleName.localeCompare(existing.moduleName) < 0) {
          candidates.set(candidate.extensionRoot, candidate);
        }
      }
    }

    return [...candidates.values()].sort((left, right) => {
      const sourceDelta = SOURCE_PRECEDENCE[left.origin.type] - SOURCE_PRECEDENCE[right.origin.type];
      if (sourceDelta !== 0) {
        return sourceDelta;
      }

      const moduleDelta = left.moduleName.localeCompare(right.moduleName);
      if (moduleDelta !== 0) {
        return moduleDelta;
      }

      return left.extensionRoot.localeCompare(right.extensionRoot);
    });
  }

  private async discoverSourceCandidates(source: AgentExtensionSourceRoot): Promise<Array<RuntimeModuleCandidate>> {
    if (!existsSync(source.path)) {
      return [];
    }

    const addCandidate = (collection: Array<RuntimeModuleCandidate>, extensionRoot: string, moduleName: string): void => {
      collection.push({
        moduleName,
        extensionRoot,
        origin: {
          type: source.type,
          path: extensionRoot
        }
      });
    };

    const discovered: Array<RuntimeModuleCandidate> = [];

    if (this.looksLikeExtensionRoot(source.path)) {
      addCandidate(discovered, source.path, path.basename(source.path));
    }

    let dirEntries: Array<Dirent<string>>;
    try {
      dirEntries = await readdir(source.path, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      this.logger.warn(
        {
          sourceType: source.type,
          sourcePath: source.path,
          error
        },
        "failed to enumerate extension source root; skipping source"
      );
      return discovered;
    }
    for (const entry of dirEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (source.type === "repo_local" && (entry.name === "lib" || entry.name === "runtime")) {
        continue;
      }

      const extensionRoot = path.join(source.path, entry.name);
      if (!this.looksLikeExtensionRoot(extensionRoot)) {
        continue;
      }

      addCandidate(discovered, extensionRoot, entry.name);
    }

    return discovered;
  }

  private looksLikeExtensionRoot(extensionRoot: string): boolean {
    return (
      existsSync(path.join(extensionRoot, "extension.manifest.json")) ||
      existsSync(path.join(extensionRoot, "events.js")) ||
      existsSync(path.join(extensionRoot, "events.mjs")) ||
      existsSync(path.join(extensionRoot, "events.ts"))
    );
  }

  private async loadCandidateModule(
    candidate: RuntimeModuleCandidate,
    mutable: {
      handlersByEventType: Map<string, Array<RegisteredHandler>>;
      nextRegistrationIndex: () => number;
    }
  ): Promise<{ module: LoadedAgentExtensionInventory | null; error: RuntimeModuleLoadError | null }> {
    const manifestRead = await readExtensionManifest(candidate.extensionRoot);
    const manifest = manifestRead.manifest;

    if (manifestRead.manifestPath && !manifest && manifestRead.diagnostics.length > 0) {
      return {
        module: null,
        error: {
          extension: candidate.moduleName,
          code: "invalid_manifest",
          message: manifestRead.diagnostics.join("; ")
        }
      };
    }

    const identity = manifest ? {
      extensionName: manifest.name,
      extensionVersion: manifest.version,
      agentId: manifest.agentId,
      displayName: manifest.displayName
    } : defaultIdentityFromCandidate(candidate);

    const entrypointPath = resolveEventsEntrypoint(candidate.extensionRoot, manifest);
    if (!entrypointPath) {
      return {
        module: null,
        error: {
          extension: identity.extensionName,
          code: "missing_entrypoint",
          message: `no events entrypoint found for ${candidate.extensionRoot}`
        }
      };
    }

    const compatibility = evaluateCompatibility(manifest, this.runtimeCompatibility);
    if (!compatibility.compatible) {
      return {
        module: null,
        error: {
          extension: identity.extensionName,
          code: "incompatible_runtime",
          message: compatibility.reasons.join("; ")
        }
      };
    }

    const moduleUrl = `${pathToFileURL(entrypointPath).href}?reloadToken=${randomUUID()}`;
    let namespace: AgentModuleNamespace;

    try {
      namespace = (await import(moduleUrl)) as AgentModuleNamespace;
    } catch (error) {
      return {
        module: null,
        error: {
          extension: identity.extensionName,
          code: "import_failed",
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }

    const register = resolveRegisterFunction(namespace);
    if (!register) {
      return {
        module: null,
        error: {
          extension: identity.extensionName,
          code: "missing_register",
          message: "module does not export registerAgentEvents"
        }
      };
    }

    const pendingHandlers: Array<{ eventType: string; handler: AgentEventHandler; priority: number; timeoutMs: number }> = [];

    const registration: AgentEventRegistry = {
      on: (eventType: string, handler: AgentEventHandler, options?: { priority?: number; timeoutMs?: number }) => {
        if (typeof eventType !== "string" || eventType.trim().length === 0) {
          return;
        }

        pendingHandlers.push({
          eventType: eventType.trim(),
          handler,
          priority: normalizePriority(options?.priority),
          timeoutMs: ensurePositiveFiniteNumber(options?.timeoutMs, this.defaultHandlerTimeoutMs)
        });
      }
    };

    try {
      register(registration);
    } catch (error) {
      return {
        module: null,
        error: {
          extension: identity.extensionName,
          code: "registration_failed",
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }

    const registeredEvents = [...new Set(pendingHandlers.map((entry) => entry.eventType))];
    const declaredCapabilities = toCapabilityDeclaration(manifest?.capabilities ?? null);
    const trust = evaluateExtensionTrust({
      mode: this.trustMode,
      extensionName: identity.extensionName,
      declaredCapabilities,
      registeredEvents
    });

    if (trust.status === "denied") {
      return {
        module: null,
        error: {
          extension: identity.extensionName,
          code: "trust_denied",
          message: trust.errors.join("; ")
        }
      };
    }

    for (const pending of pendingHandlers) {
      const current = mutable.handlersByEventType.get(pending.eventType) ?? [];
      current.push({
        moduleName: candidate.moduleName,
        extensionName: identity.extensionName,
        handler: pending.handler,
        priority: pending.priority,
        registrationIndex: mutable.nextRegistrationIndex(),
        timeoutMs: pending.timeoutMs,
        declaredCapabilities
      });
      mutable.handlersByEventType.set(pending.eventType, current);
    }

    const moduleInventory: LoadedAgentExtensionInventory = {
      moduleName: candidate.moduleName,
      name: identity.extensionName,
      version: identity.extensionVersion,
      agentId: identity.agentId,
      displayName: identity.displayName,
      manifestPath: manifestRead.manifestPath,
      entrypointPath,
      events: registeredEvents,
      origin: {
        ...candidate.origin
      },
      compatibility,
      capabilities: {
        events: declaredCapabilities?.events ?? [],
        actions: declaredCapabilities?.actions ?? []
      },
      trust,
      diagnostics: [...manifestRead.diagnostics]
    };

    this.logger.info(
      {
        moduleName: candidate.moduleName,
        extension: moduleInventory.name,
        entrypointPath,
        registeredEvents,
        origin: candidate.origin,
        trust: moduleInventory.trust.status
      },
      "loaded agent events module"
    );

    return {
      module: moduleInventory,
      error: null
    };
  }
}
