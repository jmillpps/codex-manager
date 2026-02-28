import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

type RegisteredHandler = (event: { type: string; payload: unknown }, tools: unknown) => Promise<unknown> | unknown;

type SupervisorModule = {
  registerAgentEvents: (registry: {
    on: (eventType: string, handler: RegisteredHandler) => void;
  }) => void;
};

async function loadSupervisorModule(): Promise<SupervisorModule> {
  const modulePath = path.resolve(process.cwd(), "..", "..", "agents", "supervisor", "events.js");
  const imported = (await import(pathToFileURL(modulePath).href)) as Partial<SupervisorModule>;
  if (typeof imported.registerAgentEvents !== "function") {
    throw new Error("failed to load supervisor extension module exports");
  }
  return {
    registerAgentEvents: imported.registerAgentEvents
  };
}

async function createRegistryHarness() {
  const handlersByEvent = new Map<string, Array<RegisteredHandler>>();
  const supervisorModule = await loadSupervisorModule();

  supervisorModule.registerAgentEvents({
    on: (eventType: string, handler: RegisteredHandler) => {
      const list = handlersByEvent.get(eventType) ?? [];
      list.push(handler);
      handlersByEvent.set(eventType, list);
    }
  });

  return handlersByEvent;
}

function createToolsHarness(options?: { settingsBySessionId?: Record<string, Record<string, unknown>> }) {
  const enqueueCalls: Array<Record<string, unknown>> = [];
  const settingsBySessionId = options?.settingsBySessionId ?? {};
  return {
    enqueueCalls,
    tools: {
      enqueueJob: async (input: Record<string, unknown>) => {
        enqueueCalls.push(input);
        return {
          status: "enqueued" as const,
          job: {
            id: `job-${enqueueCalls.length}`,
            type: String(input.type ?? "unknown"),
            projectId: String(input.projectId ?? "unknown"),
            state: "queued" as const
          }
        };
      },
      getSessionSettings: async (sessionId: string) => settingsBySessionId[sessionId] ?? {},
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    }
  };
}

test("file-change workflow enqueues explainability before supervisor insight targets", async () => {
  const handlersByEvent = await createRegistryHarness();
  const fileChangeHandler = handlersByEvent.get("file_change.approval_requested")?.[0];
  assert.ok(fileChangeHandler, "expected file_change.approval_requested handler");

  const { enqueueCalls, tools } = createToolsHarness({
    settingsBySessionId: {
      "session-1": {
        supervisor: {
          fileChange: {
            diffExplainability: true,
            autoActions: {
              approve: { enabled: true, threshold: "high" },
              reject: { enabled: false, threshold: "high" },
              steer: { enabled: true, threshold: "med" }
            }
          }
        }
      }
    }
  });

  await fileChangeHandler(
    {
      type: "file_change.approval_requested",
      payload: {
        context: {
          projectId: "project-1",
          sourceSessionId: "session-1",
          threadId: "session-1",
          turnId: "turn-1",
          itemId: "item-1",
          approvalId: "approval-1",
          anchorItemId: "item-1",
          userRequest: "User asked for a safe refactor.",
          turnTranscript: "Existing turn transcript"
        },
        summary: "File change awaiting approval: 1 change",
        details: "changed file",
        sourceEvent: "approval_request",
        fileChangeStatus: "pending_approval"
      }
    },
    tools
  );

  assert.equal(enqueueCalls.length, 1);
  const enqueue = enqueueCalls[0];
  assert.equal(enqueue.type, "agent_instruction");

  const payload = enqueue.payload as {
    instructionText?: string;
    supplementalTargets?: Array<{ type?: string }>;
    expectResponse?: string;
    bootstrapInstruction?: { key?: string; instructionText?: string };
  };
  const targets = payload.supplementalTargets ?? [];
  assert.equal(targets[0]?.type, "fileChange.explainability");
  assert.equal(targets[1]?.type, "fileChange.supervisorInsight");
  assert.equal(payload.expectResponse, "none");
  assert.equal(payload.bootstrapInstruction?.key, "supervisor.queue-runner.bootstrap.v1");
  assert.match(String(payload.bootstrapInstruction?.instructionText ?? ""), /supported job kinds/i);

  const instructionText = payload.instructionText ?? "";
  const explainabilityOrder = instructionText.indexOf("1. Write/update diff explainability");
  const supervisorInsightOrder = instructionText.indexOf("2. Write/update supervisor insight");
  assert.ok(explainabilityOrder >= 0, "expected explainability step in instruction text");
  assert.ok(supervisorInsightOrder >= 0, "expected supervisor insight step in instruction text");
  assert.ok(explainabilityOrder < supervisorInsightOrder, "explainability must be ordered before supervisor insight");
  assert.match(instructionText, /pnpm --filter @repo\/cli dev --json sessions transcript upsert/i);
  assert.match(instructionText, /pnpm --filter @repo\/cli dev --json approvals decide/i);
  assert.match(instructionText, /pnpm --filter @repo\/cli dev --json sessions steer/i);
  assert.doesNotMatch(instructionText, /action_intents/i);
  assert.doesNotMatch(instructionText, /\/api\/agents\/actions\/execute/i);
});

test("auto-action reconciliation rules are encoded in file-change handler instruction text", async () => {
  const handlersByEvent = await createRegistryHarness();
  const fileChangeHandler = handlersByEvent.get("file_change.approval_requested")?.[0];
  assert.ok(fileChangeHandler, "expected file_change.approval_requested handler");

  const eligibleHarness = createToolsHarness({
    settingsBySessionId: {
      "session-1": {
        supervisor: {
          fileChange: {
            diffExplainability: true,
            autoActions: {
              approve: { enabled: true, threshold: "high" },
              reject: { enabled: true, threshold: "med" },
              steer: { enabled: true, threshold: "med" }
            }
          }
        }
      }
    }
  });
  await fileChangeHandler(
    {
      type: "file_change.approval_requested",
      payload: {
        context: {
          projectId: "project-1",
          sourceSessionId: "session-1",
          threadId: "session-1",
          turnId: "turn-1",
          approvalId: "approval-1"
        },
        summary: "summary",
        details: "details",
        fileChangeStatus: "pending_approval"
      }
    },
    eligibleHarness.tools
  );
  const eligibleText = String(
    (eligibleHarness.enqueueCalls[0]?.payload as { instructionText?: string } | undefined)?.instructionText ?? ""
  );
  assert.match(eligibleText, /Approval actions are eligible/i);
  assert.match(eligibleText, /If API indicates the request was already resolved, treat it as reconciled and continue/i);
  assert.match(eligibleText, /If both approve and reject conditions match, reject wins\./i);

  const ineligibleHarness = createToolsHarness();
  await fileChangeHandler(
    {
      type: "file_change.approval_requested",
      payload: {
        context: {
          projectId: "project-1",
          sourceSessionId: "session-1",
          threadId: "session-1",
          turnId: "turn-1"
        },
        summary: "summary",
        details: "details",
        fileChangeStatus: "pending_approval"
      }
    },
    ineligibleHarness.tools
  );
  const ineligibleText = String(
    (ineligibleHarness.enqueueCalls[0]?.payload as { instructionText?: string } | undefined)?.instructionText ?? ""
  );
  assert.match(ineligibleText, /All auto actions are disabled for this session/i);
});

test("file-change workflow skips enqueue when explainability and auto-actions are all disabled", async () => {
  const handlersByEvent = await createRegistryHarness();
  const fileChangeHandler = handlersByEvent.get("file_change.approval_requested")?.[0];
  assert.ok(fileChangeHandler, "expected file_change.approval_requested handler");

  const { enqueueCalls, tools } = createToolsHarness({
    settingsBySessionId: {
      "session-1": {
        supervisor: {
          fileChange: {
            diffExplainability: false,
            autoActions: {
              approve: { enabled: false, threshold: "low" },
              reject: { enabled: false, threshold: "high" },
              steer: { enabled: false, threshold: "high" }
            }
          }
        }
      }
    }
  });

  await fileChangeHandler(
    {
      type: "file_change.approval_requested",
      payload: {
        context: {
          projectId: "project-1",
          sourceSessionId: "session-1",
          threadId: "session-1",
          turnId: "turn-1",
          itemId: "item-1",
          approvalId: "approval-1"
        },
        summary: "summary",
        details: "details",
        fileChangeStatus: "pending_approval"
      }
    },
    tools
  );

  assert.equal(enqueueCalls.length, 0);
});

test("file-change workflow builds auto-action-only instruction when explainability is disabled", async () => {
  const handlersByEvent = await createRegistryHarness();
  const fileChangeHandler = handlersByEvent.get("file_change.approval_requested")?.[0];
  assert.ok(fileChangeHandler, "expected file_change.approval_requested handler");

  const { enqueueCalls, tools } = createToolsHarness({
    settingsBySessionId: {
      "session-1": {
        supervisor: {
          fileChange: {
            diffExplainability: false,
            autoActions: {
              approve: { enabled: false, threshold: "low" },
              reject: { enabled: false, threshold: "high" },
              steer: { enabled: true, threshold: "high" }
            }
          }
        }
      }
    }
  });

  await fileChangeHandler(
    {
      type: "file_change.approval_requested",
      payload: {
        context: {
          projectId: "project-1",
          sourceSessionId: "session-1",
          threadId: "session-1",
          turnId: "turn-1",
          itemId: "item-1",
          approvalId: "approval-1"
        },
        summary: "summary",
        details: "details",
        fileChangeStatus: "pending_approval"
      }
    },
    tools
  );

  assert.equal(enqueueCalls.length, 1);
  const payload = enqueueCalls[0]?.payload as { instructionText?: string; supplementalTargets?: Array<unknown> } | undefined;
  const instructionText = String(payload?.instructionText ?? "");
  assert.match(instructionText, /Auto-steer is enabled at threshold "high"\./i);
  assert.match(instructionText, /sessions steer/i);
  assert.doesNotMatch(instructionText, /fileChange\.explainability/i);
  assert.equal(Array.isArray(payload?.supplementalTargets), false);
});

test("auto-action policy accepts medium threshold alias from event payloads", async () => {
  const handlersByEvent = await createRegistryHarness();
  const fileChangeHandler = handlersByEvent.get("file_change.approval_requested")?.[0];
  assert.ok(fileChangeHandler, "expected file_change.approval_requested handler");

  const { enqueueCalls, tools } = createToolsHarness({
    settingsBySessionId: {
      "session-1": {
        supervisor: {
          fileChange: {
            diffExplainability: true,
            autoActions: {
              approve: { enabled: true, threshold: "medium" },
              reject: { enabled: true, threshold: "medium" },
              steer: { enabled: true, threshold: "medium" }
            }
          }
        }
      }
    }
  });

  await fileChangeHandler(
    {
      type: "file_change.approval_requested",
      payload: {
        context: {
          projectId: "project-1",
          sourceSessionId: "session-1",
          threadId: "session-1",
          turnId: "turn-1",
          itemId: "item-1",
          approvalId: "approval-1"
        },
        summary: "File change awaiting approval: 1 change",
        details: "changed file",
        sourceEvent: "approval_request",
        fileChangeStatus: "pending_approval"
      }
    },
    tools
  );

  assert.equal(enqueueCalls.length, 1);
  const instructionText = String((enqueueCalls[0]?.payload as { instructionText?: string } | undefined)?.instructionText ?? "");
  assert.match(instructionText, /Auto-approve is enabled at threshold "med"\./i);
  assert.match(instructionText, /Auto-reject is enabled at threshold "med"\./i);
  assert.match(instructionText, /Auto-steer is enabled at threshold "med"\./i);
});

test("turn.completed review enqueue is gated by hadFileChangeRequests", async () => {
  const handlersByEvent = await createRegistryHarness();
  const turnCompletedHandler = handlersByEvent.get("turn.completed")?.[0];
  assert.ok(turnCompletedHandler, "expected turn.completed handler");

  const noFileChanges = createToolsHarness();
  await turnCompletedHandler(
    {
      type: "turn.completed",
      payload: {
        context: {
          projectId: "project-1",
          sourceSessionId: "session-1",
          threadId: "session-1",
          turnId: "turn-1"
        },
        hadFileChangeRequests: false,
        turnTranscriptSnapshot: "Turn transcript"
      }
    },
    noFileChanges.tools
  );
  assert.equal(noFileChanges.enqueueCalls.length, 0, "should not enqueue review when no file-change requests occurred");

  const withFileChanges = createToolsHarness();
  await turnCompletedHandler(
    {
      type: "turn.completed",
      payload: {
        context: {
          projectId: "project-1",
          sourceSessionId: "session-1",
          threadId: "session-1",
          turnId: "turn-1"
        },
        hadFileChangeRequests: true,
        turnTranscriptSnapshot: "Turn transcript"
      }
    },
    withFileChanges.tools
  );

  assert.equal(withFileChanges.enqueueCalls.length, 1);
  const enqueue = withFileChanges.enqueueCalls[0];
  assert.equal(enqueue.type, "agent_instruction");
  assert.equal((enqueue.payload as { jobKind?: string }).jobKind, "turn_supervisor_review");
  assert.equal((enqueue.payload as { expectResponse?: string }).expectResponse, "none");
});

test("app_server.item.started enqueues session_initial_rename when user message starts a turn", async () => {
  const handlersByEvent = await createRegistryHarness();
  const renameHandler = handlersByEvent.get("app_server.item.started")?.[0];
  assert.ok(renameHandler, "expected app_server.item.started handler");

  const { enqueueCalls, tools } = createToolsHarness();
  await renameHandler(
    {
      type: "app_server.item.started",
      payload: {
        source: "app_server",
        signalType: "notification",
        eventType: "app_server.item.started",
        method: "item/started",
        receivedAt: "2026-02-25T00:00:00.000Z",
        context: {
          threadId: "session-1",
          turnId: "turn-1"
        },
        params: {
          threadId: "session-1",
          turnId: "turn-1",
          item: {
            type: "userMessage",
            id: "item-1",
            content: [
              {
                type: "text",
                text: "Design an API endpoint for listing active tasks."
              }
            ]
          }
        }
      }
    },
    tools
  );

  assert.equal(enqueueCalls.length, 1);
  const enqueue = enqueueCalls[0];
  assert.equal(enqueue.type, "agent_instruction");
  const payload = enqueue.payload as {
    jobKind?: string;
    dedupeKey?: string;
    expectResponse?: string;
    projectId?: string;
    sourceSessionId?: string;
    turnId?: string;
    instructionText?: string;
  };
  assert.equal(payload.jobKind, "session_initial_rename");
  assert.equal(payload.dedupeKey, "session_initial_rename:session-1");
  assert.equal(payload.expectResponse, "none");
  assert.equal(payload.projectId, "session:session-1");
  assert.equal(payload.sourceSessionId, "session-1");
  assert.equal(payload.turnId, "turn-1");
  const instructionText = String(payload.instructionText ?? "");
  assert.match(instructionText, /session_initial_rename/i);
  assert.match(instructionText, /sessions get/i);
  assert.match(instructionText, /sessions rename/i);
  assert.match(instructionText, /current chat title is still exactly `New chat`/i);
});

test("app_server.item.started rename flow skips non-default titles", async () => {
  const handlersByEvent = await createRegistryHarness();
  const renameHandler = handlersByEvent.get("app_server.item.started")?.[0];
  assert.ok(renameHandler, "expected app_server.item.started handler");

  const titledSession = createToolsHarness();
  await renameHandler(
    {
      type: "app_server.item.started",
      payload: {
        source: "app_server",
        signalType: "notification",
        eventType: "app_server.item.started",
        method: "item/started",
        context: {
          threadId: "session-1",
          turnId: "turn-1"
        },
        session: {
          id: "session-1",
          title: "Parser bug triage",
          projectId: "project-1"
        },
        params: {
          threadId: "session-1",
          turnId: "turn-1",
          item: {
            type: "userMessage",
            id: "item-1",
            content: [{ type: "text", text: "Refine parser recovery strategy." }]
          }
        }
      }
    },
    titledSession.tools
  );
  assert.equal(titledSession.enqueueCalls.length, 0);
});

test("app_server.item.started rename flow skips non-user items and does not throw on missing content", async () => {
  const handlersByEvent = await createRegistryHarness();
  const renameHandler = handlersByEvent.get("app_server.item.started")?.[0];
  assert.ok(renameHandler, "expected app_server.item.started handler");

  const nonUserItem = createToolsHarness();
  await assert.doesNotReject(async () => {
    await renameHandler(
      {
        type: "app_server.item.started",
        payload: {
          source: "app_server",
          signalType: "notification",
          eventType: "app_server.item.started",
          method: "item/started",
          context: {
            threadId: "session-1",
            turnId: "turn-1"
          },
          params: {
            threadId: "session-1",
            turnId: "turn-1",
            item: {
              type: "reasoning",
              id: "item-1"
            }
          }
        }
      },
      nonUserItem.tools
    );
  });
  assert.equal(nonUserItem.enqueueCalls.length, 0);
});

test("suggest_request workflow uses CLI upsert side effects instead of assistant output contract", async () => {
  const handlersByEvent = await createRegistryHarness();
  const suggestHandler = handlersByEvent.get("suggest_request.requested")?.[0];
  assert.ok(suggestHandler, "expected suggest_request.requested handler");

  const { enqueueCalls, tools } = createToolsHarness();
  await suggestHandler(
    {
      type: "suggest_request.requested",
      payload: {
        requestKey: "request-1",
        sessionId: "session-1",
        projectId: "project-1",
        threadId: "session-1",
        turnId: "turn-1",
        userRequest: "Improve error handling in the parser.",
        turnTranscript: "1. user: Improve error handling in the parser.\n2. assistant: Working on parser validation.",
        draft: "Can you update parser error handling?"
      }
    },
    tools
  );

  assert.equal(enqueueCalls.length, 1);
  const enqueue = enqueueCalls[0];
  assert.equal(enqueue.type, "agent_instruction");
  const payload = enqueue.payload as {
    instructionText?: string;
    jobKind?: string;
    expectResponse?: string;
    dedupeKey?: string;
    completionSignal?: { kind?: string; requestKey?: string };
    bootstrapInstruction?: { key?: string };
  };
  assert.equal(payload.jobKind, "suggest_request");
  assert.equal(payload.expectResponse, "none");
  assert.equal(payload.dedupeKey, "suggest_request:session-1");
  assert.equal(payload.completionSignal?.kind, "suggested_request");
  assert.equal(payload.completionSignal?.requestKey, "request-1");
  assert.equal(payload.bootstrapInstruction?.key, "supervisor.queue-runner.bootstrap.v1");
  const instructionText = String(payload.instructionText ?? "");
  assert.match(instructionText, /sessions suggest-request upsert/i);
  assert.match(instructionText, /--status streaming/i);
  assert.match(instructionText, /--status complete/i);
  assert.match(instructionText, /Requested model:/i);
  assert.match(instructionText, /Requested effort:/i);
});
