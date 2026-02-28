import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

function parseApiRouteKeys(source: string): Set<string> {
  const keys = new Set<string>();
  const routePattern = /app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;

  while ((match = routePattern.exec(source)) !== null) {
    const method = match[1].toUpperCase() as HttpMethod;
    const routePath = match[2].replace(/:[^/]+/g, "{id}");
    keys.add(`${method} ${routePath}`);
  }

  return keys;
}

function parseOpenApiRouteKeys(document: string): Set<string> {
  const keys = new Set<string>();
  const openapi = JSON.parse(document) as { paths?: Record<string, Record<string, unknown>> };

  for (const [rawPath, operations] of Object.entries(openapi.paths ?? {})) {
    const normalizedPath = rawPath.replace(/\{[^}]+\}/g, "{id}");

    for (const method of Object.keys(operations ?? {})) {
      const upper = method.toUpperCase();
      if (upper === "GET" || upper === "POST" || upper === "PUT" || upper === "PATCH" || upper === "DELETE") {
        keys.add(`${upper} ${normalizedPath}`);
      }
    }
  }

  return keys;
}

test("openapi route coverage matches api route registrations", async () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const apiIndexPath = path.resolve(currentDir, "index.ts");
  const openApiPath = path.resolve(currentDir, "../openapi/openapi.json");

  const [apiIndex, openApi] = await Promise.all([readFile(apiIndexPath, "utf8"), readFile(openApiPath, "utf8")]);

  const apiRoutes = parseApiRouteKeys(apiIndex);
  const openApiRoutes = parseOpenApiRouteKeys(openApi);

  const missing = [...apiRoutes].filter((key) => !openApiRoutes.has(key)).sort();
  const extra = [...openApiRoutes].filter((key) => !apiRoutes.has(key)).sort();

  assert.deepEqual(
    {
      missing,
      extra
    },
    {
      missing: [],
      extra: []
    },
    `openapi route parity mismatch\nmissing: ${missing.join(", ")}\nextra: ${extra.join(", ")}`
  );
});
