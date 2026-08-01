// Zero-required-env boot, second half: the Worker needs a credential for `/api/v1/internal/*`,
// and a compose file pasted into Portainer has no way to invent one. So the API mints it — the
// same shape as `bootstrap-secrets.ts`, and for the same reason: env always wins, the data volume
// is the fallback, and nothing is invented when neither lane applies.
//
// The file is the whole handoff. The Worker mounts the data volume read-only and reads this file
// when `WORKER_API_CREDENTIAL` is unset; there is no endpoint that hands a credential out, because
// an endpoint that does that is an endpoint an attacker can ask.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ApiClientRepo,
  authenticateApiClient,
  createApiClient,
  formatApiClientCredential,
} from "../identity/api-clients";
import { assertApiClientAuthenticatable } from "../identity/principal";
import { resolveDataDir } from "./bootstrap-secrets";

/** Name the minted client carries in the admin client list. */
export const WORKER_CLIENT_NAME = "run-executor";

const CREDENTIAL_FILENAME = "worker.env";
const CREDENTIAL_KEY = "WORKER_API_CREDENTIAL";

export interface WorkerCredentialResult {
  /** What happened, for the boot log. */
  outcome: "env" | "reused" | "minted" | "skipped";
  /** Absolute path of the persisted file, when one was used. */
  file?: string;
}

export class WorkerCredentialError extends Error {}

/** Reads `KEY=value`, returning the credential line only. Unknown keys are ignored. */
function parseCredentialFile(contents: string): string | undefined {
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() === CREDENTIAL_KEY) return line.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * Whether a credential on disk would still authenticate a request the Worker makes — the same
 * two questions the auth middleware asks, so a disabled or expired client is replaced here rather
 * than at the Worker's first call.
 */
async function usable(repo: ApiClientRepo, credential: string): Promise<boolean> {
  const client = await authenticateApiClient(repo, credential);
  if (!client) return false;
  try {
    assertApiClientAuthenticatable(client);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures a Worker credential exists on the data volume, minting one on first boot.
 *
 * Re-verifies a credential it finds rather than trusting the file: a restored `/data` next to a
 * fresh database names a client that no longer exists, and a Worker that discovers that only when
 * it claims its first Run has already cost a participant a turn.
 */
export async function provisionWorkerCredential(
  repo: ApiClientRepo,
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, "warn"> = console
): Promise<WorkerCredentialResult> {
  if (env[CREDENTIAL_KEY]) return { outcome: "env" };

  const dataDir = resolveDataDir(env);
  // No data volume — this is a development checkout, where the Worker is configured by hand.
  if (!dataDir) return { outcome: "skipped" };

  const file = join(dataDir, CREDENTIAL_FILENAME);
  const existing = existsSync(file) ? parseCredentialFile(readFileSync(file, "utf8")) : undefined;
  if (existing && (await usable(repo, existing))) return { outcome: "reused", file };

  const { secret, doc } = await createApiClient(repo, {
    name: WORKER_CLIENT_NAME,
    // Nobody. The deployment owns it — see migration 19.
    ownerUserId: null,
  });
  write(dataDir, file, formatApiClientCredential(doc.clientId, secret));
  log.warn(
    `Minted the ${WORKER_CLIENT_NAME} service client and wrote its credential to ${file}. ` +
      `Set ${CREDENTIAL_KEY} in the environment to manage it yourself instead.`
  );
  return { outcome: "minted", file };
}

function write(dataDir: string, file: string, credential: string): void {
  const body = [
    "# TulipFarm Worker credential — generated automatically.",
    "# Read by the worker when WORKER_API_CREDENTIAL is unset. Delete it to mint a new client.",
    `${CREDENTIAL_KEY}=${credential}`,
    "",
  ].join("\n");
  try {
    mkdirSync(dataDir, { recursive: true });
    // mode on writeFileSync only applies when the file is created; chmod covers the rest.
    writeFileSync(file, body, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch (err) {
    throw new WorkerCredentialError(
      `Minted the ${WORKER_CLIENT_NAME} service client but could not persist its credential to ` +
        `${file} (${err instanceof Error ? err.message : String(err)}). Refusing to boot with a ` +
        "credential no worker can read — mount a writable volume at that path, set TF_DATA_DIR to " +
        `a writable directory, or supply ${CREDENTIAL_KEY} to both processes yourself.`
    );
  }
}
