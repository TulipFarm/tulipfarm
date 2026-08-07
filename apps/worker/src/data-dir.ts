// Zero-required-env boot, worker half: read what the API wrote to the shared data volume.
//
// A compose file pasted into Portainer has no `.env`, so nothing hands this process a credential
// or a key. The API mints both on its first boot and persists them under the data volume; this
// process mounts that volume read-only and reads them back. Two files, each with one owner:
// `worker.env` (the service credential, written by `setup/worker-credential.ts`) and `secrets.env`
// (the KEK, written by `setup/bootstrap-secrets.ts`) — the key is never copied into a second file.
//
// The environment always wins. A deployment that sets these itself never touches the volume, and
// a development checkout has no `/data` at all, so it still fails with the familiar "X is required"
// rather than a confusing error about a directory nobody asked for.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_DATA_DIR = "/data";

/** Env var -> the file on the data volume whose owner writes it. */
const SOURCES = {
  WORKER_API_CREDENTIAL: "worker.env",
  ENCRYPTION_KEY: "secrets.env",
} as const;

type Filled = keyof typeof SOURCES;

type Env = Record<string, string | undefined>;

/**
 * Where the API persists what it generated. `TF_DATA_DIR` wins; otherwise the container default,
 * and only when it already exists.
 */
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
 * Fills any of `WORKER_API_CREDENTIAL` / `ENCRYPTION_KEY` still missing from the data volume.
 * Mutates `env` — callers run this before `loadConfig`, and before any secret is unwrapped.
 *
 * Returns the names it filled, for the boot log. Nothing is invented here: a value that is on
 * neither the environment nor the volume stays missing, and `loadConfig` says so by name.
 */
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
  /**
   * Optional extra check once every key is present. Presence alone isn't enough for
   * `WORKER_API_CREDENTIAL`: `reset-dev.sh` can leave a stale file on disk from before a database
   * wipe, and this process can read it before the API's fresh mint overwrites it — a value that
   * satisfies the missing-keys check but does not actually authenticate. Return `false` to force a
   * fresh read next attempt instead of trusting the cached value again.
   */
  verify?: (env: Env) => Promise<boolean>;
}

/**
 * Retries `loadDataDirEnv` until every key it can source from the volume is filled (and, if
 * `verify` is given, passes it), or attempts are exhausted. This primarily handles local `pnpm
 * dev`, where Turbo starts the API and this worker concurrently: the API needs a database round
 * trip before it (re)writes the credential file — on a freshly reset database the old file is
 * stale until that happens — so a worker reading the directory in that window sees nothing yet,
 * not a permanent absence.
 *
 * A no-op single read when no data dir resolves at all: nothing here can turn a real
 * misconfiguration (no `TF_DATA_DIR`, no env var) into a value, so there is nothing to wait for —
 * and `verify` never runs, so an env-supplied credential in a managed deployment fails fast as
 * before rather than spending the retry budget on it.
 */
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
