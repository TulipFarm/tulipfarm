// Zero-required-env boot (INST-002): resolve the three bootstrap secrets from, in order,
// the environment → a persisted file on the data volume → freshly generated randomness.
//
// This is what lets `docker-compose.yml` ship with no `.env` at all, so a user can paste it
// into Portainer/Coolify/Unraid/ACA and get a working instance in one step. The installer
// still writes real secrets into `.env`, and env vars always win — existing installs never
// take this path.
//
// Pure-ish and injectable (env/fs/log) so the unit tests can exercise every branch without
// touching a real /data.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Secrets this module is allowed to invent. Order is the order they are written to disk. */
export const MANAGED_SECRETS = ["ENCRYPTION_KEY", "JWT_SECRET", "WEBHOOK_SIGNING_SECRET"] as const;

export type ManagedSecret = (typeof MANAGED_SECRETS)[number];

const SECRETS_FILENAME = "secrets.env";
const DEFAULT_DATA_DIR = "/data";

export interface BootstrapSecretsResult {
  /** Secrets generated on this boot (empty on every boot after the first). */
  generated: ManagedSecret[];
  /** Secrets read back from the persisted file. */
  restored: ManagedSecret[];
  /** Absolute path of the persisted file, or undefined when the file lane was not used. */
  file?: string;
}

export class BootstrapSecretsError extends Error {}

/**
 * Where generated secrets are persisted. Explicit `TF_DATA_DIR` always wins; otherwise the
 * container default `/data` is used only when it already exists.
 *
 * The existence check is what keeps this a container-only feature: outside the image nobody
 * has a `/data`, so a developer who forgot `.env.local` still gets the familiar
 * "Missing required environment variables" error from `validateEnvironment` instead of a
 * confusing permission failure on a directory they never asked for.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.TF_DATA_DIR) return env.TF_DATA_DIR;
  try {
    if (statSync(DEFAULT_DATA_DIR).isDirectory()) return DEFAULT_DATA_DIR;
  } catch {
    // Not present — not a container, skip the file lane entirely.
  }
  return undefined;
}

/** Parse the `KEY=value` file we wrote. Unknown keys are ignored, not an error. */
function parseSecretsFile(contents: string): Partial<Record<ManagedSecret, string>> {
  const out: Partial<Record<ManagedSecret, string>> = {};
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if ((MANAGED_SECRETS as readonly string[]).includes(key)) {
      out[key as ManagedSecret] = line.slice(eq + 1).trim();
    }
  }
  return out;
}

/**
 * Fill any missing bootstrap secret on `env`, persisting anything invented so the next boot
 * reuses it. Mutates `env` — callers run this before `validateEnvironment`.
 *
 * Throws `BootstrapSecretsError` when a secret had to be generated but could not be
 * persisted: ephemeral keys would silently orphan every encrypted secret on the next
 * restart, so refusing to boot is the only honest outcome.
 */
export function bootstrapSecrets(
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, "warn"> = console
): BootstrapSecretsResult {
  const missing = MANAGED_SECRETS.filter((name) => !env[name]);
  if (missing.length === 0) return { generated: [], restored: [] };

  const dataDir = resolveDataDir(env);
  // No data volume — leave `env` untouched so validateEnvironment reports the real problem.
  if (!dataDir) return { generated: [], restored: [] };

  const file = join(dataDir, SECRETS_FILENAME);
  const persisted = existsSync(file) ? parseSecretsFile(readFileSync(file, "utf8")) : {};

  const restored: ManagedSecret[] = [];
  const generated: ManagedSecret[] = [];
  for (const name of missing) {
    const fromFile = persisted[name];
    if (fromFile) {
      env[name] = fromFile;
      restored.push(name);
    } else {
      const value = randomBytes(32).toString("base64");
      env[name] = value;
      persisted[name] = value;
      generated.push(name);
    }
  }

  if (generated.length > 0) {
    writeSecretsFile(dataDir, file, persisted);
    log.warn(
      [
        "",
        "════════════════════════════════════════════════════════════════════",
        `  Generated bootstrap secrets: ${generated.join(", ")}`,
        `  Written to ${file}`,
        "",
        "  BACK THIS FILE UP. It is the key that decrypts every secret this",
        "  instance stores (LLM keys, integration credentials). Losing it means",
        "  losing them — restoring the database alone will not be enough.",
        "",
        "  To manage the keys yourself instead, set ENCRYPTION_KEY, JWT_SECRET",
        "  and WEBHOOK_SIGNING_SECRET in the environment; they always take",
        "  precedence over this file.",
        "════════════════════════════════════════════════════════════════════",
        "",
      ].join("\n")
    );
  }

  return { generated, restored, file };
}

function writeSecretsFile(
  dataDir: string,
  file: string,
  values: Partial<Record<ManagedSecret, string>>
): void {
  const body = [
    "# TulipFarm bootstrap secrets — generated automatically on first boot.",
    "# Back this file up. Environment variables of the same name override it.",
    ...MANAGED_SECRETS.filter((name) => values[name]).map((name) => `${name}=${values[name]}`),
    "",
  ].join("\n");

  try {
    mkdirSync(dataDir, { recursive: true });
    // mode on writeFileSync only applies when the file is created; chmod covers the rest.
    writeFileSync(file, body, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch (err) {
    throw new BootstrapSecretsError(
      `Generated bootstrap secrets but could not persist them to ${file} ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        "Refusing to boot with keys that would be lost on restart — mount a writable volume " +
        "at that path, set TF_DATA_DIR to a writable directory, or supply ENCRYPTION_KEY, " +
        "JWT_SECRET and WEBHOOK_SIGNING_SECRET as environment variables."
    );
  }
}

/**
 * Second half of the key-loss guard, called once the pool is up (the table only exists after
 * migrations). A freshly generated KEK plus pre-existing wrapped DEKs means the operator lost
 * the old key — every stored secret is already undecryptable, and booting on would provision a
 * second DEK and bury the evidence.
 */
export async function assertNoOrphanedDeks(
  query: (sql: string) => Promise<{ rowCount: number | null }>,
  result: BootstrapSecretsResult
): Promise<void> {
  if (!result.generated.includes("ENCRYPTION_KEY")) return;

  const { rowCount } = await query("SELECT 1 FROM wrapped_deks LIMIT 1");
  if (!rowCount) return;

  throw new BootstrapSecretsError(
    "ENCRYPTION_KEY was generated fresh, but this database already holds encrypted secrets " +
      `wrapped under a previous key. ${result.file ?? "The secrets file"} is missing or was ` +
      "reset. Restore it from backup, or set ENCRYPTION_KEY to the original value. " +
      "(If the previous key is genuinely gone, the stored secrets are unrecoverable and must " +
      "be re-entered after clearing the wrapped_deks table.)"
  );
}
