import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type DerivedModelProfile,
  deriveModelProfiles,
  hoistProviderConnections,
  type LlmConfig,
} from "@tulipfarm/schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { SoulMigration } from "./index";

/**
 * Convert legacy `llm.tiers` into authored ModelProfiles, named provider connections, and an effort
 * preset map — the shapes the ModelProfile router actually routes on.
 *
 * The conversion itself is `deriveModelProfiles`/`hoistProviderConnections` from `@tulipfarm/schema`,
 * the *same* functions the runtime uses to derive a catalog from an unmigrated config. Sharing them
 * is the point: a migrated Soul and an unmigrated one must resolve a turn identically, and they
 * cannot drift apart if there is only one derivation.
 *
 * `tiers` is deliberately left in place. Its credentials now live in `connections`, but removing the
 * block would strand any deployment that has to roll back, and the runtime already prefers authored
 * profiles over derived ones — so a leftover `tiers` changes no routing decision.
 */

const MODELS_DIR = "models";

/**
 * Deterministic UUID from the profile slug. A random id would make the migration produce a
 * different Soul on every run, churning the git history and the bundle digests computed over it.
 */
function stableId(slug: string): string {
  const hex = createHash("sha256").update(`ModelProfile:${slug}`, "utf8").digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function definitionFor(profile: DerivedModelProfile): Record<string, unknown> {
  const { profileId, spec, ...rest } = profile;
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "ModelProfile",
    metadata: {
      id: stableId(profileId),
      slug: profileId,
      schemaVersion: 1,
      authoredVersion: 1,
      // Migrated profiles are authored content, not approved content — publishing stays a
      // deliberate act so nobody silently activates a config they never reviewed.
      lifecycle: "draft",
    },
    spec: rest,
  };
}

export async function migrateTiersToModelProfiles(soulPath: string): Promise<void> {
  const soulYamlPath = join(soulPath, "soul.yaml");

  let manifest: Record<string, unknown>;
  try {
    manifest = (parseYaml(await readFile(soulYamlPath, "utf8")) ?? {}) as Record<string, unknown>;
  } catch {
    return; // No manifest means no tiers to convert.
  }

  const llm = manifest.llm as LlmConfig | undefined;
  if (!llm?.tiers) return;

  const profiles = deriveModelProfiles(llm);
  if (profiles.length === 0) return;

  await mkdir(join(soulPath, MODELS_DIR), { recursive: true });
  for (const profile of profiles) {
    await writeFile(
      join(soulPath, MODELS_DIR, `${profile.profileId}.yaml`),
      stringifyYaml(definitionFor(profile)),
      "utf8"
    );
  }

  const published = new Set(profiles.map((p) => p.profileId));
  const presets = {
    ...(published.has("fast") ? { fast: "fast" } : {}),
    ...(published.has("balanced") ? { balanced: "balanced" } : {}),
    ...(published.has("thorough") ? { thorough: "thorough" } : {}),
  };

  manifest.llm = {
    ...llm,
    connections: { ...hoistProviderConnections(llm).connections, ...llm.connections },
    presets: {
      // `auto` must land somewhere real: prefer balanced, but a Soul that only configured one tier
      // gets that one rather than a default pointing at a profile it never published.
      default: presets.balanced ?? presets.fast ?? presets.thorough,
      ...presets,
      ...llm.presets,
    },
  } satisfies LlmConfig;

  await writeFile(soulYamlPath, stringifyYaml(manifest), "utf8");
}

export const MODEL_PROFILE_MIGRATION: SoulMigration = {
  version: 1,
  description: "convert llm tiers into ModelProfiles, provider connections, and effort presets",
  up: migrateTiersToModelProfiles,
};
