import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const port = 33000 + Math.floor(Math.random() * 1000);
const host = "127.0.0.1";
const apiBase = `http://${host}:${port}/api`;
const runtimeId = `api-contract-${Date.now()}`;
const dataDir = path.join(root, ".data", runtimeId);
const codexHome = path.join(dataDir, "codex-home");
const supplementalTranscriptPath = path.join(dataDir, "supplemental-transcript.json");
const sessionMetadataPath = path.join(dataDir, "session-metadata.json");

function makeJsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, body };
}

async function request(pathname, init = {}) {
  const response = await fetch(`${apiBase}${pathname}`, init);
  const text = await response.text();
  let body;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return makeJsonResponse(response.status, body);
}

async function waitForHealth(timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const health = await request("/health");
      if (health.status === 200 && health.body?.status === "ok") {
        return;
      }
    } catch {
      // ignore until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`timed out waiting for API health on ${apiBase}`);
}

async function waitForSessionContext(sessionId, timeoutMs = 60_000) {
  const started = Date.now();
  const encodedSessionId = encodeURIComponent(sessionId);

  while (Date.now() - started < timeoutMs) {
    const detail = await request(`/sessions/${encodedSessionId}`);
    if (detail.status === 200) {
      const transcript = Array.isArray(detail.body?.transcript) ? detail.body.transcript : [];
      const hasChatContext = transcript.some(
        (entry) =>
          (entry?.role === "user" || entry?.role === "assistant") &&
          typeof entry?.content === "string" &&
          entry.content.trim().length > 0
      );

      if (hasChatContext) {
        return true;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

function runNodeScript(scriptPath, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [scriptPath], {
      cwd: root,
      env: {
        ...process.env,
        ...env
      },
      stdio: "inherit"
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`script ${scriptPath} failed with code ${code}`));
    });

    child.on("error", reject);
  });
}

function startApiProcess() {
  return spawn("pnpm", ["--filter", "@repo/api", "exec", "tsx", "src/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      DATA_DIR: dataDir,
      CODEX_HOME: codexHome,
      LOG_LEVEL: "warn",
      DEFAULT_APPROVAL_POLICY: "on-failure"
    },
    stdio: "inherit"
  });
}

async function stopApiProcess(processHandle) {
  if (!processHandle) {
    return;
  }

  if (!processHandle.killed) {
    processHandle.kill("SIGTERM");
  }

  await new Promise((resolve) => setTimeout(resolve, 1500));

  if (processHandle.exitCode === null && !processHandle.killed) {
    processHandle.kill("SIGKILL");
  }
}

async function appendSyntheticSupplementalEntries(threadId, entries) {
  let parsed;
  try {
    const raw = await readFile(supplementalTranscriptPath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  const normalized =
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    parsed.byThreadId &&
    typeof parsed.byThreadId === "object" &&
    !Array.isArray(parsed.byThreadId)
      ? parsed
      : { version: 1, sequence: 1, byThreadId: {} };

  const currentSequence = Number.isFinite(normalized.sequence) && normalized.sequence > 0 ? Math.floor(normalized.sequence) : 1;
  let nextSequence = currentSequence;
  const existing = Array.isArray(normalized.byThreadId[threadId]) ? normalized.byThreadId[threadId] : [];

  const appended = entries.map((entry) => {
    const sequence = nextSequence;
    nextSequence += 1;
    return {
      sequence,
      entry
    };
  });

  normalized.byThreadId[threadId] = [...existing, ...appended];
  normalized.sequence = nextSequence;
  normalized.version = 1;

  await writeFile(supplementalTranscriptPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

async function readSessionMetadata() {
  try {
    const raw = await readFile(sessionMetadataPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {
      sessionControlsById: {},
      sessionApprovalPolicyById: {}
    };
  }
}

async function injectSessionControlMetadata(sessionId, controls, approvalPolicy) {
  const metadata = await readSessionMetadata();
  const next = {
    ...metadata,
    sessionControlsById:
      metadata && typeof metadata.sessionControlsById === "object" && metadata.sessionControlsById !== null
        ? { ...metadata.sessionControlsById }
        : {},
    sessionApprovalPolicyById:
      metadata && typeof metadata.sessionApprovalPolicyById === "object" && metadata.sessionApprovalPolicyById !== null
        ? { ...metadata.sessionApprovalPolicyById }
        : {}
  };

  next.sessionControlsById[sessionId] = controls;
  next.sessionApprovalPolicyById[sessionId] = approvalPolicy;
  await writeFile(sessionMetadataPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

async function assertNoStoredSessionControlEntries(sessionId, reason) {
  const metadata = await readSessionMetadata();
  assert.equal(
    Object.prototype.hasOwnProperty.call(metadata?.sessionControlsById ?? {}, sessionId),
    false,
    `unexpected sessionControlsById entry for ${sessionId} (${reason})`
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(metadata?.sessionApprovalPolicyById ?? {}, sessionId),
    false,
    `unexpected sessionApprovalPolicyById entry for ${sessionId} (${reason})`
  );
}

async function main() {
  await mkdir(codexHome, { recursive: true });
  let apiProcess = startApiProcess();

  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) {
      return;
    }
    cleaned = true;

    await stopApiProcess(apiProcess);

    await rm(dataDir, { recursive: true, force: true });
  };

  const onSignal = async () => {
    await cleanup();
    process.exit(1);
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    await waitForHealth();

    const capabilities = await request("/capabilities");
    assert.equal(capabilities.status, 200);
    assert.equal(typeof capabilities.body?.methods, "object");

    const collaborationModes = await request("/collaboration/modes?limit=5");
    assert.ok(
      collaborationModes.status === 200 || collaborationModes.status === 501,
      `unexpected /collaboration/modes status ${collaborationModes.status}`
    );

    const createSession = await request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(createSession.status, 200);
    const sessionId = createSession.body?.session?.sessionId;
    assert.equal(typeof sessionId, "string");
    assert.equal(createSession.body?.session?.approvalPolicy, "on-failure");
    assert.equal(createSession.body?.session?.sessionControls?.approvalPolicy, "on-failure");

    const controlsAfterCreate = await request(`/sessions/${encodeURIComponent(sessionId)}/session-controls`);
    assert.equal(controlsAfterCreate.status, 200);
    assert.equal(controlsAfterCreate.body?.controls?.approvalPolicy, "on-failure");
    assert.equal(controlsAfterCreate.body?.defaults?.approvalPolicy, "on-failure");

    const missingSessionId = "0199dead-beef-7bad-babe-123456789abc";
    const invalidSessionId = "not-a-valid-thread-id";

    const missingApprovalPolicy = await request(`/sessions/${encodeURIComponent(missingSessionId)}/approval-policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalPolicy: "on-failure" })
    });
    assert.equal(missingApprovalPolicy.status, 404);

    const missingMessageSend = await request(`/sessions/${encodeURIComponent(missingSessionId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "orphan-write-missing-session", effort: "minimal" })
    });
    assert.equal(missingMessageSend.status, 404);
    await assertNoStoredSessionControlEntries(missingSessionId, "missing-session write attempts");

    const invalidControlsGet = await request(`/sessions/${encodeURIComponent(invalidSessionId)}/session-controls`);
    assert.equal(invalidControlsGet.status, 404);

    const invalidControlsPost = await request(`/sessions/${encodeURIComponent(invalidSessionId)}/session-controls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "session",
        controls: {
          model: null,
          approvalPolicy: "on-failure",
          networkAccess: "restricted",
          filesystemSandbox: "read-only"
        },
        actor: "api-contract",
        source: "api-contract"
      })
    });
    assert.equal(invalidControlsPost.status, 404);

    const invalidApprovalPolicy = await request(`/sessions/${encodeURIComponent(invalidSessionId)}/approval-policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalPolicy: "on-failure" })
    });
    assert.equal(invalidApprovalPolicy.status, 404);

    const invalidMessageSend = await request(`/sessions/${encodeURIComponent(invalidSessionId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "orphan-write-invalid-session", effort: "minimal" })
    });
    assert.equal(invalidMessageSend.status, 404);
    await assertNoStoredSessionControlEntries(invalidSessionId, "invalid-session write attempts");

    const setLegacyOnFailure = await request(`/sessions/${encodeURIComponent(sessionId)}/approval-policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalPolicy: "on-failure" })
    });
    assert.equal(setLegacyOnFailure.status, 200);
    assert.equal(setLegacyOnFailure.body?.approvalPolicy, "on-failure");

    const applySessionControlsOnFailure = await request(`/sessions/${encodeURIComponent(sessionId)}/session-controls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "session",
        controls: {
          model: null,
          approvalPolicy: "on-failure",
          networkAccess: "restricted",
          filesystemSandbox: "read-only"
        },
        actor: "api-contract",
        source: "api-contract"
      })
    });
    assert.equal(applySessionControlsOnFailure.status, 200);
    assert.equal(applySessionControlsOnFailure.body?.controls?.approvalPolicy, "on-failure");
    assert.equal(applySessionControlsOnFailure.body?.applied?.approvalPolicy, "on-failure");

    const sessionsAfterCreate = await request("/sessions?archived=false&limit=200");
    assert.equal(sessionsAfterCreate.status, 200);
    const activeCountAfterCreate = Array.isArray(sessionsAfterCreate.body?.data) ? sessionsAfterCreate.body.data.length : -1;
    assert.ok(activeCountAfterCreate >= 1, "expected at least one active session after create");

    const projectCreate = await request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `api-contract-project-${Date.now()}`,
        workingDirectory: root
      })
    });
    assert.equal(projectCreate.status, 200);
    const projectId = projectCreate.body?.project?.projectId;
    const orchestratorSessionId = projectCreate.body?.orchestrationSession?.sessionId;
    assert.equal(typeof projectId, "string");
    assert.equal(typeof orchestratorSessionId, "string");

    const sessionsAfterProjectCreate = await request("/sessions?archived=false&limit=200");
    assert.equal(sessionsAfterProjectCreate.status, 200);
    assert.equal(
      Array.isArray(sessionsAfterProjectCreate.body?.data) &&
        sessionsAfterProjectCreate.body.data.some((entry) => entry?.sessionId === orchestratorSessionId),
      false,
      "system-owned orchestrator session should be hidden from session list"
    );

    const systemOwnedRead = await request(`/sessions/${encodeURIComponent(orchestratorSessionId)}`);
    assert.equal(systemOwnedRead.status, 403);
    assert.equal(systemOwnedRead.body?.code, "system_session");

    const systemOwnedMessage = await request(`/sessions/${encodeURIComponent(orchestratorSessionId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "should fail" })
    });
    assert.equal(systemOwnedMessage.status, 403);
    assert.equal(systemOwnedMessage.body?.code, "system_session");

    const systemOwnedDelete = await request(`/sessions/${encodeURIComponent(orchestratorSessionId)}`, {
      method: "DELETE"
    });
    assert.equal(systemOwnedDelete.status, 403);
    assert.equal(systemOwnedDelete.body?.code, "system_session");

    const projectDelete = await request(`/projects/${encodeURIComponent(projectId)}`, {
      method: "DELETE"
    });
    assert.equal(projectDelete.status, 200);

    const setLegacyBackOnFailure = await request(`/sessions/${encodeURIComponent(sessionId)}/approval-policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalPolicy: "on-failure" })
    });
    assert.equal(setLegacyBackOnFailure.status, 200);
    assert.equal(setLegacyBackOnFailure.body?.approvalPolicy, "on-failure");

    const sendSeedMessage = await request(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Seed context for suggested reply effort contract coverage.",
        effort: "minimal",
        approvalPolicy: "on-failure"
      })
    });
    assert.equal(sendSeedMessage.status, 202);

    const controlsAfterSend = await request(`/sessions/${encodeURIComponent(sessionId)}/session-controls`);
    assert.equal(controlsAfterSend.status, 200);
    assert.equal(controlsAfterSend.body?.controls?.approvalPolicy, "on-failure");

    const hasSuggestionContext = await waitForSessionContext(sessionId);

    const queuedSuggestReplyOne = await request(`/sessions/${encodeURIComponent(sessionId)}/suggested-reply/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(hasSuggestionContext ? { effort: "minimal" } : { draft: "Please improve this sentence.", effort: "minimal" })
    });
    assert.equal(queuedSuggestReplyOne.status, 202);
    assert.equal(queuedSuggestReplyOne.body?.status, "queued");
    assert.equal(typeof queuedSuggestReplyOne.body?.jobId, "string");
    assert.equal(queuedSuggestReplyOne.body?.dedupe, "enqueued");

    const queuedSuggestReplyTwo = await request(`/sessions/${encodeURIComponent(sessionId)}/suggested-reply/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(hasSuggestionContext ? { effort: "minimal" } : { draft: "Please improve this sentence.", effort: "minimal" })
    });
    assert.equal(queuedSuggestReplyTwo.status, 202);
    assert.equal(queuedSuggestReplyTwo.body?.status, "queued");
    assert.equal(typeof queuedSuggestReplyTwo.body?.jobId, "string");
    assert.equal(queuedSuggestReplyTwo.body?.dedupe, "already_queued");
    assert.equal(
      queuedSuggestReplyTwo.body?.jobId,
      queuedSuggestReplyOne.body?.jobId,
      "single-flight dedupe should return the existing suggest job"
    );

    const suggestedReply = await request(`/sessions/${encodeURIComponent(sessionId)}/suggested-reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(hasSuggestionContext ? { effort: "minimal" } : { draft: "Please improve this sentence.", effort: "minimal" })
    });
    assert.ok(suggestedReply.status === 200 || suggestedReply.status === 202);

    if (suggestedReply.status === 200) {
      assert.equal(typeof suggestedReply.body?.suggestion, "string");
      assert.ok(suggestedReply.body.suggestion.length > 0);

      if (hasSuggestionContext) {
        assert.ok(
          suggestedReply.body?.status === "ok" || suggestedReply.body?.status === "fallback",
          `unexpected suggested-reply status with context: ${suggestedReply.body?.status}`
        );
      } else {
        assert.equal(suggestedReply.body?.status, "fallback");
      }
    } else {
      assert.equal(suggestedReply.body?.status, "queued");
      assert.equal(typeof suggestedReply.body?.jobId, "string");
    }

    // Risk closure: synthetic transcript dedupe should drop synthetic entries that duplicate canonical
    // same-turn rows while preserving distinct synthetic supplemental entries.
    const detailBeforeRestart = await request(`/sessions/${encodeURIComponent(sessionId)}`);
    assert.equal(detailBeforeRestart.status, 200);
    const transcriptBeforeRestart = Array.isArray(detailBeforeRestart.body?.transcript) ? detailBeforeRestart.body.transcript : [];
    const canonicalEntry = transcriptBeforeRestart.find((entry) => {
      const messageId = typeof entry?.messageId === "string" ? entry.messageId : "";
      const isSynthetic = /^item-\d+$/i.test(messageId);
      const hasText = typeof entry?.content === "string" && entry.content.trim().length > 0;
      const hasTurnId = typeof entry?.turnId === "string" && entry.turnId.trim().length > 0;
      return !isSynthetic && hasText && hasTurnId;
    });
    assert.ok(canonicalEntry, "expected at least one canonical transcript entry before dedupe test");

    const syntheticSeed = Date.now();
    const duplicateSyntheticMessageId = `item-${syntheticSeed + 1000}`;
    const distinctSyntheticMessageId = `item-${syntheticSeed + 1001}`;
    const baseStartedAt =
      Number.isFinite(canonicalEntry.startedAt) && canonicalEntry.startedAt > 0
        ? canonicalEntry.startedAt
        : Date.now();
    await appendSyntheticSupplementalEntries(sessionId, [
      {
        messageId: duplicateSyntheticMessageId,
        turnId: canonicalEntry.turnId,
        role: canonicalEntry.role,
        type: canonicalEntry.type,
        content: canonicalEntry.content,
        status: "complete",
        startedAt: baseStartedAt,
        completedAt: baseStartedAt + 1
      },
      {
        messageId: distinctSyntheticMessageId,
        turnId: canonicalEntry.turnId,
        role: canonicalEntry.role,
        type: canonicalEntry.type,
        content: `[synthetic-distinct] ${canonicalEntry.content}`,
        status: "complete",
        startedAt: baseStartedAt,
        completedAt: baseStartedAt + 2
      }
    ]);

    const deletedSession = await request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(deletedSession.status, 200);
    const deletedSessionId = deletedSession.body?.session?.sessionId;
    assert.equal(typeof deletedSessionId, "string");

    const deletedSessionDelete = await request(`/sessions/${encodeURIComponent(deletedSessionId)}`, {
      method: "DELETE"
    });
    assert.equal(deletedSessionDelete.status, 200);

    const deletedPolicyBeforeRestart = await request(`/sessions/${encodeURIComponent(deletedSessionId)}/approval-policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalPolicy: "on-failure" })
    });
    assert.equal(deletedPolicyBeforeRestart.status, 410);

    const deletedMessageBeforeRestart = await request(`/sessions/${encodeURIComponent(deletedSessionId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "deleted-before-restart", effort: "minimal" })
    });
    assert.equal(deletedMessageBeforeRestart.status, 410);
    await assertNoStoredSessionControlEntries(deletedSessionId, "deleted-session before restart");

    await stopApiProcess(apiProcess);
    apiProcess = startApiProcess();
    await waitForHealth();

    const detailAfterRestart = await request(`/sessions/${encodeURIComponent(sessionId)}`);
    assert.equal(detailAfterRestart.status, 200);
    const transcriptAfterRestart = Array.isArray(detailAfterRestart.body?.transcript) ? detailAfterRestart.body.transcript : [];
    assert.equal(
      transcriptAfterRestart.some((entry) => entry?.messageId === duplicateSyntheticMessageId),
      false,
      "synthetic duplicate entry should be removed when canonical same-turn match exists"
    );
    assert.equal(
      transcriptAfterRestart.some((entry) => entry?.messageId === distinctSyntheticMessageId),
      true,
      "distinct synthetic entry should remain in transcript"
    );

    const deletedPolicyAfterRestart = await request(`/sessions/${encodeURIComponent(deletedSessionId)}/approval-policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalPolicy: "on-failure" })
    });
    assert.equal(deletedPolicyAfterRestart.status, 404);

    const deletedMessageAfterRestart = await request(`/sessions/${encodeURIComponent(deletedSessionId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "deleted-after-restart", effort: "minimal" })
    });
    assert.equal(deletedMessageAfterRestart.status, 404);
    await assertNoStoredSessionControlEntries(deletedSessionId, "deleted-session after restart");

    const staleMetadataSessionId = "0199dead-beef-7bad-babe-feedfeedfeed";
    await injectSessionControlMetadata(
      staleMetadataSessionId,
      {
        model: null,
        approvalPolicy: "on-failure",
        networkAccess: "restricted",
        filesystemSandbox: "read-only"
      },
      "on-failure"
    );
    const metadataAfterInjection = await readSessionMetadata();
    assert.equal(
      Object.prototype.hasOwnProperty.call(metadataAfterInjection?.sessionControlsById ?? {}, staleMetadataSessionId),
      true
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(metadataAfterInjection?.sessionApprovalPolicyById ?? {}, staleMetadataSessionId),
      true
    );

    await stopApiProcess(apiProcess);
    apiProcess = startApiProcess();
    await waitForHealth();

    await assertNoStoredSessionControlEntries(staleMetadataSessionId, "startup stale metadata prune");

    const suggestedReplyInvalidEffort = await request(`/sessions/${encodeURIComponent(sessionId)}/suggested-reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft: "Please improve this sentence.", effort: "invalid" })
    });
    assert.equal(suggestedReplyInvalidEffort.status, 400);

    const sessionsAfterSuggest = await request("/sessions?archived=false&limit=200");
    assert.equal(sessionsAfterSuggest.status, 200);
    const activeCountAfterSuggest = Array.isArray(sessionsAfterSuggest.body?.data) ? sessionsAfterSuggest.body.data.length : -1;
    assert.ok(activeCountAfterSuggest >= activeCountAfterCreate);

    const noContextSessionCreate = await request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(noContextSessionCreate.status, 200);
    const noContextSessionId = noContextSessionCreate.body?.session?.sessionId;
    assert.equal(typeof noContextSessionId, "string");

    const suggestedReplyNoContext = await request(`/sessions/${encodeURIComponent(noContextSessionId)}/suggested-reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.ok(suggestedReplyNoContext.status === 409 || suggestedReplyNoContext.status === 202);
    if (suggestedReplyNoContext.status === 409) {
      assert.equal(suggestedReplyNoContext.body?.status, "no_context");
    } else {
      assert.equal(suggestedReplyNoContext.body?.status, "queued");
      assert.equal(typeof suggestedReplyNoContext.body?.jobId, "string");
    }

    const invalidRollback = await request(`/sessions/${encodeURIComponent(sessionId)}/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ numTurns: 0 })
    });
    assert.equal(invalidRollback.status, 400);
    assert.equal(invalidRollback.body?.code, "invalid_request");

    const invalidToolDecision = await request("/tool-input/not-a-real-id/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "invalid" })
    });
    assert.equal(invalidToolDecision.status, 400);

    const missingToolDecision = await request("/tool-input/not-a-real-id/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "cancel" })
    });
    assert.equal(missingToolDecision.status, 404);

    const invalidAccountCancel = await request("/account/login/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(invalidAccountCancel.status, 400);

    const invalidConfigBatch = await request("/config/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ edits: [] })
    });
    assert.equal(invalidConfigBatch.status, 400);

    const invalidSkillsConfig = await request("/skills/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true })
    });
    assert.equal(invalidSkillsConfig.status, 400);

    await runNodeScript(path.join(root, "scripts", "smoke-runtime.mjs"), {
      API_BASE: apiBase,
      SMOKE_TIMEOUT_MS: "180000"
    });

    console.log("API_CONTRACT_OK");
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await cleanup();
  }
}

await main();
