import { AwsS3Api, createS3Client, type S3Config } from "./aws-s3-api";
import { AzureBlobPort } from "./azure-blob";
import { type AzureConfig, AzureSdkBlobApi, createAzureContainerClient } from "./azure-sdk-blob";
import type { BlobPort } from "./blob";
import { FileSystemBlobPort } from "./filesystem-blob";
import { S3BlobPort } from "./s3-blob";

export type BlobStoreKind = "filesystem" | "s3" | "azure";

export class BlobConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobConfigError";
  }
}

export interface BlobEnv {
  readonly BLOB_STORE?: string;
  readonly S3_BUCKET?: string;
  readonly S3_REGION?: string;
  readonly S3_ENDPOINT?: string;
  readonly S3_ACCESS_KEY_ID?: string;
  readonly S3_SECRET_ACCESS_KEY?: string;
  readonly S3_FORCE_PATH_STYLE?: string;
  readonly S3_PREFIX?: string;
  readonly AZURE_STORAGE_CONNECTION_STRING?: string;
  readonly AZURE_STORAGE_ACCOUNT?: string;
  readonly AZURE_STORAGE_KEY?: string;
  readonly AZURE_STORAGE_CONTAINER?: string;
}

export interface BlobStoreConfig {
  readonly kind: BlobStoreKind;
  readonly s3?: S3Config;
  readonly azure?: AzureConfig;
  readonly prefix?: string;
}

/**
 * Reads the store an operator asked for out of the environment.
 *
 * `BLOB_STORE` is optional and inferred: naming an S3 bucket, or an Azure account or connection
 * string, is unambiguous enough to mean it. Naming a store explicitly without the rest of its
 * configuration is an error rather than a silent fall back to the filesystem, which would put a
 * production deployment's files on a container disk that vanishes on restart.
 */
export function resolveBlobStoreConfig(env: BlobEnv = process.env): BlobStoreConfig {
  const declared = env.BLOB_STORE?.trim().toLowerCase();
  if (
    declared !== undefined &&
    declared !== "" &&
    declared !== "filesystem" &&
    declared !== "s3" &&
    declared !== "azure"
  ) {
    throw new BlobConfigError(
      `BLOB_STORE must be "filesystem", "s3" or "azure", got "${declared}"`
    );
  }

  const wantsS3 = declared === "s3" || (declared === undefined && hasText(env.S3_BUCKET));
  if (wantsS3) return resolveS3StoreConfig(env);

  const wantsAzure =
    declared === "azure" ||
    (declared === undefined &&
      (hasText(env.AZURE_STORAGE_CONNECTION_STRING) || hasText(env.AZURE_STORAGE_ACCOUNT)));
  if (wantsAzure) return resolveAzureStoreConfig(env);

  return { kind: "filesystem" };
}

function resolveS3StoreConfig(env: BlobEnv): BlobStoreConfig {
  const missing = (
    [
      ["S3_BUCKET", env.S3_BUCKET],
      ["S3_ACCESS_KEY_ID", env.S3_ACCESS_KEY_ID],
      ["S3_SECRET_ACCESS_KEY", env.S3_SECRET_ACCESS_KEY],
    ] as const
  )
    .filter(([, value]) => !hasText(value))
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new BlobConfigError(`S3 blob storage is missing ${missing.join(", ")}`);
  }

  return {
    kind: "s3",
    s3: {
      bucket: (env.S3_BUCKET as string).trim(),
      // Every S3-compatible provider demands a region in the signature even when it has only one;
      // `us-east-1` is the value they all accept, so an operator with no region need not invent it.
      region: hasText(env.S3_REGION) ? (env.S3_REGION as string).trim() : "us-east-1",
      ...(hasText(env.S3_ENDPOINT) ? { endpoint: (env.S3_ENDPOINT as string).trim() } : {}),
      accessKeyId: (env.S3_ACCESS_KEY_ID as string).trim(),
      secretAccessKey: env.S3_SECRET_ACCESS_KEY as string,
      // A custom endpoint is usually MinIO, Ceph or a host reached by IP, none of which can serve
      // a virtual-hosted bucket name, so it defaults on rather than making every operator find it.
      forcePathStyle: hasText(env.S3_FORCE_PATH_STYLE)
        ? isTrue(env.S3_FORCE_PATH_STYLE as string)
        : hasText(env.S3_ENDPOINT),
    },
    ...(hasText(env.S3_PREFIX) ? { prefix: normalizePrefix(env.S3_PREFIX as string) } : {}),
  };
}

function resolveAzureStoreConfig(env: BlobEnv): BlobStoreConfig {
  const container = env.AZURE_STORAGE_CONTAINER;
  const connectionString = env.AZURE_STORAGE_CONNECTION_STRING;
  const account = env.AZURE_STORAGE_ACCOUNT;
  const accountKey = env.AZURE_STORAGE_KEY;

  const missing: string[] = [];
  if (!hasText(container)) missing.push("AZURE_STORAGE_CONTAINER");
  // Either credential shape suffices, so name both only when neither is present in full.
  if (!hasText(connectionString) && !(hasText(account) && hasText(accountKey))) {
    missing.push("AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT with AZURE_STORAGE_KEY");
  }
  if (missing.length > 0) {
    throw new BlobConfigError(`Azure blob storage is missing ${missing.join(", ")}`);
  }

  const azure: AzureConfig = hasText(connectionString)
    ? {
        container: (container as string).trim(),
        connectionString: (connectionString as string).trim(),
      }
    : {
        container: (container as string).trim(),
        account: (account as string).trim(),
        accountKey: accountKey as string,
      };
  return { kind: "azure", azure };
}

/**
 * The blob store this deployment runs on.
 *
 * `filesystemRoot` is only consulted for the filesystem store, so a host passes it unconditionally
 * without having decided anything.
 */
export function createBlobPort(filesystemRoot: string, env: BlobEnv = process.env): BlobPort {
  const config = resolveBlobStoreConfig(env);
  if (config.kind === "s3" && config.s3 !== undefined) {
    return new S3BlobPort(new AwsS3Api(createS3Client(config.s3), config.s3.bucket), {
      ...(config.prefix === undefined ? {} : { prefix: config.prefix }),
    });
  }
  if (config.kind === "azure" && config.azure !== undefined) {
    return new AzureBlobPort(new AzureSdkBlobApi(createAzureContainerClient(config.azure)));
  }
  return new FileSystemBlobPort(filesystemRoot);
}

function hasText(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

function isTrue(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function normalizePrefix(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? "" : `${trimmed}/`;
}
