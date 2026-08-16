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
 * Pure read-merge-serialize for `soul.yaml`. `current` is the file's raw contents (or `null`/empty
 * for genuine absence), `patch` overrides its keys, and the merged config is validated and
 * re-serialized to YAML.
 *
 * Strict on purpose: a non-empty `current` that fails to parse or validate raises rather than
 * resolving to `{}`. Merging a patch onto a silently-empty config would rewrite the file with the
 * patch alone, discarding every key an unreadable soul.yaml still holds.
 */
export function mergeSoulConfig(current: string | null, patch: SoulConfig): string {
  const base: SoulConfig =
    current === null || current === "" ? {} : validateSoulConfig(parse(current) ?? {});
  return stringify(validateSoulConfig({ ...base, ...patch }));
}

/**
 * Tolerant read for boot and display paths, which must degrade rather than crash (decision S3).
 * Never use this to build a value that is written back — see `patchSoulConfig`.
 */
export async function readSoulConfig(soulPath: string): Promise<SoulConfig> {
  try {
    return await readSoulConfigStrict(soulPath);
  } catch {
    // Tolerant boot/display read (decision S3): malformed config degrades to defaults.
    return {};
  }
}

export async function patchSoulConfig(soulPath: string, patch: SoulConfig): Promise<void> {
  // Read the raw file so the strict merge below sees exactly what is on disk: an unreadable but
  // present soul.yaml must raise, not resolve to `{}` and clobber every key it still holds.
  let current: string | null;
  try {
    current = await fs.readFile(soulYamlPath(soulPath), "utf8");
  } catch (error) {
    if (isMissingFile(error)) current = null;
    else throw error;
  }
  const next = mergeSoulConfig(current, patch);
  // soul-write-exception: the raw writer behind first-run setup and headless bootstrap, both of
  // which seed soul.yaml before the artifact catalog and the SoulWriter gateway are constructed.
  await fs.mkdir(soulPath, { recursive: true });
  await fs.writeFile(soulYamlPath(soulPath), next, "utf8");
}
