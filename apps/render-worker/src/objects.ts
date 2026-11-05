import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';

/** Where rendered pages and PDFs go: the private files bucket the main worker reads them back from. */
export type ObjectWriter = {
  putIfAbsent(key: string, body: Uint8Array, contentType: string): Promise<void>;
  close(): void;
};

/** An S3-compatible writer for `TULIPFARM_OBJECT_STORAGE_*` and `TULIPFARM_OBJECT_STORAGE_FILES_BUCKET`. */
export function objectWriter(env: NodeJS.ProcessEnv = process.env): ObjectWriter {
  const bucket = z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .safeParse(env.TULIPFARM_OBJECT_STORAGE_FILES_BUCKET);
  if (!bucket.success) throw new Error('TULIPFARM_OBJECT_STORAGE_FILES_BUCKET is required');
  const endpoint = env.TULIPFARM_OBJECT_STORAGE_ENDPOINT || undefined;
  const region = env.TULIPFARM_OBJECT_STORAGE_REGION || (endpoint ? 'auto' : undefined);
  if (!region) throw new Error('TULIPFARM_OBJECT_STORAGE_REGION is required without an endpoint');
  const accessKeyId = env.TULIPFARM_OBJECT_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = env.TULIPFARM_OBJECT_STORAGE_SECRET_ACCESS_KEY;
  if (!accessKeyId !== !secretAccessKey) throw new Error('Set both object storage keys or neither');
  // R2 and MinIO need path-style addressing; AWS S3 is virtual-hosted.
  const pathStyle = Boolean(endpoint) && !new URL(endpoint!).hostname.endsWith('.amazonaws.com');
  const client = new S3Client({
    region,
    ...(endpoint ? { endpoint } : {}),
    ...(pathStyle ? { forcePathStyle: true } : {}),
    // Without keys the SDK uses its default chain, such as an ECS task role.
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    maxAttempts: 3,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return {
    async putIfAbsent(Key, Body, ContentType) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket.data,
            Key,
            Body,
            ContentLength: Body.byteLength,
            ContentType,
            IfNoneMatch: '*',
          }),
          { abortSignal: AbortSignal.timeout(30000) },
        );
      } catch (error) {
        // The object already exists: a retried activity wrote it before.
        if (z.object({ $metadata: z.object({ httpStatusCode: z.literal(412) }) }).safeParse(error).success) return;
        throw new Error('plan-document-object-write-unavailable');
      }
    },
    close: () => client.destroy(),
  };
}
