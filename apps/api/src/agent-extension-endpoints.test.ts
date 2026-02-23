import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SignJWT } from "jose";

type JsonResponse = {
  status: number;
  body: unknown;
};

const HEADER_SECRET = "agent-extension-header-test-secret";

async function requestJson(baseUrl: string, pathname: string, init?: RequestInit): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return {
    status: response.status,
    body
  };
}

async function waitForHealth(baseUrl: string, timeoutMs = 90_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await requestJson(baseUrl, "/health");
      if (response.status === 200) {
        return;
      }
    } catch {
      // retry until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("timed out waiting for API health");
}

function startApiProcess(input: {
  rootDir: string;
  dataDir: string;
  port: number;
  envOverrides?: Record<string, string>;
}): ChildProcess {
  return spawn("pnpm", ["--filter", "@repo/api", "exec", "tsx", "src/index.ts"], {
    cwd: input.rootDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(input.port),
      DATA_DIR: input.dataDir,
      CODEX_HOME: path.join(input.dataDir, "codex-home"),
      LOG_LEVEL: "warn",
      AGENT_EXTENSION_RBAC_MODE: "header",
      AGENT_EXTENSION_RBAC_HEADER_SECRET: HEADER_SECRET,
      AGENT_EXTENSION_TRUST_MODE: "warn",
      ...input.envOverrides
    },
    stdio: "ignore",
    detached: true
  });
}

function signalApiProcessTree(processHandle: ChildProcess, signal: NodeJS.Signals): void {
  const pid = typeof processHandle.pid === "number" ? processHandle.pid : null;
  if (pid && Number.isInteger(pid) && pid > 1) {
    if (process.platform === "win32") {
      try {
        const args = ["/PID", String(pid), "/T"];
        if (signal === "SIGKILL") {
          args.push("/F");
        }
        spawnSync("taskkill", args, { stdio: "ignore" });
        return;
      } catch {
        // fall through to direct child signaling
      }
    }

    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // fall through to direct child signaling
    }
  }

  try {
    processHandle.kill(signal);
  } catch {
    // ignore signaling errors; waitForExit will settle on timeout
  }
}

async function stopApiProcess(processHandle: ChildProcess): Promise<void> {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    signalApiProcessTree(processHandle, "SIGTERM");
    signalApiProcessTree(processHandle, "SIGKILL");
    return;
  }

  const waitForExit = (timeoutMs: number) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        processHandle.off("exit", onExit);
        resolve();
      };
      const onExit = (): void => {
        finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      processHandle.on("exit", onExit);
    });

  signalApiProcessTree(processHandle, "SIGTERM");
  await waitForExit(1_500);
  if (processHandle.exitCode === null && processHandle.signalCode === null) {
    signalApiProcessTree(processHandle, "SIGKILL");
    await waitForExit(1_500);
  }
}

test("extension lifecycle endpoints enforce RBAC and write audit records", async () => {
  const rootDir = path.resolve(process.cwd(), "..", "..");
  const dataDir = await mkdtemp(path.join(tmpdir(), "agent-extension-endpoint-test-"));
  const port = 36000 + Math.floor(Math.random() * 500);
  const baseUrl = `http://127.0.0.1:${port}/api`;
  const processHandle = startApiProcess({ rootDir, dataDir, port });

  try {
    await waitForHealth(baseUrl);

    const missingRole = await requestJson(baseUrl, "/agents/extensions");
    assert.equal(missingRole.status, 401);
    assert.equal((missingRole.body as { code?: string }).code, "missing_header_token");

    const listWithMember = await requestJson(baseUrl, "/agents/extensions", {
      headers: {
        "x-codex-rbac-token": HEADER_SECRET,
        "x-codex-role": "member",
        "x-codex-actor": "member-user"
      }
    });
    assert.equal(listWithMember.status, 200);
    assert.equal((listWithMember.body as { status?: string }).status, "ok");
    assert.ok(Array.isArray((listWithMember.body as { modules?: unknown }).modules));

    const reloadForbidden = await requestJson(baseUrl, "/agents/extensions/reload", {
      method: "POST",
      headers: {
        "x-codex-rbac-token": HEADER_SECRET,
        "x-codex-role": "member",
        "x-codex-actor": "member-user"
      }
    });
    assert.equal(reloadForbidden.status, 403);
    assert.equal((reloadForbidden.body as { code?: string }).code, "insufficient_role");

    const removedActionEndpoint = await requestJson(baseUrl, "/agents/actions/execute", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        kind: "action_request",
        actionType: "transcript.upsert",
        payload: {}
      })
    });
    assert.equal(removedActionEndpoint.status, 404);

    const reloadAdmin = await requestJson(baseUrl, "/agents/extensions/reload", {
      method: "POST",
      headers: {
        "x-codex-rbac-token": HEADER_SECRET,
        "x-codex-role": "admin",
        "x-codex-actor": "ops-user"
      }
    });
    assert.ok(reloadAdmin.status === 200 || reloadAdmin.status === 400 || reloadAdmin.status === 409);

    const auditPath = path.join(dataDir, "agent-extension-audit.json");
    const auditRaw = await readFile(auditPath, "utf8");
    const auditParsed = JSON.parse(auditRaw) as { version?: number; records?: Array<{ result?: string }> };
    assert.equal(auditParsed.version, 1);
    assert.ok(Array.isArray(auditParsed.records));
    assert.ok((auditParsed.records ?? []).some((record) => record.result === "forbidden"));
    assert.ok((auditParsed.records ?? []).some((record) => record.result === "success" || record.result === "failed"));
  } finally {
    await stopApiProcess(processHandle);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("extension lifecycle endpoints enforce JWT RBAC roles", async () => {
  const rootDir = path.resolve(process.cwd(), "..", "..");
  const dataDir = await mkdtemp(path.join(tmpdir(), "agent-extension-endpoint-jwt-test-"));
  const port = 36500 + Math.floor(Math.random() * 500);
  const baseUrl = `http://127.0.0.1:${port}/api`;
  const jwtSecret = "agent-extension-jwt-test-secret";
  const issuer = "codex-manager-test";
  const audience = "codex-manager";
  const signingKey = new TextEncoder().encode(jwtSecret);
  const processHandle = startApiProcess({
    rootDir,
    dataDir,
    port,
    envOverrides: {
      AGENT_EXTENSION_RBAC_MODE: "jwt",
      AGENT_EXTENSION_RBAC_JWT_SECRET: jwtSecret,
      AGENT_EXTENSION_RBAC_JWT_ISSUER: issuer,
      AGENT_EXTENSION_RBAC_JWT_AUDIENCE: audience
    }
  });

  try {
    await waitForHealth(baseUrl);

    const missingToken = await requestJson(baseUrl, "/agents/extensions");
    assert.equal(missingToken.status, 401);
    assert.equal((missingToken.body as { code?: string }).code, "missing_bearer_token");

    const memberToken = await new SignJWT({
      role: "member",
      sub: "member-user"
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .setIssuer(issuer)
      .setAudience(audience)
      .sign(signingKey);
    const adminToken = await new SignJWT({
      role: "admin",
      sub: "admin-user"
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .setIssuer(issuer)
      .setAudience(audience)
      .sign(signingKey);

    const listWithMember = await requestJson(baseUrl, "/agents/extensions", {
      headers: {
        authorization: `Bearer ${memberToken}`
      }
    });
    assert.equal(listWithMember.status, 200);
    assert.equal((listWithMember.body as { status?: string }).status, "ok");

    const reloadForbidden = await requestJson(baseUrl, "/agents/extensions/reload", {
      method: "POST",
      headers: {
        authorization: `Bearer ${memberToken}`
      }
    });
    assert.equal(reloadForbidden.status, 403);
    assert.equal((reloadForbidden.body as { code?: string }).code, "insufficient_role");

    const reloadAdmin = await requestJson(baseUrl, "/agents/extensions/reload", {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`
      }
    });
    assert.ok(reloadAdmin.status === 200 || reloadAdmin.status === 400 || reloadAdmin.status === 409);
  } finally {
    await stopApiProcess(processHandle);
    await rm(dataDir, { recursive: true, force: true });
  }
});
