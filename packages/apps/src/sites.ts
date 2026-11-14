import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { appPublisher, type AppPublisher } from '@tulipfarm/extensions';
import { hostHeaderPublisher, type AppSiteStorage, type PlatformDatabase } from './host-header-publisher.ts';

const missing = (error: unknown) =>
  (error as { name?: string; $metadata?: { httpStatusCode?: number } }).name === 'NotFound' ||
  (error as { name?: string }).name === 'NoSuchKey' ||
  (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;

/** The apps bucket as the store that both the build blobs and the built-in publisher's released files live in. */
export function s3AppStorage(client: S3Client, bucket: string): AppSiteStorage {
  return {
    async has(key, signal) {
      return client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal }).then(
        () => true,
        error => {
          if (missing(error)) return false;
          throw error;
        },
      );
    },
    async put(key, body, file, signal) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(chunk);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: Buffer.concat(chunks),
          ContentType: file.contentType,
          ContentLength: file.bytes,
        }),
        { abortSignal: signal },
      );
    },
    async get(key, signal) {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
        return {
          body: object.Body as Readable,
          contentType: object.ContentType ?? 'application/octet-stream',
          bytes: object.ContentLength ?? 0,
        };
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    async delete(key, signal) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
    },
    async *list(prefix, signal) {
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
          { abortSignal: signal },
        );
        for (const object of page.Contents ?? []) if (object.Key) yield object.Key;
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    },
  };
}

/** The last two labels of a host name. Close enough to tell `sites.example.com` from `example.com` without a suffix list. */
const registrableDomain = (host: string) => host.toLowerCase().replace(/\.$/, '').split('.').slice(-2).join('.');

/**
 * A registered publisher wins. Otherwise the built-in publisher serves `<name>.<sites domain>` from the apps bucket,
 * but only on a domain apart from the shell's, so app JavaScript never runs on the shell's site.
 */
export function selectAppPublisher(
  env: NodeJS.ProcessEnv,
  storage: AppSiteStorage,
  database: PlatformDatabase,
): AppPublisher | undefined {
  const registered = appPublisher();
  if (registered) return registered;
  const sitesDomain = env.TULIPFARM_APP_SITES_DOMAIN?.trim();
  if (!sitesDomain) return undefined;
  const shell = env.WEB_ORIGIN || env.TULIPFARM_PUBLIC_URL;
  if (shell && registrableDomain(new URL(shell).hostname) === registrableDomain(sitesDomain))
    throw new Error('TULIPFARM_APP_SITES_DOMAIN must be on a different domain from the TulipFarm web app');
  return hostHeaderPublisher({ sitesDomain, storage, database });
}
