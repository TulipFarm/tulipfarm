import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type SoulConfig, validateSoulConfig } from "@tulipfarm/schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

async function readManifest(soulPath: string): Promise<SoulConfig> {
  try {
    const content = await readFile(join(soulPath, "soul.yaml"), "utf8");
    return validateSoulConfig(parseYaml(content) ?? {});
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/** Merges `config` into `soul.yaml` under the top-level `llm:` key, preserving other keys. */
export async function writeLlmConfigToSoulYaml(soulPath: string, config: unknown): Promise<void> {
  const manifest = await readManifest(soulPath);
  const next = validateSoulConfig({ ...manifest, llm: config });
  await writeFile(join(soulPath, "soul.yaml"), stringifyYaml(next), "utf8");
}

/** Removes the top-level `llm:` key from `soul.yaml`, preserving other keys. No-op if absent. */
export async function deleteLlmConfigFromSoulYaml(soulPath: string): Promise<void> {
  const manifest = await readManifest(soulPath);
  if (!("llm" in manifest)) return;
  const { llm: _llm, ...rest } = manifest;
  const next = validateSoulConfig(rest);
  await writeFile(join(soulPath, "soul.yaml"), stringifyYaml(next), "utf8");
}
