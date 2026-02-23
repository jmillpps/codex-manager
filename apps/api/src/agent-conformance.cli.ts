import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runAgentConformance } from "./agent-conformance.js";

const report = await runAgentConformance();
const outputPathRaw = process.env.AGENT_CONFORMANCE_OUTPUT;
const outputPath = outputPathRaw ? path.resolve(outputPathRaw) : null;

if (outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

console.log(
  JSON.stringify(
    {
      status: report.portableExtension ? "ok" : "failed",
      portableExtension: report.portableExtension,
      outputPath,
      report
    },
    null,
    2
  )
);

if (!report.portableExtension) {
  process.exitCode = 1;
}
