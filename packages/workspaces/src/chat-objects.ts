import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import type { AttachmentBytes } from '@tulipfarm/conversations/attachments';
import { objectStorageClient } from './object-storage.ts';

const clientSettings = {
  maxAttempts: 1,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
} as const;

export function chatObjectStore(
  env: NodeJS.ProcessEnv = process.env,
): (AttachmentBytes & { close: () => void }) | null {
  if (env.TULIPFARM_OBJECT_STORAGE_FILES_BUCKET) {
    const bucket = z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
      .safeParse(env.TULIPFARM_OBJECT_STORAGE_FILES_BUCKET);
    if (!bucket.success) throw new Error('Invalid private chat object configuration');
    return createChatObjectAdapter(objectStorageClient(env, clientSettings), bucket.data);
  }
  const keys = ['CHAT_R2_ACCOUNT_ID', 'CHAT_R2_BUCKET', 'CHAT_R2_ACCESS_KEY_ID', 'CHAT_R2_SECRET_ACCESS_KEY'];
  if (keys.every(key => !env[key])) return null;
  const parsed = z
    .object({
      CHAT_R2_ACCOUNT_ID: z.string().regex(/^[a-f0-9]{32}$/),
      CHAT_R2_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
      CHAT_R2_ACCESS_KEY_ID: z.string().min(1),
      CHAT_R2_SECRET_ACCESS_KEY: z.string().min(1),
    })
    .safeParse(env);
  if (!parsed.success) throw new Error('Invalid private chat object configuration');
  const config = parsed.data;
  const client = new S3Client({
    endpoint: `https://${config.CHAT_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    region: 'auto',
    credentials: { accessKeyId: config.CHAT_R2_ACCESS_KEY_ID, secretAccessKey: config.CHAT_R2_SECRET_ACCESS_KEY },
    ...clientSettings,
  });
  return createChatObjectAdapter(client, config.CHAT_R2_BUCKET);
}

/** Every transfer stops after 20 seconds, or sooner when its caller goes away. */
const deadline = (signal?: AbortSignal) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);

export function createChatObjectAdapter(client: S3Client, Bucket: string): AttachmentBytes & { close: () => void } {
  return {
    async putIfAbsent(Key, Body, signal) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket,
            Key,
            Body,
            ContentLength: Body.byteLength,
            ContentType: 'application/octet-stream',
            IfNoneMatch: '*',
          }),
          { abortSignal: deadline(signal) },
        );
      } catch (error) {
        signal?.throwIfAborted();
        const status = z.object({ $metadata: z.object({ httpStatusCode: z.literal(412) }) }).safeParse(error);
        if (!status.success) throw new Error('chat-object-write-unavailable');
      }
    },
    async read(Key, maximumBytes, signal) {
      const result = await client.send(new GetObjectCommand({ Bucket, Key }), { abortSignal: deadline(signal) });
      if (!result.Body || result.ContentLength !== maximumBytes) {
        await result.Body?.transformToWebStream().cancel();
        throw new Error('chat-object-size-mismatch');
      }
      const reader = result.Body.transformToWebStream().getReader();
      const parts: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          length += item.value.byteLength;
          if (length > maximumBytes) throw new Error('chat-object-size-mismatch');
          parts.push(item.value);
        }
        if (length !== maximumBytes) throw new Error('chat-object-size-mismatch');
        return Buffer.concat(parts, length);
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
    async remove(Key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key }), { abortSignal: AbortSignal.timeout(20000) });
    },
    close() {
      client.destroy();
    },
  };
}
