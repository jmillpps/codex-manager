import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outputPath = path.join(rootDir, ".data", "agent-conformance-report.json");

function runConformanceCli() {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["--filter", "@repo/api", "exec", "tsx", "src/agent-conformance.cli.ts"], {
      cwd: rootDir,
      env: {
        ...process.env,
        AGENT_CONFORMANCE_OUTPUT: outputPath
      },
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`agent conformance CLI failed with exit code ${code}`));
    });
  });
}

await runConformanceCli();
