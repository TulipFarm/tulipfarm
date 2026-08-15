import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type SoulConfig, validateSoulConfig } from "@tulipfarm/schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

function parseManifest(content: string | null): SoulConfig {
  return validateSoulConfig(content === null ? {} : (parseYaml(content) ?? {}));
}

async function readManifest(soulPath: string): Promise<SoulConfig> {
  try {
    return parseManifest(await readFile(join(soulPath, "soul.yaml"), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Merge `config` into a `soul.yaml` document under the top-level `llm:` key, preserving every
 * other key, and return the new document.
 *
 * Content-in / content-out rather than path-in, because the Soul write gateway owns the file: it
 * hands a caller the current bytes and takes the next ones back. Callers that run before the
 * gateway exists (first-boot bootstrap) use the `*ToSoulYaml` wrappers below instead.
 */
export function mergeLlmConfigIntoSoulYaml(current: string | null, config: unknown): string {
  return stringifyYaml(validateSoulConfig({ ...parseManifest(current), llm: config }));
}

/** Remove the top-level `llm:` key. Returns `null` when there was nothing to remove. */
export function removeLlmConfigFromSoulYaml(current: string | null): string | null {
  const manifest = parseManifest(current);
  if (!("llm" in manifest)) return null;
  const { llm: _llm, ...rest } = manifest;
  return stringifyYaml(validateSoulConfig(rest));
}

/**
 * Filesystem wrapper for first-boot bootstrap, which seeds `soul.yaml` before the Soul catalog —
 * and therefore the write gateway — has been constructed. Every post-boot caller goes through
 * `SoulWriter` instead.
 */
export async function writeLlmConfigToSoulYaml(soulPath: string, config: unknown): Promise<void> {
  const manifest = await readManifest(soulPath);
  const next = validateSoulConfig({ ...manifest, llm: config });
  // soul-write-exception: see the doc comment above — this runs before the gateway is constructed.
  await writeFile(join(soulPath, "soul.yaml"), stringifyYaml(next), "utf8");
}

/** Removes the top-level `llm:` key from `soul.yaml`, preserving other keys. No-op if absent. */
export async function deleteLlmConfigFromSoulYaml(soulPath: string): Promise<void> {
  const manifest = await readManifest(soulPath);
  if (!("llm" in manifest)) return;
  const { llm: _llm, ...rest } = manifest;
  // soul-write-exception: bootstrap-only counterpart of `writeLlmConfigToSoulYaml` above.
  await writeFile(join(soulPath, "soul.yaml"), stringifyYaml(validateSoulConfig(rest)), "utf8");
}
