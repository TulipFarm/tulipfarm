// Env wins; otherwise containers may read API-minted worker.env/secrets.env from the data volume.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_DATA_DIR = "/data";

/** Env var -> the file on the data volume whose owner writes it. */
const SOURCES = {
  WORKER_API_CREDENTIAL: "worker.env",
  ENCRYPTION_KEY: "secrets.env",
} as const;

/**
 * The same lane, but never waited for. A deployment on the filesystem blob store has no
 * `bucket.env` at all, and one pointed at an external S3 provider is handed these directly, so
 * their absence is a normal shape rather than a startup race worth retrying.
 */
const OPTIONAL_SOURCES = {
  S3_ACCESS_KEY_ID: "bucket.env",
  S3_SECRET_ACCESS_KEY: "bucket.env",
} as const;

type RequiredSource = keyof typeof SOURCES;

type Filled = RequiredSource | keyof typeof OPTIONAL_SOURCES;

type Env = Record<string, string | undefined>;

/** `TF_DATA_DIR` wins; otherwise use the existing container default. */
export function resolveDataDir(env: Env = process.env): string | undefined {
  if (env.TF_DATA_DIR) return env.TF_DATA_DIR;
  try {
    if (statSync(DEFAULT_DATA_DIR).isDirectory()) return DEFAULT_DATA_DIR;
  } catch {
    // Not present — not a container, skip the file lane entirely.
  }
  return undefined;
}

/** Reads one `KEY=value` out of a `.env`-shaped file. Unknown keys are ignored, not an error. */
function readKey(contents: string, key: string): string | undefined {
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() === key) {
      const value = line.slice(eq + 1).trim();
      if (value.length > 0) return value;
    }
  }
  return undefined;
}

/**
 * Fills any of `WORKER_API_CREDENTIAL` / `ENCRYPTION_KEY` / the bundled bucket's S3 credentials
 * still missing from the data volume.
 * Mutates `env` — callers run this before `loadConfig`, and before any secret is unwrapped.
 *
 * Returns the names it filled, for the boot log. Nothing is invented here: a value that is on
 * neither the environment nor the volume stays missing, and `loadConfig` says so by name.
 */
export function loadDataDirEnv(env: Env = process.env): Filled[] {
  const sources = { ...SOURCES, ...OPTIONAL_SOURCES };
  const missing = (Object.keys(sources) as Filled[]).filter((name) => !env[name]);
  if (missing.length === 0) return [];

  const dataDir = resolveDataDir(env);
  if (!dataDir) return [];

  const filled: Filled[] = [];
  for (const name of missing) {
    const file = join(dataDir, sources[name]);
    if (!existsSync(file)) continue;
    const value = readKey(readFileSync(file, "utf8"), name);
    if (value === undefined) continue;
    env[name] = value;
    filled.push(name);
  }
  return filled;
}

export interface WaitForDataDirOptions {
  attempts: number;
  delayMs: number;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (missing: Filled[], attempt: number) => void;
  /** Return `false` to reject stale data-volume values and retry a fresh read. */
  verify?: (env: Env) => Promise<boolean>;
}

/** Retries data-volume reads for local API/Worker boot races; never invents missing env. */
export async function waitForDataDirEnv(
  options: WaitForDataDirOptions,
  env: Env = process.env
): Promise<Filled[]> {
  if (!resolveDataDir(env)) return loadDataDirEnv(env);

  const sleep =
    options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  let filled: Filled[] = [];
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    filled = loadDataDirEnv(env);
    const missing = (Object.keys(SOURCES) as Filled[]).filter((name) => !env[name]);
    if (missing.length === 0) {
      if (!options.verify || (await options.verify(env))) return filled;
      for (const name of filled) delete env[name];
      if (attempt === options.attempts) return filled;
      options.onRetry?.(Object.keys(SOURCES) as Filled[], attempt);
      await sleep(options.delayMs);
      continue;
    }
    if (attempt === options.attempts) return filled;
    options.onRetry?.(missing, attempt);
    await sleep(options.delayMs);
  }
  return filled;
}
