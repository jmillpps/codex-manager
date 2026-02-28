import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

type OpenApiOperation = {
  operationId?: unknown;
  requestBody?: {
    content?: Record<string, { schema?: unknown }>;
  };
  responses?: Record<
    string,
    {
      content?: Record<string, { schema?: unknown }>;
    }
  >;
};

type OpenApiDocument = {
  paths?: Record<string, Record<string, OpenApiOperation>>;
};

type ParsedOperation = {
  method: string;
  path: string;
  operation: OpenApiOperation;
  operationId: string | null;
};

const typedTargetOperationIds = [
  "createSession",
  "readSession",
  "sendSessionMessage",
  "getSessionSettings",
  "setSessionSettings",
  "deleteSessionSetting",
  "suggestSessionRequest",
  "enqueueSuggestedSessionRequest",
  "upsertSuggestedSessionRequest",
  "decideApproval",
  "decideToolInput"
] as const;

const requestSchemaRequired = new Set<string>([
  "createSession",
  "sendSessionMessage",
  "setSessionSettings",
  "suggestSessionRequest",
  "enqueueSuggestedSessionRequest",
  "upsertSuggestedSessionRequest",
  "decideApproval",
  "decideToolInput"
]);

const responseSchemasRequired: Record<(typeof typedTargetOperationIds)[number], Array<string>> = {
  createSession: ["200"],
  readSession: ["200", "410"],
  sendSessionMessage: ["202", "400", "403", "404", "410"],
  getSessionSettings: ["200", "403", "404", "410"],
  setSessionSettings: ["200", "400", "403", "404", "410", "423"],
  deleteSessionSetting: ["200", "403", "404", "410", "423"],
  suggestSessionRequest: ["200", "202", "400", "403", "404", "409", "410", "429", "503"],
  enqueueSuggestedSessionRequest: ["202", "400", "403", "404", "409", "410", "429", "503"],
  upsertSuggestedSessionRequest: ["200", "400", "403", "404", "410"],
  decideApproval: ["200", "404", "409", "500"],
  decideToolInput: ["200", "404", "500"]
};

function parseOperations(document: OpenApiDocument): Array<ParsedOperation> {
  const parsed: Array<ParsedOperation> = [];
  for (const [pathValue, methods] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods ?? {})) {
      parsed.push({
        method: method.toUpperCase(),
        path: pathValue,
        operation,
        operationId: typeof operation.operationId === "string" ? operation.operationId : null
      });
    }
  }
  return parsed;
}

function getJsonSchemaFromRequest(operation: OpenApiOperation): unknown | null {
  return operation.requestBody?.content?.["application/json"]?.schema ?? null;
}

function getJsonSchemaFromResponse(operation: OpenApiOperation, statusCode: string): unknown | null {
  return operation.responses?.[statusCode]?.content?.["application/json"]?.schema ?? null;
}

function isLooseSchema(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") {
    return true;
  }
  const record = schema as Record<string, unknown>;
  if (Object.keys(record).length === 0) {
    return true;
  }
  if (record.type === "object" && record.additionalProperties === true && !("properties" in record)) {
    return true;
  }
  return false;
}

async function loadOpenApiDocument(): Promise<OpenApiDocument> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const openApiPath = path.resolve(currentDir, "../openapi/openapi.json");
  const body = await readFile(openApiPath, "utf8");
  return JSON.parse(body) as OpenApiDocument;
}

test("openapi operations define unique, non-empty operationId values", async () => {
  const openapi = await loadOpenApiDocument();
  const operations = parseOperations(openapi);

  const missing = operations
    .filter((entry) => !entry.operationId)
    .map((entry) => `${entry.method} ${entry.path}`)
    .sort();

  const counts = new Map<string, number>();
  for (const entry of operations) {
    if (!entry.operationId) {
      continue;
    }
    counts.set(entry.operationId, (counts.get(entry.operationId) ?? 0) + 1);
  }
  const duplicateIds = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([operationId]) => operationId)
    .sort();

  assert.deepEqual(
    {
      missing,
      duplicateIds
    },
    {
      missing: [],
      duplicateIds: []
    },
    `openapi operationId quality mismatch\nmissing: ${missing.join(", ")}\nduplicates: ${duplicateIds.join(", ")}`
  );
});

test("typed-target operations expose strict json request/response schemas", async () => {
  const openapi = await loadOpenApiDocument();
  const operations = parseOperations(openapi);
  const byOperationId = new Map<string, ParsedOperation>();

  for (const entry of operations) {
    if (entry.operationId) {
      byOperationId.set(entry.operationId, entry);
    }
  }

  const missingOperations: Array<string> = [];
  const missingRequestSchemas: Array<string> = [];
  const looseRequestSchemas: Array<string> = [];
  const missingResponseSchemas: Array<string> = [];
  const looseResponseSchemas: Array<string> = [];

  for (const operationId of typedTargetOperationIds) {
    const entry = byOperationId.get(operationId);
    if (!entry) {
      missingOperations.push(operationId);
      continue;
    }

    if (requestSchemaRequired.has(operationId)) {
      const requestSchema = getJsonSchemaFromRequest(entry.operation);
      if (!requestSchema) {
        missingRequestSchemas.push(operationId);
      } else if (isLooseSchema(requestSchema)) {
        looseRequestSchemas.push(operationId);
      }
    }

    for (const statusCode of responseSchemasRequired[operationId]) {
      const responseSchema = getJsonSchemaFromResponse(entry.operation, statusCode);
      const key = `${operationId}:${statusCode}`;
      if (!responseSchema) {
        missingResponseSchemas.push(key);
        continue;
      }
      if (isLooseSchema(responseSchema)) {
        looseResponseSchemas.push(key);
      }
    }
  }

  assert.deepEqual(
    {
      missingOperations,
      missingRequestSchemas,
      looseRequestSchemas,
      missingResponseSchemas,
      looseResponseSchemas
    },
    {
      missingOperations: [],
      missingRequestSchemas: [],
      looseRequestSchemas: [],
      missingResponseSchemas: [],
      looseResponseSchemas: []
    },
    [
      "typed operation schema-quality mismatch",
      `missing operations: ${missingOperations.join(", ")}`,
      `missing request schemas: ${missingRequestSchemas.join(", ")}`,
      `loose request schemas: ${looseRequestSchemas.join(", ")}`,
      `missing response schemas: ${missingResponseSchemas.join(", ")}`,
      `loose response schemas: ${looseResponseSchemas.join(", ")}`
    ].join("\n")
  );
});
