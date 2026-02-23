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
