import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_RUNTIME_CORE_VERSION,
  callCodexTurnSteer,
  createCodexManagerRuntimeProfileAdapter,
  createFixtureRuntimeProfileAdapter,
  toCodexTurnSteerParams
} from "./runtime-profile-adapter.js";

test("codex runtime profile adapter delegates provider operations behind adapter interface", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const codexRuntime = {
    async call(method: string, params?: unknown): Promise<unknown> {
      calls.push({ method, params: params ?? null });
      if (method === "turn/start") {
        return {
          turn: {
            id: "turn-123"
          }
        };
      }
      if (method === "thread/read") {
        return {
          thread: {
            id: "thread-1",
            turns: []
          }
        };
      }
      return {};
    }
  };

  const adapter = createCodexManagerRuntimeProfileAdapter({
    codexRuntime: codexRuntime as never,
    upsertTranscript: async () => ({
      actionType: "transcript.upsert",
      status: "performed"
    }),
    decideApproval: async () => ({
      actionType: "approval.accept",
      status: "performed"
    }),
    steerTurn: async () => ({
      actionType: "turn.steer",
      status: "performed"
    })
  });

  const profile = adapter.identity();
  assert.equal(profile.profileId, "codex-manager");
  assert.equal(profile.coreVersion, AGENT_RUNTIME_CORE_VERSION);

  const startedTurn = await adapter.startTurn({
    threadId: "thread-1",
    inputText: "hello",
    sandboxPolicy: {
      mode: "workspace-write"
    },
    approvalPolicy: "on-request"
  });
  assert.equal(startedTurn.id, "turn-123");

  const readThread = await adapter.readThread({
    threadId: "thread-1",
    includeTurns: true
  });
  assert.equal((readThread.thread as { id: string }).id, "thread-1");

  await adapter.interruptTurn({
    threadId: "thread-1",
    turnId: "turn-123"
  });

  assert.equal(calls[0]?.method, "turn/start");
  assert.equal(calls[1]?.method, "thread/read");
  assert.equal(calls[2]?.method, "turn/interrupt");
});

test("fixture runtime profile adapter provides non-codex profile conformance target", async () => {
  const adapter = createFixtureRuntimeProfileAdapter({
    profileId: "portable-fixture",
    profileVersion: "2.0.0"
  });

  const profile = adapter.identity();
  assert.equal(profile.profileId, "portable-fixture");
  assert.equal(profile.profileVersion, "2.0.0");
  assert.equal(profile.coreVersion, AGENT_RUNTIME_CORE_VERSION);

  const turn = await adapter.startTurn({
    threadId: "fixture-thread",
    inputText: "test",
    sandboxPolicy: {},
    approvalPolicy: "never"
  });
  assert.equal(turn.id, "fixture-thread-fixture-turn");

  const transcriptResult = await adapter.upsertTranscript({
    sessionId: "fixture-thread",
    entry: {
      messageId: "m1",
      turnId: "t1",
      role: "system",
      type: "test",
      content: "hello",
      status: "complete"
    }
  });
  assert.equal(transcriptResult.status, "performed");
  assert.equal(transcriptResult.actionType, "transcript.upsert");
});

test("toCodexTurnSteerParams emits expectedTurnId with InputItem array payload", () => {
  const params = toCodexTurnSteerParams({
    sessionId: "thread-42",
    turnId: "turn-42",
    input: "Continue."
  });

  assert.deepEqual(params, {
    threadId: "thread-42",
    expectedTurnId: "turn-42",
    input: [
      {
        type: "text",
        text: "Continue.",
        text_elements: []
      }
    ]
  });
});

test("callCodexTurnSteer sends protocol-correct turn/steer RPC params", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const codexRuntime = {
    async call(method: string, params?: unknown): Promise<unknown> {
      calls.push({ method, params: params ?? null });
      return {
        turnId: "turn-42"
      };
    }
  };

  await callCodexTurnSteer(codexRuntime as never, {
    sessionId: "thread-42",
    turnId: "turn-42",
    input: "Continue."
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "turn/steer");
  assert.deepEqual(calls[0]?.params, {
    threadId: "thread-42",
    expectedTurnId: "turn-42",
    input: [
      {
        type: "text",
        text: "Continue.",
        text_elements: []
      }
    ]
  });
});
