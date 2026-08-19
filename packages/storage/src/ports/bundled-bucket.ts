// Zero-config bundled bucket: the API generates what the bucket server cannot generate itself.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The `.env`-shaped file the workers read the provisioned credentials back out of. */
export const BUCKET_CREDENTIALS_FILE = "bucket.env";

/** Directory holding the secrets the bucket server itself reads at boot. */
export const BUCKET_SECRETS_DIR = "bucket";

const RPC_SECRET_FILE = "rpc-secret";
const ADMIN_TOKEN_FILE = "admin-token";
const ACCESS_KEY_ID = "S3_ACCESS_KEY_ID";
const SECRET_ACCESS_KEY = "S3_SECRET_ACCESS_KEY";

type Env = Record<string, string | undefined>;

export class BundledBucketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundledBucketError";
  }
}

export interface BucketSecretsResult {
  /** True only on the boot that invented them. */
  generated: boolean;
  rpcSecretFile: string;
  adminTokenFile: string;
}

/**
 * Writes the two secrets the bundled bucket server reads at its own boot.
 *
 * Garage's image carries no shell and Compose cannot invent randomness, so nothing in the stack
 * except this process can turn a fresh volume into a uniquely-keyed bucket. Both values are
 * 32 random bytes as hex, which is the shape Garage's `rpc_secret` requires.
 *
 * Call this before the bucket container can plausibly have started: it starts after `app`, and
 * restarts until these exist, so a first boot that loses the race costs seconds, not correctness.
 */
export function writeBucketSecrets(dataDir: string): BucketSecretsResult {
  const dir = join(dataDir, BUCKET_SECRETS_DIR);
  const rpcSecretFile = join(dir, RPC_SECRET_FILE);
  const adminTokenFile = join(dir, ADMIN_TOKEN_FILE);
  if (existsSync(rpcSecretFile) && existsSync(adminTokenFile)) {
    return { generated: false, rpcSecretFile, adminTokenFile };
  }

  try {
    mkdirSync(dir, { recursive: true });
    for (const file of [rpcSecretFile, adminTokenFile]) {
      if (existsSync(file)) continue;
      // No trailing newline: Garage reads the whole file as the secret.
      writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
      chmodSync(file, 0o600);
    }
  } catch (err) {
    throw new BundledBucketError(
      `Could not write the bundled bucket's secrets to ${dir} ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        "Mount a writable volume there, set TF_DATA_DIR to a writable directory, or point " +
        "S3_ENDPOINT at an external S3 provider and supply its credentials instead."
    );
  }
  return { generated: true, rpcSecretFile, adminTokenFile };
}

/** How the S3 credentials on `env` were arrived at. */
export type BundledBucketOutcome = "skipped" | "environment" | "restored" | "provisioned";

export interface EnsureBundledBucketOptions {
  env?: Env;
  dataDir?: string | undefined;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: Pick<Console, "warn">;
  /** Health poll budget. The default spans about a minute of a cold bucket boot. */
  attempts?: number;
  delayMs?: number;
}

/**
 * Makes `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` true, provisioning them on first boot.
 *
 * Runs only when `BUCKET_ADMIN_URL` names a bundled bucket; pointing the deployment at an external
 * S3 provider leaves it unset and this returns `skipped`. Operator-supplied credentials always win,
 * so a bundled install can still be repointed without clearing the volume.
 *
 * The credentials file is the record of what exists, not the bucket: Garage's `CreateKey` is keyed
 * by nothing, so calling it twice yields two keys rather than the same one. Losing the file
 * therefore mints a fresh key rather than recovering the old one, which is why it is written before
 * this function reports success.
 */
export async function ensureBundledBucket(
  options: EnsureBundledBucketOptions = {}
): Promise<BundledBucketOutcome> {
  const env = options.env ?? process.env;
  const adminUrl = trimmed(env.BUCKET_ADMIN_URL);
  if (adminUrl === undefined) return "skipped";
  if (trimmed(env[ACCESS_KEY_ID]) && trimmed(env[SECRET_ACCESS_KEY])) return "environment";

  const dataDir = options.dataDir;
  if (dataDir === undefined) {
    throw new BundledBucketError(
      "BUCKET_ADMIN_URL is set but there is no data directory to persist the bucket's " +
        "credentials to, so they would be lost on restart and every stored file with them. " +
        "Set TF_DATA_DIR to a writable directory, or supply S3_ACCESS_KEY_ID and " +
        "S3_SECRET_ACCESS_KEY yourself."
    );
  }

  const file = join(dataDir, BUCKET_CREDENTIALS_FILE);
  const persisted = readCredentials(file);
  if (persisted) {
    env[ACCESS_KEY_ID] = persisted.accessKeyId;
    env[SECRET_ACCESS_KEY] = persisted.secretAccessKey;
    return "restored";
  }

  const bucket = trimmed(env.S3_BUCKET);
  if (bucket === undefined) {
    throw new BundledBucketError("BUCKET_ADMIN_URL is set but S3_BUCKET names no bucket to create");
  }

  const admin = adminClient(adminUrl, readAdminToken(dataDir), options.fetch ?? globalThis.fetch);
  await waitForBucket(admin, options);

  const key = await admin.createKey(bucket);
  await admin.allow(await admin.ensureBucket(bucket), key.accessKeyId);
  writeCredentials(dataDir, file, key);

  env[ACCESS_KEY_ID] = key.accessKeyId;
  env[SECRET_ACCESS_KEY] = key.secretAccessKey;
  (options.log ?? console).warn(
    [
      "",
      `  Provisioned the bundled bucket "${bucket}" and its access key.`,
      `  Credentials written to ${file} — back it up with the rest of the data volume.`,
      "",
    ].join("\n")
  );
  return "provisioned";
}

export interface BucketCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

interface AdminClient {
  health(): Promise<boolean>;
  createKey(name: string): Promise<BucketCredentials>;
  ensureBucket(alias: string): Promise<string>;
  allow(bucketId: string, accessKeyId: string): Promise<void>;
}

/**
 * The four calls this needs out of Garage's admin API, and nothing more.
 *
 * `/health` is deliberately the unauthenticated one: it is the same probe Compose's healthcheck
 * uses, so a failure here and an unhealthy container mean the same thing.
 */
function adminClient(
  baseUrl: string,
  token: string,
  doFetch: typeof globalThis.fetch
): AdminClient {
  const base = baseUrl.replace(/\/+$/, "");
  const call = async (path: string, init?: RequestInit): Promise<Response> =>
    doFetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init?.headers,
      },
    });

  const post = async (path: string, body: unknown): Promise<Response> =>
    call(path, { method: "POST", body: JSON.stringify(body) });

  const refuse = async (what: string, response: Response): Promise<never> => {
    throw new BundledBucketError(
      `The bundled bucket refused to ${what} (HTTP ${response.status}): ${(
        await response.text().catch(() => "")
      ).slice(0, 200)}`
    );
  };

  return {
    health: async () => {
      try {
        return (await doFetch(`${base}/health`)).ok;
      } catch {
        // A refused connection is this probe's answer, not a fault: the caller is polling a
        // server that has not finished starting, and reports the real failure once it times out.
        return false;
      }
    },
    createKey: async (name) => {
      const response = await post("/v2/CreateKey", { name });
      if (!response.ok) return refuse("create an access key", response);
      const body = (await response.json()) as Partial<BucketCredentials>;
      if (!body.accessKeyId || !body.secretAccessKey) {
        throw new BundledBucketError("The bundled bucket returned an access key with no secret");
      }
      return { accessKeyId: body.accessKeyId, secretAccessKey: body.secretAccessKey };
    },
    // 409 is the bucket already existing, which is the state being asked for, not a failure.
    ensureBucket: async (alias) => {
      const created = await post("/v2/CreateBucket", { globalAlias: alias });
      if (created.ok) return bucketId(await created.json());
      if (created.status !== 409) return refuse(`create the bucket "${alias}"`, created);
      const found = await call(`/v2/GetBucketInfo?globalAlias=${encodeURIComponent(alias)}`);
      if (!found.ok) return refuse(`describe the existing bucket "${alias}"`, found);
      return bucketId(await found.json());
    },
    allow: async (id, accessKeyId) => {
      const response = await post("/v2/AllowBucketKey", {
        bucketId: id,
        accessKeyId,
        permissions: { read: true, write: true, owner: true },
      });
      if (!response.ok) await refuse("grant its access key permission on the bucket", response);
    },
  };
}

function bucketId(body: unknown): string {
  const id = (body as { id?: unknown }).id;
  if (typeof id !== "string" || id === "") {
    throw new BundledBucketError("The bundled bucket described a bucket with no id");
  }
  return id;
}

async function waitForBucket(
  admin: AdminClient,
  options: EnsureBundledBucketOptions
): Promise<void> {
  const attempts = options.attempts ?? 60;
  const delayMs = options.delayMs ?? 1_000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await admin.health()) return;
    if (attempt === attempts) break;
    await sleep(delayMs);
  }
  throw new BundledBucketError(
    `The bundled bucket did not become healthy within ${Math.round((attempts * delayMs) / 1000)}s. ` +
      "Check the `bucket` service's logs; it refuses to start until this process has written its " +
      "secrets, so a first boot may need a moment longer than usual."
  );
}

function readAdminToken(dataDir: string): string {
  const file = join(dataDir, BUCKET_SECRETS_DIR, ADMIN_TOKEN_FILE);
  const token = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (token === "") {
    throw new BundledBucketError(
      `The bundled bucket's admin token is missing from ${file}. It is written on first boot; ` +
        "if the data volume was replaced while the bucket kept its own, both must be reset together."
    );
  }
  return token;
}

function readCredentials(file: string): BucketCredentials | undefined {
  if (!existsSync(file)) return undefined;
  const contents = readFileSync(file, "utf8");
  const accessKeyId = readKey(contents, ACCESS_KEY_ID);
  const secretAccessKey = readKey(contents, SECRET_ACCESS_KEY);
  if (accessKeyId === undefined || secretAccessKey === undefined) return undefined;
  return { accessKeyId, secretAccessKey };
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

function writeCredentials(dataDir: string, file: string, credentials: BucketCredentials): void {
  const body = [
    "# TulipFarm bundled bucket credentials — generated automatically on first boot.",
    "# Back this file up. Environment variables of the same name override it.",
    `${ACCESS_KEY_ID}=${credentials.accessKeyId}`,
    `${SECRET_ACCESS_KEY}=${credentials.secretAccessKey}`,
    "",
  ].join("\n");
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, body, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch (err) {
    throw new BundledBucketError(
      `Provisioned the bundled bucket but could not persist its credentials to ${file} ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        "Refusing to boot with a key that would be lost on restart, stranding every stored file."
    );
  }
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text === "" ? undefined : text;
}
