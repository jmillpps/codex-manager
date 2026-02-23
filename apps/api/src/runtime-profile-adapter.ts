import type { CodexRuntimeClient } from "./codex-runtime-client.js";

export const AGENT_RUNTIME_CORE_VERSION = 1;

export type RuntimeProfileIdentity = {
  profileId: string;
  profileVersion: string;
  coreVersion: number;
};

export type RuntimeProfileStartTurnInput = {
  threadId: string;
  inputText: string;
  model?: string | null;
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
  sandboxPolicy: Record<string, unknown>;
  approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
};

export type RuntimeProfileTurn = {
  id: string;
};

export type RuntimeProfileReadThreadInput = {
  threadId: string;
  includeTurns: boolean;
};

export type RuntimeProfileActionResult = {
  actionType: "transcript.upsert" | "approval.accept" | "approval.decline" | "turn.steer";
  status: "performed" | "already_resolved" | "not_eligible" | "conflict" | "failed";
  details?: Record<string, unknown>;
};

export type RuntimeProfileTranscriptUpsertInput = {
  sessionId: string;
  entry: {
    messageId: string;
    turnId: string;
    role: "user" | "assistant" | "system";
    type: string;
    content: string;
    details?: string;
    status: "streaming" | "complete" | "canceled" | "error";
    startedAt?: number;
    completedAt?: number;
  };
};

export type RuntimeProfileApprovalDecisionInput = {
  rpcId: string | number;
  payload: Record<string, unknown>;
  approvalId: string;
  threadId: string;
  actionType: "approval.accept" | "approval.decline";
};

export type RuntimeProfileSteerTurnInput = {
  sessionId: string;
  turnId: string;
  input: string;
};

export type CodexTurnSteerParams = {
  threadId: string;
  expectedTurnId: string;
  input: Array<{
    type: "text";
    text: string;
    text_elements: Array<unknown>;
  }>;
};

export type RuntimeProfileAdapter = {
  identity: () => RuntimeProfileIdentity;
  startTurn: (input: RuntimeProfileStartTurnInput) => Promise<RuntimeProfileTurn>;
  readThread: (input: RuntimeProfileReadThreadInput) => Promise<{ thread: unknown }>;
  interruptTurn: (input: { threadId: string; turnId: string }) => Promise<void>;
  upsertTranscript: (input: RuntimeProfileTranscriptUpsertInput) => Promise<RuntimeProfileActionResult>;
  decideApproval: (input: RuntimeProfileApprovalDecisionInput) => Promise<RuntimeProfileActionResult>;
  steerTurn: (input: RuntimeProfileSteerTurnInput) => Promise<RuntimeProfileActionResult>;
};

export type CodexManagerRuntimeProfileAdapterOptions = {
  codexRuntime: CodexRuntimeClient;
  upsertTranscript: RuntimeProfileAdapter["upsertTranscript"];
  decideApproval: RuntimeProfileAdapter["decideApproval"];
  steerTurn: RuntimeProfileAdapter["steerTurn"];
  profileVersion?: string;
};

export function toCodexTurnSteerParams(input: RuntimeProfileSteerTurnInput): CodexTurnSteerParams {
  return {
    threadId: input.sessionId,
    expectedTurnId: input.turnId,
    input: [
      {
        type: "text",
        text: input.input,
        text_elements: []
      }
    ]
  };
}

export async function callCodexTurnSteer(codexRuntime: CodexRuntimeClient, input: RuntimeProfileSteerTurnInput): Promise<void> {
  await codexRuntime.call("turn/steer", toCodexTurnSteerParams(input));
}

export function createCodexManagerRuntimeProfileAdapter(
  options: CodexManagerRuntimeProfileAdapterOptions
): RuntimeProfileAdapter {
  const profileVersion = options.profileVersion ?? "1.0.0";

  return {
    identity: () => ({
      profileId: "codex-manager",
      profileVersion,
      coreVersion: AGENT_RUNTIME_CORE_VERSION
    }),
    startTurn: async (input) => {
      const result = await options.codexRuntime.call<{ turn: { id: string } }>("turn/start", {
        threadId: input.threadId,
        model: input.model ?? undefined,
        effort: input.effort ?? undefined,
        sandboxPolicy: input.sandboxPolicy,
        approvalPolicy: input.approvalPolicy,
        input: [
          {
            type: "text",
            text: input.inputText,
            text_elements: []
          }
        ]
      });
      return result.turn;
    },
    readThread: async (input) =>
      options.codexRuntime.call<{ thread: unknown }>("thread/read", {
        threadId: input.threadId,
        includeTurns: input.includeTurns
      }),
    interruptTurn: async (input) => {
      await options.codexRuntime.call("turn/interrupt", input);
    },
    upsertTranscript: options.upsertTranscript,
    decideApproval: options.decideApproval,
    steerTurn: options.steerTurn
  };
}

export type FixtureRuntimeProfileAdapterOptions = {
  profileId?: string;
  profileVersion?: string;
  onStartTurn?: (input: RuntimeProfileStartTurnInput) => RuntimeProfileTurn | Promise<RuntimeProfileTurn>;
  onReadThread?: (input: RuntimeProfileReadThreadInput) => { thread: unknown } | Promise<{ thread: unknown }>;
  onInterruptTurn?: (input: { threadId: string; turnId: string }) => void | Promise<void>;
  onTranscriptUpsert?: (
    input: RuntimeProfileTranscriptUpsertInput
  ) => RuntimeProfileActionResult | Promise<RuntimeProfileActionResult>;
  onApprovalDecision?: (
    input: RuntimeProfileApprovalDecisionInput
  ) => RuntimeProfileActionResult | Promise<RuntimeProfileActionResult>;
  onSteerTurn?: (input: RuntimeProfileSteerTurnInput) => RuntimeProfileActionResult | Promise<RuntimeProfileActionResult>;
};

export function createFixtureRuntimeProfileAdapter(options?: FixtureRuntimeProfileAdapterOptions): RuntimeProfileAdapter {
  const profileId = options?.profileId ?? "fixture-profile";
  const profileVersion = options?.profileVersion ?? "1.0.0";

  return {
    identity: () => ({
      profileId,
      profileVersion,
      coreVersion: AGENT_RUNTIME_CORE_VERSION
    }),
    startTurn: async (input) =>
      options?.onStartTurn
        ? await options.onStartTurn(input)
        : {
            id: `${input.threadId}-fixture-turn`
          },
    readThread: async (input) =>
      options?.onReadThread
        ? await options.onReadThread(input)
        : {
            thread: {
              id: input.threadId,
              turns: []
            }
          },
    interruptTurn: async (input) => {
      await options?.onInterruptTurn?.(input);
    },
    upsertTranscript: async (input) =>
      options?.onTranscriptUpsert
        ? await options.onTranscriptUpsert(input)
        : {
            actionType: "transcript.upsert",
            status: "performed",
            details: {
              messageId: input.entry.messageId
            }
          },
    decideApproval: async (input) =>
      options?.onApprovalDecision
        ? await options.onApprovalDecision(input)
        : {
            actionType: input.actionType,
            status: "performed",
            details: {
              approvalId: input.approvalId
            }
          },
    steerTurn: async (input) =>
      options?.onSteerTurn
        ? await options.onSteerTurn(input)
        : {
            actionType: "turn.steer",
            status: "performed",
            details: {
              turnId: input.turnId
            }
          }
  };
}
