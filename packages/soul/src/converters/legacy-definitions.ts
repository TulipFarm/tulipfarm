import type { SoulAgent } from "../types";
import { convertLegacyAgent } from "./agent";
import type { ConversionResult } from "./shared";

export { convertLegacyAgent } from "./agent";
export type { ConversionResult, ConversionWarning, ConversionWarningCode } from "./shared";

/** Legacy artifacts to convert in one batch. Resources/Routines/Integrations are out of scope. */
export interface LegacyDefinitionBatch {
  readonly agents?: readonly SoulAgent[];
}

/** Convert legacy Agents independently and aggregate proposed files plus warnings. */
export function convertLegacyDefinitions(batch: LegacyDefinitionBatch): ConversionResult {
  const results = [...(batch.agents ?? []).map(convertLegacyAgent)];

  return {
    files: results.flatMap((result) => result.files),
    warnings: results.flatMap((result) => result.warnings),
  };
}
