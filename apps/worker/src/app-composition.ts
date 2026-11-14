import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppId } from '@tulipfarm/apps';
import { s3AppStorage, selectAppPublisher } from '@tulipfarm/apps/sites';
import { appRepositories, readSourceBundles, type AppTransaction } from '@tulipfarm/apps/store';
import { appBuilder, creditGate } from '@tulipfarm/extensions';
import { errorAttributes, isFeatureEnabled, log } from '@tulipfarm/observability';
import { objectStorageClient } from '@tulipfarm/workspaces/object-storage';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { Pool } from 'pg';
import { z } from 'zod';
import { createAppActivities } from './app-activities.ts';

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
  const {
    reconcileApps,
    meterAppTraffic,
    meterAppUsage: _meterWindow,
    ...activities
  } = createAppActivities({
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
    /** Meters the settled hours no run has recorded yet. */
    async meter(signal: AbortSignal, now = Date.now()) {
      const unread = await meterAppTraffic(now, signal);
      if (unread)
        log('warn', 'dependency', 'call_failed', { operation: 'app.usage', ...errorAttributes(unread.error) });
    },
    close: () => platform.end(),
  };
}

/** Runs a job now and then every `ms`. A tick that finds the previous run still going is skipped. */
export function repeatFromStart(run: () => Promise<void>, ms: number) {
  let running: Promise<void> | undefined;
  const tick = () => {
    running ??= run().finally(() => {
      running = undefined;
    });
  };
  const timer = setInterval(tick, ms);
  timer.unref();
  tick();
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
