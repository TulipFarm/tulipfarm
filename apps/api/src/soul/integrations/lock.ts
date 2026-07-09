import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface IntegrationLockEntry {
  sourceUrl?: string;
  sourceType?: string;
  manifestPath?: string;
  ref?: string;
  hash?: string;
}

export interface IntegrationsLock {
  version: number;
  integrations: Record<string, IntegrationLockEntry>;
}

export async function readIntegrationsLock(soulPath: string): Promise<IntegrationsLock> {
  try {
    const parsed = JSON.parse(await readFile(join(soulPath, "integrations-lock.json"), "utf8")) as {
      version?: number;
      integrations?: Record<string, IntegrationLockEntry>;
    };
    return { version: parsed.version ?? 1, integrations: parsed.integrations ?? {} };
  } catch {
    return { version: 1, integrations: {} };
  }
}

export async function writeIntegrationsLock(
  soulPath: string,
  lock: IntegrationsLock
): Promise<void> {
  await writeFile(
    join(soulPath, "integrations-lock.json"),
    `${JSON.stringify(lock, null, 2)}\n`,
    "utf8"
  );
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function sourceType(source: string): "github" | "git" {
  return /github\.com|^[\w.-]+\/[\w.-]+$/.test(source) ? "github" : "git";
}
