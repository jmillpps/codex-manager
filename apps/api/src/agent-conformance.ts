import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentEventsRuntime } from "./agent-events-runtime.js";

export type AgentConformanceProfileRun = {
  profileId: string;
  profileVersion: string;
  status: "passed" | "failed";
  loadedModuleCount: number;
  enqueueStatus: "enqueued" | "already_queued" | null;
  enqueueJobType: string | null;
  errors: Array<string>;
};

export type AgentConformanceReport = {
  generatedAt: string;
  coreVersion: number;
  fixturePath: string;
  profiles: Array<AgentConformanceProfileRun>;
  portableExtension: boolean;
};

const defaultFixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../test-fixtures/extensions/portable-suggest-agent"
);

function runtimeLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}

async function runProfileConformance(input: {
  fixturePath: string;
  profileId: string;
  profileVersion: string;
}): Promise<AgentConformanceProfileRun> {
  const runtime = new AgentEventsRuntime({
    agentsRoot: path.join(input.fixturePath, "__none__"),
    logger: runtimeLogger(),
    trustMode: "enforced",
    runtimeCompatibility: {
      coreVersion: 1,
      runtimeProfileId: input.profileId,
      runtimeProfileVersion: input.profileVersion
    },
    extensionSources: [
      {
        type: "installed_package",
        path: input.fixturePath
      }
    ]
  });

  const reload = await runtime.reload(`conformance-${input.profileId}`);
  if (reload.status !== "ok") {
    return {
      profileId: input.profileId,
      profileVersion: input.profileVersion,
      status: "failed",
      loadedModuleCount: 0,
      enqueueStatus: null,
      enqueueJobType: null,
      errors: reload.errors.map((entry) => `${entry.code}:${entry.message}`)
    };
  }

  const emitted = await runtime.emit(
    {
      type: "suggest_request.requested",
      payload: {
        projectId: "portable-project",
        sessionId: "portable-session",
        requestKey: "portable-request"
      }
    },
    {
      enqueueJob: async (enqueueInput) => ({
        status: "enqueued",
        job: {
          id: "portable-job",
          type: enqueueInput.type,
          projectId: enqueueInput.projectId,
          state: "queued"
        }
      }),
      logger: runtimeLogger()
    }
  );

  const enqueue = emitted.find((entry) => entry.kind === "enqueue_result");
  if (!enqueue) {
    return {
      profileId: input.profileId,
      profileVersion: input.profileVersion,
      status: "failed",
      loadedModuleCount: runtime.listLoadedModules().length,
      enqueueStatus: null,
      enqueueJobType: null,
      errors: ["no enqueue_result produced by portable fixture extension"]
    };
  }

  return {
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    status: "passed",
    loadedModuleCount: runtime.listLoadedModules().length,
    enqueueStatus: enqueue.status,
    enqueueJobType: enqueue.job.type,
    errors: []
  };
}

export async function runAgentConformance(input?: { fixturePath?: string }): Promise<AgentConformanceReport> {
  const fixturePath = input?.fixturePath ? path.resolve(input.fixturePath) : defaultFixturePath;

  const profileRuns = await Promise.all([
    runProfileConformance({
      fixturePath,
      profileId: "codex-manager",
      profileVersion: "1.0.0"
    }),
    runProfileConformance({
      fixturePath,
      profileId: "fixture-profile",
      profileVersion: "1.0.0"
    })
  ]);

  const portableExtension =
    profileRuns.every((run) => run.status === "passed") &&
    profileRuns.every((run) => run.enqueueStatus === "enqueued") &&
    profileRuns.every((run) => run.enqueueJobType === "suggest_request");

  return {
    generatedAt: new Date().toISOString(),
    coreVersion: 1,
    fixturePath,
    profiles: profileRuns,
    portableExtension
  };
}
