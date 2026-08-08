// Zero-required-env boot, second half: a Worker-shaped process needs a credential for
// `/api/v1/internal/*`, and a compose file pasted into Portainer has no way to invent one. So the
// API mints it — the same shape as `bootstrap-secrets.ts`, and for the same reason: env always
// wins, the data volume is the fallback, and nothing is invented when neither lane applies.
//
// The file is the whole handoff. The reading process mounts the data volume read-only and reads
// this file when its credential env var is unset; there is no endpoint that hands a credential
// out, because an endpoint that does that is an endpoint an attacker can ask.
//
// `apps/worker` and `apps/integration-worker` both need exactly this, under their own client name
// and file — `provisionServiceCredential` is the shared shape; `provisionWorkerCredential` and
// `provisionIntegrationWorkerCredential` are its two named callers.

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
/** Name the minted client carries in the admin client list. */
export const INTEGRATION_WORKER_CLIENT_NAME = "integration-worker-executor";

export interface ServiceCredentialResult {
  /** What happened, for the boot log. */
  outcome: "env" | "reused" | "minted" | "skipped";
  /** Absolute path of the persisted file, when one was used. */
  file?: string;
}

/** @deprecated identical to {@link ServiceCredentialResult}; kept as the name callers already use. */
export type WorkerCredentialResult = ServiceCredentialResult;

export class WorkerCredentialError extends Error {}

interface ServiceCredentialConfig {
  readonly clientName: string;
  readonly credentialFilename: string;
  readonly credentialKey: string;
}

/** Reads `KEY=value`, returning the credential line only. Unknown keys are ignored. */
function parseCredentialFile(contents: string, credentialKey: string): string | undefined {
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() === credentialKey) return line.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * Whether a credential on disk would still authenticate a request the reading process makes — the
 * same two questions the auth middleware asks, so a disabled or expired client is replaced here
 * rather than at that process's first call.
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
 * Ensures a service credential exists on the data volume, minting one on first boot.
 *
 * Re-verifies a credential it finds rather than trusting the file: a restored `/data` next to a
 * fresh database names a client that no longer exists, and a process that discovers that only when
 * it makes its first internal call has already cost a participant a turn.
 */
async function provisionServiceCredential(
  { clientName, credentialFilename, credentialKey }: ServiceCredentialConfig,
  repo: ApiClientRepo,
  env: NodeJS.ProcessEnv,
  log: Pick<Console, "warn">
): Promise<ServiceCredentialResult> {
  if (env[credentialKey]) return { outcome: "env" };

  const dataDir = resolveDataDir(env);
  // No data volume — this is a development checkout, where the process is configured by hand.
  if (!dataDir) return { outcome: "skipped" };

  const file = join(dataDir, credentialFilename);
  const existing = existsSync(file)
    ? parseCredentialFile(readFileSync(file, "utf8"), credentialKey)
    : undefined;
  if (existing && (await usable(repo, existing))) return { outcome: "reused", file };

  const { secret, doc } = await createApiClient(repo, {
    name: clientName,
    // Nobody. The deployment owns it — see migration 19.
    ownerUserId: null,
  });
  write(dataDir, file, credentialKey, clientName, formatApiClientCredential(doc.clientId, secret));
  log.warn(
    `Minted the ${clientName} service client and wrote its credential to ${file}. ` +
      `Set ${credentialKey} in the environment to manage it yourself instead.`
  );
  return { outcome: "minted", file };
}

/** Ensures a Worker credential exists on the data volume, minting one on first boot. */
export async function provisionWorkerCredential(
  repo: ApiClientRepo,
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, "warn"> = console
): Promise<ServiceCredentialResult> {
  return provisionServiceCredential(
    {
      clientName: WORKER_CLIENT_NAME,
      credentialFilename: "worker.env",
      credentialKey: "WORKER_API_CREDENTIAL",
    },
    repo,
    env,
    log
  );
}

/** Ensures an Integration Worker credential exists on the data volume, minting one on first boot. */
export async function provisionIntegrationWorkerCredential(
  repo: ApiClientRepo,
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, "warn"> = console
): Promise<ServiceCredentialResult> {
  return provisionServiceCredential(
    {
      clientName: INTEGRATION_WORKER_CLIENT_NAME,
      credentialFilename: "integration-worker.env",
      credentialKey: "INTEGRATION_WORKER_API_CREDENTIAL",
    },
    repo,
    env,
    log
  );
}

function write(
  dataDir: string,
  file: string,
  credentialKey: string,
  clientName: string,
  credential: string
): void {
  const body = [
    `# TulipFarm ${clientName} credential — generated automatically.`,
    `# Read when ${credentialKey} is unset. Delete it to mint a new client.`,
    `${credentialKey}=${credential}`,
    "",
  ].join("\n");
  try {
    mkdirSync(dataDir, { recursive: true });
    // mode on writeFileSync only applies when the file is created; chmod covers the rest.
    writeFileSync(file, body, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch (err) {
    throw new WorkerCredentialError(
      `Minted the ${clientName} service client but could not persist its credential to ` +
        `${file} (${err instanceof Error ? err.message : String(err)}). Refusing to boot with a ` +
        "credential nobody can read — mount a writable volume at that path, set TF_DATA_DIR to " +
        `a writable directory, or supply ${credentialKey} to both processes yourself.`
    );
  }
}
