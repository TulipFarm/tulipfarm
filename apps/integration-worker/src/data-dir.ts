// Zero-required-env boot, integration-worker half: read what the API wrote to the shared data
// volume. Same shape as apps/worker/src/data-dir.ts — see that file's header for the rationale.
// `INTEGRATION_WORKER_API_CREDENTIAL` is the one value this process needs from the volume, written
// by the API's `setup/worker-credential.ts` (`provisionIntegrationWorkerCredential`) as
// `integration-worker.env`.
//
// The environment always wins. A deployment that sets this itself never touches the volume, and a
// development checkout has no `/data` at all, so it still fails with the familiar "X is required"
// rather than a confusing error about a directory nobody asked for.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_DATA_DIR = "/data";

/** Env var -> the file on the data volume whose owner writes it. */
const SOURCES = {
  INTEGRATION_WORKER_API_CREDENTIAL: "integration-worker.env",
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
 * Fills `INTEGRATION_WORKER_API_CREDENTIAL` from the data volume if it is still missing from the
 * environment. Mutates `env` — callers run this before `loadConfig`.
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
