// API mints Worker-shaped `/api/v1/internal/*` credentials when env is absent.
// No endpoint exposes them.

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

/** @deprecated Same as {@link ServiceCredentialResult}; kept for existing callers. */
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

/** Re-check disk credentials against auth rules so disabled or expired clients are replaced. */
async function usable(repo: ApiClientRepo, credential: string): Promise<boolean> {
  const client = await authenticateApiClient(repo, credential);
  if (!client) return false;
  try {
    assertApiClientAuthenticatable(client);
    return true;
  } catch {
    // A credential that fails its assertion is simply not usable.
    return false;
  }
}

/** Ensure a data-volume service credential; verify restored files against the live database. */
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

/** Ensures an Integration Worker credential exists on the data volume. */
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
