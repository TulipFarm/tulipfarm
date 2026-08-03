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

/**
 * Convert a batch of legacy Agents/Skills, aggregating every proposed file and warning across the
 * whole set. Each item is converted independently and deterministically (see `convertLegacyAgent`
 * / `convertLegacySkill`); this is purely a fan-out convenience, it does not change per-item
 * semantics and never publishes.
 */
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
