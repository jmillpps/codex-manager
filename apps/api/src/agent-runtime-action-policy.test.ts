import assert from "node:assert/strict";
import test from "node:test";
import {
  hashAgentActionSignature,
  isReplayCacheableActionStatus,
  normalizeAgentActionSignature,
  normalizeActionTranscriptDetails,
  shouldPreserveSuccessfulSupplementalEntry
} from "./agent-runtime-action-policy.js";

test("replay cache only stores terminal deterministic action statuses", () => {
  assert.equal(isReplayCacheableActionStatus("performed"), true);
  assert.equal(isReplayCacheableActionStatus("already_resolved"), true);
  assert.equal(isReplayCacheableActionStatus("not_eligible"), true);
  assert.equal(isReplayCacheableActionStatus("forbidden"), true);

  assert.equal(isReplayCacheableActionStatus("conflict"), false);
  assert.equal(isReplayCacheableActionStatus("invalid"), false);
  assert.equal(isReplayCacheableActionStatus("failed"), false);
});

test("action transcript details normalize object payloads to JSON text", () => {
  assert.equal(normalizeActionTranscriptDetails(undefined), null);
  assert.equal(normalizeActionTranscriptDetails(null), null);
  assert.equal(normalizeActionTranscriptDetails("details text"), "details text");
  assert.equal(
    normalizeActionTranscriptDetails({ anchorItemId: "item-1", approvalId: "approval-1" }),
    '{"anchorItemId":"item-1","approvalId":"approval-1"}'
  );
});

test("supplemental reconciliation preserves successful complete entries on error fallback", () => {
  assert.equal(
    shouldPreserveSuccessfulSupplementalEntry({
      existingStatus: "complete",
      terminalStatus: "error"
    }),
    true
  );
  assert.equal(
    shouldPreserveSuccessfulSupplementalEntry({
      existingStatus: "complete",
      terminalStatus: "canceled"
    }),
    true
  );
  assert.equal(
    shouldPreserveSuccessfulSupplementalEntry({
      existingStatus: "streaming",
      terminalStatus: "error"
    }),
    false
  );
  assert.equal(
    shouldPreserveSuccessfulSupplementalEntry({
      existingStatus: "complete",
      terminalStatus: "complete"
    }),
    false
  );
});

test("agent action signature normalization is stable across object key order", () => {
  const left = normalizeAgentActionSignature({
    actionType: "transcript.upsert",
    payload: {
      sessionId: "s1",
      entry: {
        turnId: "t1",
        messageId: "m1",
        content: "hello",
        type: "fileChange.explainability",
        role: "system",
        status: "complete"
      }
    },
    scope: {
      sourceSessionId: "s1",
      turnId: "t1"
    }
  });

  const right = normalizeAgentActionSignature({
    actionType: "transcript.upsert",
    payload: {
      entry: {
        status: "complete",
        role: "system",
        type: "fileChange.explainability",
        content: "hello",
        messageId: "m1",
        turnId: "t1"
      },
      sessionId: "s1"
    },
    scope: {
      sourceSessionId: "s1",
      turnId: "t1"
    }
  });

  assert.equal(left, right);
});

test("agent action signature normalization is scope-sensitive for project/session/turn", () => {
  const baseline = normalizeAgentActionSignature({
    actionType: "queue.enqueue",
    payload: {
      type: "agent_instruction",
      projectId: "p1",
      payload: {
        jobKind: "file_change_supervisor_review"
      }
    },
    scope: {
      projectId: "p1",
      sourceSessionId: "s1",
      turnId: "t1"
    }
  });

  const differentProject = normalizeAgentActionSignature({
    actionType: "queue.enqueue",
    payload: {
      type: "agent_instruction",
      projectId: "p1",
      payload: {
        jobKind: "file_change_supervisor_review"
      }
    },
    scope: {
      projectId: "p2",
      sourceSessionId: "s1",
      turnId: "t1"
    }
  });

  const differentSession = normalizeAgentActionSignature({
    actionType: "queue.enqueue",
    payload: {
      type: "agent_instruction",
      projectId: "p1",
      payload: {
        jobKind: "file_change_supervisor_review"
      }
    },
    scope: {
      projectId: "p1",
      sourceSessionId: "s2",
      turnId: "t1"
    }
  });

  assert.notEqual(baseline, differentProject);
  assert.notEqual(baseline, differentSession);
});

test("agent action signature hash is deterministic and suffix-sensitive", () => {
  const base = "queue.enqueue:p1:s1:t1:{\"a\":1,\"b\":2}";
  const same = "queue.enqueue:p1:s1:t1:{\"a\":1,\"b\":2}";
  const differentSuffix = "queue.enqueue:p1:s1:t1:{\"a\":1,\"b\":3}";

  const baseHash = hashAgentActionSignature(base);
  const sameHash = hashAgentActionSignature(same);
  const differentHash = hashAgentActionSignature(differentSuffix);

  assert.equal(baseHash, sameHash);
  assert.notEqual(baseHash, differentHash);
  assert.equal(baseHash.length, 64);
});
