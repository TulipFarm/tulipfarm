import { promises as fs } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";

export interface SoulConfig {
  businessName?: string;
  businessDescription?: string;
  setupComplete?: boolean;
  [key: string]: unknown;
}

function soulYamlPath(soulPath: string): string {
  return path.join(soulPath, "soul.yaml");
}

// Read/modify/write the soul config file. The soul package owns git sync + loading;
// the wizard only needs to read and patch a few top-level keys in soul.yaml.
//
// Only a missing file means "no config yet" -> {}. Any OTHER error (EACCES, a transient
// read failure, invalid YAML) must propagate: swallowing it would let patchSoulConfig
// rewrite soul.yaml with ONLY the patch, dropping existing keys like soulFormatVersion
// and re-triggering soul migrations on next boot.
export async function readSoulConfig(soulPath: string): Promise<SoulConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(soulYamlPath(soulPath), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  return (parse(raw) as SoulConfig) ?? {};
}

export async function patchSoulConfig(soulPath: string, patch: SoulConfig): Promise<void> {
  await fs.mkdir(soulPath, { recursive: true });
  const next = { ...(await readSoulConfig(soulPath)), ...patch };
  // Atomic write: serialize to a temp file then rename, so a crash mid-write can't leave
  // a truncated/partial soul.yaml (rename is atomic on the same filesystem).
  const target = soulYamlPath(soulPath);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, stringify(next), "utf8");
  await fs.rename(tmp, target);
}
