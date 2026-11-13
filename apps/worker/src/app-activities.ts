import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { Context } from '@temporalio/activity';
import {
  appLimits,
  edgeStatus,
  type AppBuildId,
  type AppFailure,
  type AppId,
  type AppOperationId,
} from '@tulipfarm/apps';
import type { AppSiteStorage } from '@tulipfarm/apps/host-header-publisher';
import {
  failOperation,
  finishBuild,
  markOperationStaging,
  markReleaseStaged,
  readApp,
  readBuild,
  readOperation,
  readRelease,
  setPreviewBuild,
  startBuild,
  switchRelease,
  type AppBuild,
  type AppTransaction,
} from '@tulipfarm/apps/store';
import type { AppBuilder, AppFile, AppPublisher, AppRoute, CreditGate } from '@tulipfarm/extensions';
import { escapeIdentifier } from 'pg';
import { appManifest, untar, type AppBuiltFile } from './app-files.ts';

const execute = promisify(execFile);

export type PlatformClient = {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
};

export type AppWork = {
  /** Runs an action in one transaction on a workspace schema, as the workspace runtime role. */
  readonly transact: <T>(workspaceId: string, action: (tx: AppTransaction) => Promise<T>) => Promise<T>;
  /** The platform database, which holds `app.app_hostnames`. */
  readonly platform: PlatformClient;
  /** The apps bucket: `blobs/<sha256>` and `builds/<buildId>/manifest.json`. */
  readonly objects: AppSiteStorage;
  /** A local Git repository that holds the commit. */
  readonly source: (workspaceId: string, appId: AppId, commit: string) => Promise<string>;
  readonly publisher: AppPublisher | undefined;
  readonly builder: AppBuilder | undefined;
  readonly credits: CreditGate;
  /** Every workspace id, so cleanup can tell an unreferenced release from one it has not looked at. */
  readonly workspaces: () => AsyncIterable<string>;
  readonly enabled: (workspaceId: string) => Promise<boolean>;
};

const table = (tx: AppTransaction, name: string) => `${escapeIdentifier(tx.schema)}.${escapeIdentifier(name)}`;
const failure = (code: AppFailure['code'], message: string, retryable = false): AppFailure => ({
  code,
  message,
  retryable,
});

function activityContext() {
  try {
    return Context.current();
  } catch {
    return undefined;
  }
}

/** Heartbeats every 10 seconds while work runs inside a Temporal activity, and stops when the activity is cancelled. */
async function heartbeating<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
  const context = activityContext();
  const timer = context ? setInterval(() => context.heartbeat(), 10_000) : undefined;
  try {
    return await work(signal ?? context?.cancellationSignal ?? new AbortController().signal);
  } finally {
    clearInterval(timer);
  }
}

async function gitBlob(repository: string, object: string) {
  const { stdout } = await execute('git', ['cat-file', 'blob', object], {
    cwd: repository,
    encoding: 'buffer',
    maxBuffer: appLimits.artifactBytes + 1,
  });
  return stdout;
}

/** Lists a commit's tree below `root` without running anything from it. Links and submodules fail the build. */
async function copyTree(
  repository: string,
  commit: string,
  root: string,
): Promise<{ ok: true; files: AppBuiltFile[] } | { ok: false; failure: AppFailure }> {
  const tree = root === '.' ? `${commit}^{tree}` : `${commit}:${root}`;
  const listing = await execute('git', ['ls-tree', '-r', '-z', tree], {
    cwd: repository,
    maxBuffer: 16 * 1024 * 1024,
  }).then(
    result => result.stdout,
    () => null,
  );
  if (listing === null)
    return { ok: false, failure: failure('build-failed', `The folder ${root} is not in this commit`) };
  const files: AppBuiltFile[] = [];
  let bytes = 0;
  for (const entry of listing.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [mode, type, object] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (type !== 'blob' || mode === '120000')
      return { ok: false, failure: failure('build-failed', `The app has a link or submodule at ${path}`) };
    if (files.length >= appLimits.artifactFiles)
      return {
        ok: false,
        failure: failure('limit-exceeded', `The app has more than ${appLimits.artifactFiles} files`),
      };
    const content = await gitBlob(repository, object!);
    bytes += content.length;
    if (bytes > appLimits.artifactBytes)
      return { ok: false, failure: failure('limit-exceeded', 'The app is larger than 50 MB') };
    files.push({ path, content });
  }
  return { ok: true, files };
}

async function* archive(repository: string, commit: string): AsyncIterable<Uint8Array> {
  const child = spawn('git', ['archive', '--format=tar', commit], {
    cwd: repository,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const exited = new Promise<number | null>(resolve => child.once('close', resolve));
  yield* child.stdout;
  if ((await exited) !== 0) throw new Error(`git archive of ${commit} failed`);
}

async function collect(stream: AsyncIterable<Uint8Array>, limit: number) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function* bytesOf(object: Buffer): AsyncIterable<Uint8Array> {
  yield object;
}

export type AppBuildOutcome = { readonly status: 'succeeded' | 'failed' };

export function createAppActivities(work: AppWork) {
  const { transact, platform, objects, publisher } = work;

  async function readJson<T>(key: string, signal: AbortSignal): Promise<T> {
    const object = await objects.get(key, signal);
    if (!object) throw new Error(`Missing ${key} in the apps bucket`);
    return JSON.parse((await collect(object.body, Number.MAX_SAFE_INTEGER))!.toString('utf8')) as T;
  }

  /** Records a build's outcome and its cost once, however many times the activity runs. */
  async function settleBuild(
    workspaceId: string,
    build: AppBuild,
    outcome: Parameters<typeof finishBuild>[2],
    units: bigint,
  ): Promise<AppBuildOutcome> {
    return transact(workspaceId, async tx => {
      const { rows } = await tx.client.query(
        `SELECT status FROM ${table(tx, 'tf_app_builds')} WHERE id = $1 FOR UPDATE`,
        [build.id],
      );
      const status = (rows[0] as { status: string } | undefined)?.status;
      if (status !== 'queued' && status !== 'running')
        return { status: status === 'succeeded' ? 'succeeded' : 'failed' };
      await finishBuild(tx, build.id, outcome);
      if (units > 0n) await work.credits.debit(tx, units, { id: `app-build:${build.id}`, activity: 'app-build' });
      if (outcome.ok) await setPreviewBuild(tx, build.id);
      return { status: outcome.ok ? 'succeeded' : 'failed' };
    });
  }

  async function produce(
    workspaceId: string,
    build: AppBuild,
    signal: AbortSignal,
  ): Promise<
    { ok: true; files: readonly AppBuiltFile[]; units: bigint } | { ok: false; failure: AppFailure; units: bigint }
  > {
    const repository = await work.source(workspaceId, build.appId, build.commit);
    if (build.recipe.kind === 'copy') {
      return { ...(await copyTree(repository, build.commit, build.recipe.root)), units: 0n };
    }
    const builder = work.builder!;
    const timeout = AbortSignal.timeout(appLimits.buildSeconds * 1000);
    const result = await builder
      .build(
        {
          workspaceId,
          appId: build.appId,
          buildId: build.id,
          recipe: build.recipe,
          source: () => archive(repository, build.commit),
          limits: {
            seconds: appLimits.buildSeconds,
            outputBytes: appLimits.artifactBytes,
            outputFiles: appLimits.artifactFiles,
          },
        },
        AbortSignal.any([signal, timeout]),
      )
      .catch(error => {
        if (timeout.aborted) return { ok: false as const, code: 'build-timeout' as const, log: '', units: 0n };
        throw error;
      });
    if (!result.ok)
      return {
        ok: false,
        units: result.units,
        failure: failure(
          result.code,
          result.code === 'build-timeout' ? 'The build ran longer than 10 minutes' : 'The build command failed',
        ),
      };
    // Tar adds a header and padding per file; anything beyond that allowance is over the artifact limit.
    const tar = await collect(result.output(), appLimits.artifactBytes + (appLimits.artifactFiles + 2) * 1024);
    if (!tar)
      return {
        ok: false,
        units: result.units,
        failure: failure('limit-exceeded', 'The build output is larger than 50 MB'),
      };
    return { ...untar(tar), units: result.units };
  }

  async function projectEdge(input: { readonly workspaceId: string; readonly appId: string }, signal: AbortSignal) {
    const app = await transact(input.workspaceId, tx => readApp(tx, input.appId as AppId));
    if (!app?.publicName) return { route: null };
    const route: AppRoute = {
      name: app.publicName,
      releaseId: app.liveReleaseId,
      status: edgeStatus(app.stops),
      version: app.edgeVersion,
    };
    await platform.query(
      `UPDATE app.app_hostnames SET release_id = $4, status = $5, edge_version = $6
       WHERE name = $1 AND workspace_id = $2 AND app_id = $3 AND edge_version < $6`,
      [route.name, input.workspaceId, input.appId, route.releaseId, route.status, route.version],
    );
    if (publisher) await publisher.apply(route, signal);
    return { route };
  }

  /**
   * Charges one closed window of delivered traffic per app, whatever the workspace's app-hosting flag, since billing
   * follows serving. A window already recorded is skipped, so running it again charges nothing. An app whose workspace
   * runs out of credits or passes its monthly limit is paused.
   */
  async function meterWindow(window: { readonly start: string; readonly end: string }, signal: AbortSignal) {
    if (!publisher) return;
    const traffic = new Map<string, { requests: number; bytes: number; units: bigint }>();
    for await (const used of publisher.usage(window, signal)) {
      const total = traffic.get(used.name) ?? { requests: 0, bytes: 0, units: 0n };
      traffic.set(used.name, {
        requests: total.requests + used.requests,
        bytes: total.bytes + used.bytes,
        units: total.units + used.units,
      });
    }
    // Every served app records the window, with no traffic too, so the next run knows where to resume.
    const { rows: owners } = await platform.query(
      `SELECT name, workspace_id, app_id FROM app.app_hostnames
       WHERE name = ANY($1::text[]) OR (state = 'current' AND status IS NOT NULL)`,
      [[...traffic.keys()]],
    );
    const perApp = new Map<
      string,
      { workspaceId: string; appId: string; requests: number; bytes: number; units: bigint }
    >();
    for (const owner of owners as { name: string; workspace_id: string; app_id: string }[]) {
      const used = traffic.get(owner.name) ?? { requests: 0, bytes: 0, units: 0n };
      const key = `${owner.workspace_id}/${owner.app_id}`;
      const total = perApp.get(key) ?? {
        workspaceId: owner.workspace_id,
        appId: owner.app_id,
        requests: 0,
        bytes: 0,
        units: 0n,
      };
      perApp.set(key, {
        ...total,
        requests: total.requests + used.requests,
        bytes: total.bytes + used.bytes,
        units: total.units + used.units,
      });
    }
    const failures: unknown[] = [];
    for (const used of perApp.values()) {
      signal.throwIfAborted();
      try {
        const paused = await transact(used.workspaceId, async tx => {
          const inserted = await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_app_usage_windows')} (app_id, window_start, requests, bytes, units)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
            [used.appId, window.start, used.requests, used.bytes, used.units.toString()],
          );
          if (inserted.rowCount !== 1 || used.units === 0n) return false;
          await work.credits.debit(tx, used.units, {
            id: `app-hosting:${used.appId}:${window.start}`,
            activity: 'app-hosting',
          });
          const app = await readApp(tx, used.appId as AppId, true);
          if (!app || app.stops.budgetPausedAt) return false;
          const available = await work.credits.available(tx);
          const limit = app.approval.state === 'approved' ? app.approval.monthlyLimitUnits : null;
          const { rows } = await tx.client.query(
            `SELECT COALESCE(SUM(units), 0)::text AS units FROM ${table(tx, 'tf_app_usage_windows')}
             WHERE app_id = $1 AND window_start >= date_trunc('month', $2::timestamptz, 'UTC')`,
            [used.appId, window.start],
          );
          const month = BigInt((rows[0] as { units: string }).units);
          if ((available === null || available > 0n) && (limit === null || month <= limit)) return false;
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_apps')} SET budget_paused_at = clock_timestamp(), edge_version = edge_version + 1
             WHERE id = $1 AND budget_paused_at IS NULL`,
            [used.appId],
          );
          return true;
        });
        if (paused) await projectEdge(used, signal);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'App usage metering failed');
  }

  return {
    /** Builds a queued build once. A build that already finished returns its outcome. */
    async buildApp(input: { readonly workspaceId: string; readonly buildId: string }): Promise<AppBuildOutcome> {
      const id = input.buildId as AppBuildId;
      const build = await transact(input.workspaceId, async tx => {
        const found = await readBuild(tx, id);
        if (!found) throw new Error(`App build ${id} not found`);
        if (found.status.status === 'succeeded' || found.status.status === 'failed') return found;
        if (found.recipe.kind === 'command') {
          if (!work.builder) return found;
          const available = await work.credits.available(tx, { lock: true });
          if (available !== null && available <= 0n) return found;
        }
        return startBuild(tx, id);
      });
      if (build.status.status === 'succeeded' || build.status.status === 'failed')
        return { status: build.status.status };
      if (build.recipe.kind === 'command' && !work.builder)
        return settleBuild(
          input.workspaceId,
          build,
          { ok: false, failure: failure('builder-unavailable', 'This server cannot run build commands') },
          0n,
        );
      if (build.status.status === 'queued')
        return settleBuild(
          input.workspaceId,
          build,
          { ok: false, failure: failure('budget-exhausted', 'The workspace has no credits left for builds') },
          0n,
        );
      return heartbeating(async signal => {
        const produced = await produce(input.workspaceId, build, signal);
        if (!produced.ok) return settleBuild(input.workspaceId, build, produced, produced.units);
        const manifest = appManifest(produced.files);
        if (!manifest.ok) return settleBuild(input.workspaceId, build, manifest, produced.units);
        for (const file of manifest.files) {
          const key = `blobs/${file.sha256}`;
          if (await objects.has(key, signal)) continue;
          await objects.put(
            key,
            bytesOf(manifest.contents.get(file.path)!),
            { contentType: file.contentType, bytes: file.bytes },
            signal,
          );
        }
        const body = Buffer.from(JSON.stringify(manifest.files));
        const manifestKey = `builds/${build.id}/manifest.json`;
        await objects.put(manifestKey, bytesOf(body), { contentType: 'application/json', bytes: body.length }, signal);
        return settleBuild(
          input.workspaceId,
          build,
          {
            ok: true,
            manifestKey,
            manifestDigest: createHash('sha256').update(body).digest('hex'),
            files: manifest.files.length,
            bytes: manifest.bytes,
          },
          produced.units,
        );
      });
    },

    /** Copies the operation's release into delivery. Returns false when the operation has already ended. */
    async stageAppRelease(input: { readonly workspaceId: string; readonly operationId: string }): Promise<boolean> {
      const id = input.operationId as AppOperationId;
      if (!publisher) {
        await transact(input.workspaceId, tx =>
          failOperation(tx, id, failure('publisher-unavailable', 'This server has no app sites domain set up')),
        );
        return false;
      }
      const target = await transact(input.workspaceId, async tx => {
        const operation = await readOperation(tx, id);
        if (!operation) throw new Error(`App operation ${id} not found`);
        if (operation.status !== 'admitted' && operation.status !== 'staging') return null;
        await markOperationStaging(tx, id);
        const release = (await readRelease(tx, operation.targetReleaseId!))!;
        const build = (await readBuild(tx, release.buildId))!;
        return { release, manifestKey: build.manifestKey! };
      });
      if (!target) return false;
      await heartbeating(async signal => {
        const files = await readJson<AppFile[]>(target.manifestKey, signal);
        await publisher.stage(
          {
            releaseId: target.release.id,
            files,
            read: file =>
              (async function* () {
                const object = await objects.get(`blobs/${file.sha256}`, signal);
                if (!object) throw new Error(`Missing blob ${file.sha256} in the apps bucket`);
                yield* object.body;
              })(),
          },
          signal,
        );
      });
      await transact(input.workspaceId, tx => markReleaseStaged(tx, target.release.id));
      return true;
    },

    /** Ends an operation whose staging kept failing. The live release keeps serving. */
    async failAppOperation(input: {
      readonly workspaceId: string;
      readonly operationId: string;
      readonly message: string;
    }) {
      await transact(input.workspaceId, tx =>
        failOperation(tx, input.operationId as AppOperationId, failure('publisher-unavailable', input.message, true)),
      );
    },

    /** Points the app at the operation's release unless a newer operation has. Returns the app to project, if any. */
    async switchAppRelease(input: { readonly workspaceId: string; readonly operationId: string }) {
      const { operation, edgeVersion } = await transact(input.workspaceId, tx =>
        switchRelease(tx, input.operationId as AppOperationId),
      );
      return { appId: operation.appId as string, status: operation.status, switched: edgeVersion !== null };
    },

    async projectAppEdge(input: { readonly workspaceId: string; readonly appId: string }) {
      return heartbeating(signal => projectEdge(input, signal));
    },

    /** Repairs publisher routes, edge projections, stale name claims and staged releases nothing refers to. */
    async reconcileApps(signal: AbortSignal) {
      type NameRow = {
        name: string;
        workspace_id: string;
        app_id: string;
        state: 'claiming' | 'current' | 'retired';
        release_id: string | null;
        status: AppRoute['status'] | null;
        edge_version: string;
        stale: boolean;
      };
      const readNames = async () =>
        (
          await platform.query(
            `SELECT name, workspace_id, app_id, state, release_id, status, edge_version,
               claimed_at < clock_timestamp() - interval '15 minutes' AS stale
             FROM app.app_hostnames`,
          )
        ).rows as NameRow[];
      const failures: unknown[] = [];
      const enabled = new Map<string, boolean>();
      const isEnabled = async (workspaceId: string) => {
        if (!enabled.has(workspaceId)) enabled.set(workspaceId, await work.enabled(workspaceId));
        return enabled.get(workspaceId)!;
      };

      const held = new Map<string, AppRoute>();
      if (publisher) for await (const route of publisher.list(signal)) held.set(route.name, route);
      // Read after listing, so a rename that went live during the listing is seen as current. Retired is final.
      const names = await readNames();
      const byName = new Map(names.map(row => [row.name, row]));
      if (publisher) {
        for (const row of names) {
          if (row.state !== 'current' || row.status === null || !(await isEnabled(row.workspace_id))) continue;
          const version = Number(row.edge_version);
          if ((held.get(row.name)?.version ?? -1) >= version) continue;
          await publisher.apply({ name: row.name, releaseId: row.release_id, status: row.status, version }, signal);
        }
        for (const route of held.values()) {
          const state = byName.get(route.name)?.state;
          if (state === undefined || state === 'retired')
            await publisher.remove({ name: route.name, version: route.version + 1 }, signal);
        }
      }

      const byWorkspace = new Map<string, NameRow[]>();
      for (const row of names)
        if (row.state !== 'retired')
          byWorkspace.set(row.workspace_id, [...(byWorkspace.get(row.workspace_id) ?? []), row]);
      for (const [workspaceId, rows] of byWorkspace) {
        signal.throwIfAborted();
        if (!(await isEnabled(workspaceId))) continue;
        try {
          const apps = await transact(workspaceId, async tx => {
            const { rows: found } = await tx.client.query(
              `SELECT id, public_name, edge_version FROM ${table(tx, 'tf_apps')} WHERE id = ANY($1::uuid[])`,
              [rows.map(row => row.app_id)],
            );
            return new Map(
              (found as { id: string; public_name: string | null; edge_version: string }[]).map(app => [app.id, app]),
            );
          });
          for (const row of rows) {
            const app = apps.get(row.app_id);
            if (row.state === 'claiming' && row.stale && app?.public_name !== row.name)
              await platform.query(
                `UPDATE app.app_hostnames SET state = 'retired', retired_at = clock_timestamp()
                 WHERE name = $1 AND state = 'claiming'`,
                [row.name],
              );
            if (row.state === 'current' && app && Number(app.edge_version) > Number(row.edge_version))
              await projectEdge({ workspaceId, appId: row.app_id }, signal);
          }
        } catch (error) {
          failures.push(error);
        }
      }

      if (publisher) {
        // Listed before releases are marked, so a release created during this reconcile is not discarded.
        const staged: string[] = [];
        for await (const { releaseId } of publisher.releases(signal)) staged.push(releaseId);
        const known = new Set<string>();
        let complete = true;
        for await (const workspaceId of work.workspaces()) {
          signal.throwIfAborted();
          try {
            const { found, discarded } = await transact(workspaceId, async tx => {
              const releases = table(tx, 'tf_app_releases');
              const operations = table(tx, 'tf_app_operations');
              // Locked in its own statement so the next one reads every rollback admitted before the lock was taken.
              const { rows: found } = await tx.client.query(
                `SELECT id FROM ${releases} WHERE id::text = ANY($1::text[]) ORDER BY id FOR UPDATE`,
                [staged],
              );
              // A release is kept while it is live, the target of an unfinished operation, among the newest switched
              // releases of its app, or recently created. Clearing staged_at stops a rollback from choosing it.
              const { rows: discarded } = await tx.client.query(
                `UPDATE ${releases} r SET staged_at = NULL FROM ${table(tx, 'tf_apps')} a
                 WHERE a.id = r.app_id AND r.id::text = ANY($1::text[])
                   AND r.id IS DISTINCT FROM a.live_release_id
                   AND r.created_at <= clock_timestamp() - interval '1 hour'
                   AND NOT EXISTS (SELECT 1 FROM ${operations} o
                                   WHERE o.target_release_id = r.id AND o.status IN ('admitted', 'staging'))
                   AND r.id NOT IN (
                     SELECT id FROM (
                       SELECT s.id, row_number() OVER (PARTITION BY s.app_id ORDER BY s.number DESC) AS rank
                       FROM ${releases} s
                       WHERE EXISTS (SELECT 1 FROM ${operations} o
                                     WHERE o.target_release_id = s.id AND o.status = 'switched')
                     ) ranked WHERE rank <= $2)
                 RETURNING r.id`,
                [staged, appLimits.retainedReleases],
              );
              return {
                found: (found as { id: string }[]).map(release => release.id),
                discarded: (discarded as { id: string }[]).map(release => release.id),
              };
            });
            for (const id of found) known.add(id);
            for (const releaseId of discarded) await publisher.discard({ releaseId }, signal);
          } catch (error) {
            complete = false;
            failures.push(error);
          }
        }
        if (complete)
          for (const releaseId of staged) if (!known.has(releaseId)) await publisher.discard({ releaseId }, signal);
      }
      if (failures.length) throw new AggregateError(failures, 'App reconcile failed');
    },

    meterAppUsage: meterWindow,

    /**
     * Meters the last closed hour before `settled` and each earlier one a served app has not recorded yet, resuming
     * after the app's newest recorded hour and reaching back at most 48 hours. Recorded hours are skipped.
     */
    async meterAppTraffic(settled: number, signal: AbortSignal) {
      if (!publisher) return;
      const hour = 3_600_000;
      let from = settled - hour;
      const floor = settled - 48 * hour;
      const { rows: served } = await platform.query(
        `SELECT workspace_id, array_agg(app_id) AS apps FROM app.app_hostnames
         WHERE state = 'current' AND status IS NOT NULL GROUP BY workspace_id`,
      );
      const failures: unknown[] = [];
      for (const { workspace_id: workspaceId, apps } of served as { workspace_id: string; apps: string[] }[]) {
        signal.throwIfAborted();
        try {
          const next = await transact(workspaceId, async tx => {
            const { rows } = await tx.client.query(
              `SELECT MIN(COALESCE(
                 (SELECT MAX(w.window_start) + interval '1 hour' FROM ${table(tx, 'tf_app_usage_windows')} w
                  WHERE w.app_id = a.id),
                 date_trunc('hour', a.created_at))) AS next
               FROM ${table(tx, 'tf_apps')} a WHERE a.id = ANY($1::uuid[])`,
              [apps],
            );
            return (rows[0] as { next: Date | null }).next?.getTime() ?? settled;
          });
          from = Math.min(from, Math.max(next, floor));
        } catch (error) {
          failures.push(error);
        }
      }
      for (let start = from; start + hour <= settled; start += hour)
        await meterWindow(
          { start: new Date(start).toISOString(), end: new Date(start + hour).toISOString() },
          signal,
        ).catch(error => failures.push(error));
      if (failures.length) throw new AggregateError(failures, 'App usage metering failed');
    },
  };
}

export type AppActivities = ReturnType<typeof createAppActivities>;
