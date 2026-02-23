import { jwtVerify } from "jose";
import { timingSafeEqual } from "node:crypto";

export type AgentExtensionRole = "member" | "admin" | "owner" | "system";

export type AgentExtensionRbacMode = "disabled" | "header" | "jwt";

export type AgentExtensionJwtConfig = {
  secret: string | null;
  issuer: string | null;
  audience: string | null;
  roleClaim: string;
  actorClaim: string;
};

export type AgentExtensionHeaderConfig = {
  secret: string | null;
};

function isLoopbackAddress(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }

  const ipv4MappedPrefix = "::ffff:";
  const ipv4Candidate = normalized.startsWith(ipv4MappedPrefix) ? normalized.slice(ipv4MappedPrefix.length) : normalized;
  return ipv4Candidate === "127.0.0.1" || ipv4Candidate.startsWith("127.");
}

export function normalizeHeaderValue(value: unknown): string | null {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" ? first.trim() : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

export function isAgentExtensionRole(value: string): value is AgentExtensionRole {
  return value === "member" || value === "admin" || value === "owner" || value === "system";
}

const jwtSecretEncoder = new TextEncoder();

type RequestRoleResolution =
  | {
      ok: true;
      role: AgentExtensionRole;
      actorId: string | null;
    }
  | {
      ok: false;
      statusCode: number;
      payload: Record<string, unknown>;
    };

export async function resolveRequestRole(input: {
  mode: AgentExtensionRbacMode;
  headers: Record<string, unknown>;
  requestIp?: string | null;
  header?: AgentExtensionHeaderConfig;
  jwt?: AgentExtensionJwtConfig;
}): Promise<RequestRoleResolution> {
  if (input.mode === "disabled") {
    if (!isLoopbackAddress(typeof input.requestIp === "string" ? input.requestIp : "")) {
      return {
        ok: false,
        statusCode: 403,
        payload: {
          status: "forbidden",
          code: "rbac_disabled_remote_forbidden"
        }
      };
    }

    return {
      ok: true,
      role: "admin",
      actorId: "local-disabled-rbac"
    };
  }

  if (input.mode === "jwt") {
    const config = input.jwt;
    if (!config?.secret || config.secret.trim().length === 0) {
      return {
        ok: false,
        statusCode: 500,
        payload: {
          status: "error",
          code: "rbac_misconfigured"
        }
      };
    }

    const authorizationHeader = normalizeHeaderValue(input.headers["authorization"]);
    if (!authorizationHeader) {
      return {
        ok: false,
        statusCode: 401,
        payload: {
          status: "unauthorized",
          code: "missing_bearer_token"
        }
      };
    }

    const tokenMatch = authorizationHeader.match(/^Bearer\s+(.+)$/i);
    if (!tokenMatch || tokenMatch[1].trim().length === 0) {
      return {
        ok: false,
        statusCode: 401,
        payload: {
          status: "unauthorized",
          code: "invalid_authorization_header"
        }
      };
    }

    const token = tokenMatch[1].trim();
    try {
      const result = await jwtVerify(token, jwtSecretEncoder.encode(config.secret), {
        ...(config.issuer ? { issuer: config.issuer } : {}),
        ...(config.audience ? { audience: config.audience } : {})
      });
      const roleValue = result.payload[config.roleClaim];
      if (typeof roleValue !== "string") {
        return {
          ok: false,
          statusCode: 403,
          payload: {
            status: "forbidden",
            code: "invalid_role_claim"
          }
        };
      }
      const normalizedRole = roleValue.trim();
      if (!isAgentExtensionRole(normalizedRole)) {
        return {
          ok: false,
          statusCode: 403,
          payload: {
            status: "forbidden",
            code: "invalid_role_claim"
          }
        };
      }

      const actorValue = result.payload[config.actorClaim];
      return {
        ok: true,
        role: normalizedRole,
        actorId: typeof actorValue === "string" && actorValue.trim().length > 0 ? actorValue.trim() : null
      };
    } catch {
      return {
        ok: false,
        statusCode: 401,
        payload: {
          status: "unauthorized",
          code: "invalid_bearer_token"
        }
      };
    }
  }

  const headerSecret = typeof input.header?.secret === "string" ? input.header.secret.trim() : "";
  if (headerSecret.length > 0) {
    const presentedSecret = normalizeHeaderValue(input.headers["x-codex-rbac-token"]);
    if (!presentedSecret) {
      return {
        ok: false,
        statusCode: 401,
        payload: {
          status: "unauthorized",
          code: "missing_header_token"
        }
      };
    }
    const expectedBuffer = Buffer.from(headerSecret);
    const receivedBuffer = Buffer.from(presentedSecret);
    if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
      return {
        ok: false,
        statusCode: 401,
        payload: {
          status: "unauthorized",
          code: "invalid_header_token"
        }
      };
    }
  }

  const roleHeader = normalizeHeaderValue(input.headers["x-codex-role"]);
  if (!roleHeader) {
    return {
      ok: false,
      statusCode: 401,
      payload: {
        status: "unauthorized",
        code: "missing_role"
      }
    };
  }

  if (!isAgentExtensionRole(roleHeader)) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        status: "error",
        code: "invalid_role"
      }
    };
  }

  return {
    ok: true,
    role: roleHeader,
    actorId: normalizeHeaderValue(input.headers["x-codex-actor"])
  };
}

export function roleAllowed(role: AgentExtensionRole, allowed: Array<AgentExtensionRole>): boolean {
  return allowed.includes(role);
}
