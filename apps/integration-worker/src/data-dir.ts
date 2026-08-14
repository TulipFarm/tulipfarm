// Zero-required-env boot: env wins, else read the API-written integration-worker.env from the
// shared data volume. No data volume still fails as normal missing env.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_DATA_DIR = "/data";

/** Env var -> the file on the data volume whose owner writes it. */
const SOURCES = {
  INTEGRATION_WORKER_API_CREDENTIAL: "integration-worker.env",
} as const;

type Filled = keyof typeof SOURCES;

type Env = Record<string, string | undefined>;

/** Data dir source: `TF_DATA_DIR`, else existing container default only. */
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

/** Mutates `env` with data-volume credentials only when missing; returns filled key names. */
export function loadDataDirEnv(env: Env = process.env): Filled[] {
  const missing = (Object.keys(SOURCES) as Filled[]).filter((name) => !env[name]);
  if (missing.length === 0) return [];

  const dataDir = resolveDataDir(env);
  if (!dataDir) return [];

  const filled: Filled[] = [];
  for (const name of missing) {
    const file = join(dataDir, SOURCES[name]);
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
  /** Local reset can leave a stale credential file until the API remints it. */
  verify?: (env: Env) => Promise<boolean>;
}

/** Retries local API startup races without masking missing data dirs or invalid env credentials. */
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
