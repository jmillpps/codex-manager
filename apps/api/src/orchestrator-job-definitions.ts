import type { JobDefinition, JobDefinitionsMap } from "./orchestrator-types.js";

export function createJobDefinitionsRegistry(definitions: Array<JobDefinition<unknown, Record<string, unknown>>>): JobDefinitionsMap {
  const byType: JobDefinitionsMap = {};

  for (const definition of definitions) {
    byType[definition.type] = definition;
  }

  return byType;
}
