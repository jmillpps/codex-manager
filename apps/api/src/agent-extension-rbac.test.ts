import assert from "node:assert/strict";
import test from "node:test";
import { SignJWT } from "jose";
import { resolveRequestRole, roleAllowed } from "./agent-extension-rbac.js";

test("resolveRequestRole in disabled mode allows loopback caller as admin", async () => {
  const resolved = await resolveRequestRole({
    mode: "disabled",
    headers: {},
    requestIp: "127.0.0.1"
  });

  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.role, "admin");
  }
});

test("resolveRequestRole in disabled mode rejects non-loopback caller", async () => {
  const resolved = await resolveRequestRole({
    mode: "disabled",
    headers: {},
    requestIp: "203.0.113.10"
  });

  assert.equal(resolved.ok, false);
  if (!resolved.ok) {
    assert.equal(resolved.statusCode, 403);
    assert.equal(resolved.payload.code, "rbac_disabled_remote_forbidden");
  }
});

test("resolveRequestRole in header mode enforces role header validation", async () => {
  const headerSecret = "header-shared-secret";
  const missing = await resolveRequestRole({
    mode: "header",
    headers: {},
    header: {
      secret: headerSecret
    }
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.statusCode, 401);
    assert.equal(missing.payload.code, "missing_header_token");
  }

  const invalidToken = await resolveRequestRole({
    mode: "header",
    headers: {
      "x-codex-rbac-token": "wrong-token"
    },
    header: {
      secret: headerSecret
    }
  });
  assert.equal(invalidToken.ok, false);
  if (!invalidToken.ok) {
    assert.equal(invalidToken.statusCode, 401);
    assert.equal(invalidToken.payload.code, "invalid_header_token");
  }

  const invalid = await resolveRequestRole({
    mode: "header",
    headers: {
      "x-codex-rbac-token": headerSecret,
      "x-codex-role": "guest"
    },
    header: {
      secret: headerSecret
    }
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.payload.code, "invalid_role");
  }

  const valid = await resolveRequestRole({
    mode: "header",
    headers: {
      "x-codex-rbac-token": headerSecret,
      "x-codex-role": "owner",
      "x-codex-actor": "ops-user"
    },
    header: {
      secret: headerSecret
    }
  });
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.role, "owner");
    assert.equal(valid.actorId, "ops-user");
  }
});

test("resolveRequestRole in jwt mode validates bearer token claims", async () => {
  const secret = "rbac-jwt-test-secret";
  const signingKey = new TextEncoder().encode(secret);
  const token = await new SignJWT({
    role: "admin",
    sub: "ops-user"
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .setIssuer("codex-manager-test")
    .setAudience("codex-manager")
    .sign(signingKey);

  const missing = await resolveRequestRole({
    mode: "jwt",
    headers: {},
    jwt: {
      secret,
      issuer: "codex-manager-test",
      audience: "codex-manager",
      roleClaim: "role",
      actorClaim: "sub"
    }
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.statusCode, 401);
    assert.equal(missing.payload.code, "missing_bearer_token");
  }

  const invalid = await resolveRequestRole({
    mode: "jwt",
    headers: {
      authorization: "Bearer not-a-token"
    },
    jwt: {
      secret,
      issuer: "codex-manager-test",
      audience: "codex-manager",
      roleClaim: "role",
      actorClaim: "sub"
    }
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.statusCode, 401);
    assert.equal(invalid.payload.code, "invalid_bearer_token");
  }

  const valid = await resolveRequestRole({
    mode: "jwt",
    headers: {
      authorization: `Bearer ${token}`
    },
    jwt: {
      secret,
      issuer: "codex-manager-test",
      audience: "codex-manager",
      roleClaim: "role",
      actorClaim: "sub"
    }
  });
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.role, "admin");
    assert.equal(valid.actorId, "ops-user");
  }
});

test("roleAllowed applies allowed-role matrix", () => {
  assert.equal(roleAllowed("member", ["member", "admin"]), true);
  assert.equal(roleAllowed("member", ["admin", "owner"]), false);
  assert.equal(roleAllowed("system", ["admin", "owner", "system"]), true);
});
