export type AgentExtensionTrustMode = "disabled" | "warn" | "enforced";

export type AgentExtensionTrustStatus = "accepted" | "accepted_with_warnings" | "denied";

export type AgentExtensionCapabilityDeclaration = {
  events: Array<string>;
  actions: Array<string>;
};

export type AgentExtensionTrustEvaluation = {
  mode: AgentExtensionTrustMode;
  status: AgentExtensionTrustStatus;
  warnings: Array<string>;
  errors: Array<string>;
};

function normalizeCapabilityList(values: Array<string> | null | undefined): Array<string> {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function includesCapability(capabilities: Array<string>, value: string): boolean {
  if (capabilities.includes("*")) {
    return true;
  }
  return capabilities.includes(value);
}

export function evaluateExtensionTrust(input: {
  mode: AgentExtensionTrustMode;
  extensionName: string;
  declaredCapabilities: AgentExtensionCapabilityDeclaration | null;
  registeredEvents: Array<string>;
}): AgentExtensionTrustEvaluation {
  if (input.mode === "disabled") {
    return {
      mode: input.mode,
      status: "accepted",
      warnings: [],
      errors: []
    };
  }

  const warnings: Array<string> = [];
  const errors: Array<string> = [];
  const declaredEvents = normalizeCapabilityList(input.declaredCapabilities?.events);

  if (!input.declaredCapabilities) {
    const message = `extension ${input.extensionName} has no manifest capabilities declaration`;
    if (input.mode === "enforced") {
      errors.push(message);
    } else {
      warnings.push(message);
    }
  }

  for (const eventName of input.registeredEvents) {
    if (!includesCapability(declaredEvents, eventName)) {
      const message = `extension ${input.extensionName} registered undeclared event capability: ${eventName}`;
      if (input.mode === "enforced") {
        errors.push(message);
      } else {
        warnings.push(message);
      }
    }
  }

  if (errors.length > 0) {
    return {
      mode: input.mode,
      status: "denied",
      warnings,
      errors
    };
  }

  if (warnings.length > 0) {
    return {
      mode: input.mode,
      status: "accepted_with_warnings",
      warnings,
      errors: []
    };
  }

  return {
    mode: input.mode,
    status: "accepted",
    warnings: [],
    errors: []
  };
}

export function evaluateActionCapability(input: {
  mode: AgentExtensionTrustMode;
  extensionName: string;
  declaredCapabilities: AgentExtensionCapabilityDeclaration | null;
  actionType: string;
}): { allowed: boolean; reason: string | null } {
  if (input.mode === "disabled") {
    return {
      allowed: true,
      reason: null
    };
  }

  const declaredActions = normalizeCapabilityList(input.declaredCapabilities?.actions);
  if (includesCapability(declaredActions, input.actionType)) {
    return {
      allowed: true,
      reason: null
    };
  }

  const reason = `extension ${input.extensionName} attempted undeclared action capability: ${input.actionType}`;
  if (input.mode === "enforced") {
    return {
      allowed: false,
      reason
    };
  }

  return {
    allowed: true,
    reason
  };
}

export function normalizeTrustMode(value: string | undefined): AgentExtensionTrustMode {
  if (value === "disabled" || value === "warn" || value === "enforced") {
    return value;
  }
  return "warn";
}
