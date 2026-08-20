import { AwsS3Api, createS3Client, type S3Config } from "./aws-s3-api";
import type { BlobPort } from "./blob";
import { FileSystemBlobPort } from "./filesystem-blob";
import { S3BlobPort } from "./s3-blob";

export type BlobStoreKind = "filesystem" | "s3";

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
}

export interface BlobStoreConfig {
  readonly kind: BlobStoreKind;
  readonly s3?: S3Config;
  readonly prefix?: string;
}

/**
 * Reads the store an operator asked for out of the environment.
 *
 * `BLOB_STORE` is optional and inferred: naming a bucket is unambiguous enough to mean it. Setting
 * it to `s3` without the rest is an error rather than a silent fall back to the filesystem, which
 * would put a production deployment's files on a container disk that vanishes on restart.
 */
export function resolveBlobStoreConfig(env: BlobEnv = process.env): BlobStoreConfig {
  const declared = env.BLOB_STORE?.trim().toLowerCase();
  if (declared !== undefined && declared !== "" && declared !== "filesystem" && declared !== "s3") {
    throw new BlobConfigError(`BLOB_STORE must be "filesystem" or "s3", got "${declared}"`);
  }
  const wantsS3 = declared === "s3" || (declared === undefined && hasText(env.S3_BUCKET));
  if (!wantsS3) return { kind: "filesystem" };

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

/**
 * The blob store this deployment runs on.
 *
 * `filesystemRoot` is only consulted for the filesystem store, so a host passes it unconditionally
 * without having decided anything.
 */
export function createBlobPort(filesystemRoot: string, env: BlobEnv = process.env): BlobPort {
  const config = resolveBlobStoreConfig(env);
  if (config.kind === "filesystem" || config.s3 === undefined) {
    return new FileSystemBlobPort(filesystemRoot);
  }
  return new S3BlobPort(new AwsS3Api(createS3Client(config.s3), config.s3.bucket), {
    ...(config.prefix === undefined ? {} : { prefix: config.prefix }),
  });
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
