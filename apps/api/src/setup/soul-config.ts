import { promises as fs } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";

export interface SoulConfig {
  businessName?: string;
  businessDescription?: string;
  setupComplete?: boolean;
  gitRemoteUrl?: string;
  [key: string]: unknown;
}

function soulYamlPath(soulPath: string): string {
  return path.join(soulPath, "soul.yaml");
}

export async function readSoulConfig(soulPath: string): Promise<SoulConfig> {
  try {
    return (parse(await fs.readFile(soulYamlPath(soulPath), "utf8")) as SoulConfig) ?? {};
  } catch {
    return {};
  }
}

export async function patchSoulConfig(soulPath: string, patch: SoulConfig): Promise<void> {
  await fs.mkdir(soulPath, { recursive: true });
  const next = { ...(await readSoulConfig(soulPath)), ...patch };
  await fs.writeFile(soulYamlPath(soulPath), stringify(next), "utf8");
}
