import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const stableTsDir = path.join(root, "packages", "codex-protocol", "generated", "stable", "ts");
const stableSchemaDir = path.join(root, "packages", "codex-protocol", "generated", "stable", "json-schema");

await mkdir(stableTsDir, { recursive: true });
await mkdir(stableSchemaDir, { recursive: true });

execFileSync("codex", ["app-server", "generate-ts", "--out", stableTsDir], { stdio: "inherit" });
execFileSync("codex", ["app-server", "generate-json-schema", "--out", stableSchemaDir], { stdio: "inherit" });

console.log("generated codex app-server schema artifacts");
