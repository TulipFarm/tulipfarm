import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deriveModelProfiles, hoistProviderConnections, type LlmConfig } from "@tulipfarm/schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { SoulMigration } from "./index";

/** Normalize legacy LLM tier config inside `soul.yaml#llm`; no cross-file migration. */
export async function normalizeLlmConfig(soulPath: string): Promise<void> {
  const soulYamlPath = join(soulPath, "soul.yaml");

  let manifest: Record<string, unknown>;
  try {
    manifest = (parseYaml(await readFile(soulYamlPath, "utf8")) ?? {}) as Record<string, unknown>;
  } catch {
    return;
  }

  const llm = manifest.llm as LlmConfig | undefined;
  if (!llm?.tiers) return;

  const published = new Set(deriveModelProfiles(llm).map((profile) => profile.profileId));
  const presets = {
    ...(published.has("fast") ? { fast: "fast" } : {}),
    ...(published.has("balanced") ? { balanced: "balanced" } : {}),
    ...(published.has("thorough") ? { thorough: "thorough" } : {}),
  };

  manifest.llm = {
    ...llm,
    connections: { ...hoistProviderConnections(llm).connections, ...llm.connections },
    presets: {
      default: presets.balanced ?? presets.fast ?? presets.thorough,
      ...presets,
      ...llm.presets,
    },
  } satisfies LlmConfig;

  await writeFile(soulYamlPath, stringifyYaml(manifest), "utf8");
}

export const MODEL_PROFILE_MIGRATION: SoulMigration = {
  version: 1,
  description: "normalize LLM connections and Effort Presets in soul.yaml",
  up: normalizeLlmConfig,
};
