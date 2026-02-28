import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CLI_ROUTE_BINDINGS, CLI_ROUTE_KEY_SET } from "./lib/route-coverage.js";

function parseApiRouteKeys(source: string): Set<string> {
  const keys = new Set<string>();
  const routePattern = /app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = routePattern.exec(source)) !== null) {
    const method = match[1].toUpperCase();
    const pathValue = match[2];
    keys.add(`${method} ${pathValue}`);
  }
  return keys;
}

function toOpenApiPath(pathTemplate: string): string {
  return pathTemplate.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

test("cli route coverage list has unique entries", () => {
  assert.equal(CLI_ROUTE_BINDINGS.length, CLI_ROUTE_KEY_SET.size, "duplicate CLI route coverage entries found");
});

test("cli route coverage matches api route registrations", async () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const apiIndexPath = path.resolve(currentDir, "../../api/src/index.ts");
  const apiIndex = await readFile(apiIndexPath, "utf8");

  const apiRoutes = parseApiRouteKeys(apiIndex);
  const cliRoutes = CLI_ROUTE_KEY_SET;

  const missing = [...apiRoutes].filter((key) => !cliRoutes.has(key)).sort();
  const extra = [...cliRoutes].filter((key) => !apiRoutes.has(key)).sort();

  assert.deepEqual(
    {
      missing,
      extra
    },
    {
      missing: [],
      extra: []
    },
    `route parity mismatch\nmissing: ${missing.join(", ")}\nextra: ${extra.join(", ")}`
  );
});

test("cli annotated allow-statuses match openapi non-5xx status contracts", async () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const openApiPath = path.resolve(currentDir, "../../api/openapi/openapi.json");
  const openApiRaw = await readFile(openApiPath, "utf8");
  const openApi = JSON.parse(openApiRaw) as {
    paths?: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
  };

  for (const binding of CLI_ROUTE_BINDINGS) {
    if (!binding.allowStatuses) {
      continue;
    }

    const openApiPathKey = toOpenApiPath(binding.path);
    const methodKey = binding.method.toLowerCase();
    const routeSpec = openApi.paths?.[openApiPathKey]?.[methodKey];
    assert.ok(routeSpec, `missing OpenAPI route for ${binding.method} ${binding.path}`);

    const openApiStatuses = Object.keys(routeSpec.responses ?? {})
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isFinite(value))
      .filter((value) => value < 500)
      .sort((left, right) => left - right);
    const cliStatuses = [...binding.allowStatuses].sort((left, right) => left - right);

    assert.deepEqual(
      cliStatuses,
      openApiStatuses,
      `allow-status parity mismatch for ${binding.command} (${binding.method} ${binding.path})`
    );
  }
});
