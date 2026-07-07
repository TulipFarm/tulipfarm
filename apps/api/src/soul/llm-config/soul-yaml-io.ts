import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { LlmConfigSchema } from "@tulipfarm/llm";
import { ajv, TulipFarmValidationError } from "@tulipfarm/validation";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * soul.yaml top-level schema, validated at this module's read/write boundary (mirrors how
 * `validateResourceSchema`/`validateGuardrailsConfig` gate their own soul files). Only the fields
 * this module and the setup wizard (`setup/soul-config.ts`) know about are typed —
 * `additionalProperties` stays open so other soul-writing code (agents, routines, future keys)
 * isn't broken by a key this module doesn't recognize.
 */
export const SoulManifestSchema = Type.Object(
  {
    soulFormatVersion: Type.Optional(Type.Number()),
    businessName: Type.Optional(Type.String()),
    businessDescription: Type.Optional(Type.String()),
    setupComplete: Type.Optional(Type.Boolean()),
    gitRemoteUrl: Type.Optional(Type.String()),
    llm: Type.Optional(LlmConfigSchema),
  },
  { additionalProperties: true }
);

export type SoulManifest = Static<typeof SoulManifestSchema>;

const checkManifest = ajv.compile(SoulManifestSchema);

function validateManifest(data: unknown): SoulManifest {
  if (!checkManifest(data)) {
    const e = checkManifest.errors?.[0];
    throw new TulipFarmValidationError(
      "soul",
      e?.instancePath ?? "",
      e?.message ?? "invalid soul.yaml"
    );
  }
  return data as SoulManifest;
}

async function readManifest(soulPath: string): Promise<SoulManifest> {
  try {
    const content = await readFile(join(soulPath, "soul.yaml"), "utf8");
    return validateManifest(parseYaml(content) ?? {});
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/** Merges `config` into `soul.yaml` under the top-level `llm:` key, preserving other keys. */
export async function writeLlmConfigToSoulYaml(soulPath: string, config: unknown): Promise<void> {
  const manifest = await readManifest(soulPath);
  const next = validateManifest({ ...manifest, llm: config });
  await writeFile(join(soulPath, "soul.yaml"), stringifyYaml(next), "utf8");
}

/** Removes the top-level `llm:` key from `soul.yaml`, preserving other keys. No-op if absent. */
export async function deleteLlmConfigFromSoulYaml(soulPath: string): Promise<void> {
  const manifest = await readManifest(soulPath);
  if (!("llm" in manifest)) return;
  const { llm: _llm, ...rest } = manifest;
  const next = validateManifest(rest);
  await writeFile(join(soulPath, "soul.yaml"), stringifyYaml(next), "utf8");
}
