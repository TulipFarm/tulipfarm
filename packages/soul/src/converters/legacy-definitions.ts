import type { SoulAgent, SoulSkill } from "../types";
import { convertLegacyAgent } from "./agent";
import type { ConversionResult } from "./shared";
import { convertLegacySkill } from "./skill";

export { convertLegacyAgent } from "./agent";
export type { ConversionResult, ConversionWarning, ConversionWarningCode } from "./shared";
export { convertLegacySkill } from "./skill";

/** Legacy artifacts to convert in one batch. Resources/Routines/Integrations are out of scope. */
export interface LegacyDefinitionBatch {
  readonly agents?: readonly SoulAgent[];
  readonly skills?: readonly SoulSkill[];
}

/** Convert legacy Agents/Skills independently and aggregate proposed files plus warnings. */
export function convertLegacyDefinitions(batch: LegacyDefinitionBatch): ConversionResult {
  const results = [
    ...(batch.agents ?? []).map(convertLegacyAgent),
    ...(batch.skills ?? []).map(convertLegacySkill),
  ];

  return {
    files: results.flatMap((result) => result.files),
    warnings: results.flatMap((result) => result.warnings),
  };
}
