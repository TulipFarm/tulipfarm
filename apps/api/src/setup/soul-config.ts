import { promises as fs } from "node:fs";
import path from "node:path";
import { type SoulConfig, validateSoulConfig } from "@tulipfarm/schema";
import { parse, stringify } from "yaml";

export const SOUL_GIT_CREDENTIAL_KEY = "soul-git-credential";

export type { SoulConfig };

function soulYamlPath(soulPath: string): string {
  return path.join(soulPath, "soul.yaml");
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Strict read: a `soul.yaml` that exists but cannot be parsed or validated raises rather than
 * resolving to `{}`. Only genuine absence is an empty config.
 */
async function readSoulConfigStrict(soulPath: string): Promise<SoulConfig> {
  let contents: string;
  try {
    contents = await fs.readFile(soulYamlPath(soulPath), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }
  return validateSoulConfig(parse(contents) ?? {});
}

/**
 * Tolerant read for boot and display paths, which must degrade rather than crash (decision S3).
 * Never use this to build a value that is written back — see `patchSoulConfig`.
 */
export async function readSoulConfig(soulPath: string): Promise<SoulConfig> {
  try {
    return await readSoulConfigStrict(soulPath);
  } catch {
    return {};
  }
}

export async function patchSoulConfig(soulPath: string, patch: SoulConfig): Promise<void> {
  // Deliberately the strict read: merging a patch onto a silently-empty config would rewrite the
  // file with the patch alone, discarding every key an unreadable soul.yaml still holds.
  const next = validateSoulConfig({ ...(await readSoulConfigStrict(soulPath)), ...patch });
  await fs.mkdir(soulPath, { recursive: true });
  await fs.writeFile(soulYamlPath(soulPath), stringify(next), "utf8");
}
