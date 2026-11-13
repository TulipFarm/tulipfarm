import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { AppId } from '@tulipfarm/apps';
import { hostHeaderPublisher, type AppSiteStorage } from '@tulipfarm/apps/host-header-publisher';
import { appRepositories, readSourceBundles, type AppTransaction } from '@tulipfarm/apps/store';
import { appBuilder, appPublisher, creditGate, type AppPublisher } from '@tulipfarm/extensions';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { objectStorageClient } from '@tulipfarm/workspaces/object-storage';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { Pool } from 'pg';
import { z } from 'zod';
import { createAppActivities, type PlatformClient } from './app-activities.ts';

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
  database: PlatformClient,
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

type WorkspaceRuntime = {
  transaction<T>(
    workspaceId: string,
    compatibility: { readonly minimum: number; readonly maximum: number },
    action: (tx: AppTransaction) => Promise<T>,
  ): Promise<T>;
};

/** App builds, releases, reconcile and metering. Absent until the apps bucket is configured. */
export function createAppComposition(options: {
  readonly runtime: WorkspaceRuntime;
  readonly discover: (after: string | null) => Promise<string[]>;
  readonly env?: NodeJS.ProcessEnv;
}) {
  const env = options.env ?? process.env;
  const bucket = env.TULIPFARM_OBJECT_STORAGE_APPS_BUCKET;
  if (!bucket) return undefined;
  const client = objectStorageClient(env);
  const objects = s3AppStorage(client, bucket);
  const platform = new Pool({ connectionString: z.url().parse(env.WORKSPACE_AUTHORING_DATABASE_URL), max: 4 });
  const transact = <T>(workspaceId: string, action: (tx: AppTransaction) => Promise<T>) =>
    options.runtime.transaction(workspaceId, commonCompatibility, action);
  const repositories = appRepositories({ root: join(tmpdir(), 'tulipfarm-apps'), storage: { client, bucket } });
  const { reconcileApps, meterAppUsage, ...activities } = createAppActivities({
    transact,
    platform,
    objects,
    publisher: selectAppPublisher(env, objects, platform),
    builder: appBuilder(),
    credits: creditGate(),
    source: async (workspaceId, appId, commit) =>
      repositories.open(
        workspaceId,
        appId as AppId,
        commit as Parameters<typeof repositories.open>[2],
        await transact(workspaceId, tx => readSourceBundles(tx, appId as AppId)),
      ),
    async *workspaces() {
      const seen = new Set<string>();
      for (const row of (await platform.query('SELECT DISTINCT workspace_id FROM app.app_hostnames')).rows)
        seen.add(row.workspace_id as string);
      let after: string | null = null;
      for (;;) {
        const page = await options.discover(after);
        if (!page.length) break;
        for (const id of page) seen.add(id);
        after = page.at(-1)!;
      }
      yield* seen;
    },
    enabled: workspaceId => isFeatureEnabled('app-hosting', null, { id: workspaceId }),
  });
  return {
    activities,
    reconcile: reconcileApps,
    /** Meters the last three closed hours that delivery logs have caught up with; recorded hours are skipped. */
    async meter(signal: AbortSignal, now = Date.now()) {
      const hour = 3_600_000;
      const settled = Math.floor((now - 20 * 60_000) / hour) * hour;
      for (let end = settled - 2 * hour; end <= settled; end += hour)
        await meterAppUsage({ start: new Date(end - hour).toISOString(), end: new Date(end).toISOString() }, signal);
    },
    close: () => platform.end(),
  };
}
