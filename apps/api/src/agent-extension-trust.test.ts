import assert from "node:assert/strict";
import test from "node:test";
import { evaluateActionCapability, evaluateExtensionTrust, normalizeTrustMode } from "./agent-extension-trust.js";

test("normalizeTrustMode defaults to warn for invalid values", () => {
  assert.equal(normalizeTrustMode(undefined), "warn");
  assert.equal(normalizeTrustMode("disabled"), "disabled");
  assert.equal(normalizeTrustMode("warn"), "warn");
  assert.equal(normalizeTrustMode("enforced"), "enforced");
  assert.equal(normalizeTrustMode("invalid"), "warn");
});

test("evaluateExtensionTrust honors disabled/warn/enforced behavior", () => {
  const disabled = evaluateExtensionTrust({
    mode: "disabled",
    extensionName: "ext-a",
    declaredCapabilities: null,
    registeredEvents: ["suggest_request.requested"]
  });
  assert.equal(disabled.status, "accepted");

  const warn = evaluateExtensionTrust({
    mode: "warn",
    extensionName: "ext-b",
    declaredCapabilities: null,
    registeredEvents: ["suggest_request.requested"]
  });
  assert.equal(warn.status, "accepted_with_warnings");
  assert.ok(warn.warnings.length > 0);

  const enforced = evaluateExtensionTrust({
    mode: "enforced",
    extensionName: "ext-c",
    declaredCapabilities: {
      events: ["turn.completed"],
      actions: []
    },
    registeredEvents: ["suggest_request.requested"]
  });
  assert.equal(enforced.status, "denied");
  assert.ok(enforced.errors.some((entry) => entry.includes("undeclared event capability")));
});

test("evaluateActionCapability enforces undeclared action behavior", () => {
  const allowed = evaluateActionCapability({
    mode: "enforced",
    extensionName: "ext-d",
    declaredCapabilities: {
      events: [],
      actions: ["approval.decide"]
    },
    actionType: "approval.decide"
  });
  assert.equal(allowed.allowed, true);

  const denied = evaluateActionCapability({
    mode: "enforced",
    extensionName: "ext-d",
    declaredCapabilities: {
      events: [],
      actions: ["approval.decide"]
    },
    actionType: "turn.steer.create"
  });
  assert.equal(denied.allowed, false);
  assert.ok(typeof denied.reason === "string");

  const warned = evaluateActionCapability({
    mode: "warn",
    extensionName: "ext-d",
    declaredCapabilities: {
      events: [],
      actions: ["approval.decide"]
    },
    actionType: "turn.steer.create"
  });
  assert.equal(warned.allowed, true);
  assert.ok(typeof warned.reason === "string");
});
