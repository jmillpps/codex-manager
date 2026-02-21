import type { JobDefinition, JobDefinitionsMap } from "./orchestrator-types.js";

export function createJobDefinitionsRegistry(definitions: Array<JobDefinition<any, Record<string, unknown>>>): JobDefinitionsMap {
  const byType: JobDefinitionsMap = {};

  for (const definition of definitions) {
    byType[definition.type] = definition as JobDefinition<unknown, Record<string, unknown>>;
  }

  return byType;
}
