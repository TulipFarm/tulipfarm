import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';

/** An S3 client for AWS S3, Cloudflare R2, MinIO or any S3-compatible store. */
export function objectStorageClient(env: NodeJS.ProcessEnv = process.env, options: S3ClientConfig = {}) {
  const endpoint = env.TULIPFARM_OBJECT_STORAGE_ENDPOINT || undefined;
  const region = env.TULIPFARM_OBJECT_STORAGE_REGION || (endpoint ? 'auto' : undefined);
  if (!region) throw new Error('TULIPFARM_OBJECT_STORAGE_REGION is required without an endpoint');
  const accessKeyId = env.TULIPFARM_OBJECT_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = env.TULIPFARM_OBJECT_STORAGE_SECRET_ACCESS_KEY;
  if (!accessKeyId !== !secretAccessKey) throw new Error('Set both object storage keys or neither');
  // R2 and MinIO need path-style addressing; AWS S3 is virtual-hosted.
  const pathStyle = Boolean(endpoint) && !new URL(endpoint!).hostname.endsWith('.amazonaws.com');
  return new S3Client({
    region,
    ...(endpoint ? { endpoint } : {}),
    ...(pathStyle ? { forcePathStyle: true } : {}),
    // Without keys the SDK uses its default chain, such as an ECS task role.
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    ...options,
  });
}
