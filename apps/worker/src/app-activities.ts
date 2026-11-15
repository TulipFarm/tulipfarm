import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { Context } from '@temporalio/activity';
import {
  appBuilders,
  appLimits,
  edgeStatus,
  recipeBuilder,
  type AppBuildId,
  type AppFailure,
  type AppId,
  type AppOperationId,
} from '@tulipfarm/apps';
import type { AppSiteStorage } from '@tulipfarm/apps/host-header-publisher';
import {
  appRouteFromRow,
  failOperation,
  finishBuild,
  markOperationStaging,
  markReleaseStaged,
  readApp,
  readAppRuntime,
  readBuild,
  readOperation,
  readRelease,
  setPreviewBuild,
  startBuild,
  switchRelease,
  type AppBuild,
  type AppRecord,
  type AppTransaction,
} from '@tulipfarm/apps/store';
import type {
  AppBuilder,
  AppFile,
  AppHost,
  AppPublisher,
  AppRoute,
  AppServerBuildOutput,
  CreditGate,
} from '@tulipfarm/extensions';
import {
  errorAttributes,
  log,
  recordAppBuild,
  recordAppReconcileRepair,
  recordAppUsageReadFailure,
} from '@tulipfarm/observability';
import { escapeIdentifier } from 'pg';
import { appManifest, untar, type AppBuiltFile } from './app-files.ts';

const execute = promisify(execFile);

const hour = 3_600_000;
/** Delivery logs arrive late, and the hosted publisher reads an hour's usage only once it ended this long ago. */
export const APP_USAGE_SETTLE_MS = 2 * hour;
/** The end of the newest hour whose usage can be read at `now`. */
const settledBefore = (now: number) => Math.floor((now - APP_USAGE_SETTLE_MS) / hour) * hour;
/**
 * Keeps the names `h` of workspaces whose storage still exists. A deleted workspace's storage is unavailable for good,
 * the same test `app.workspace_access` refuses it by, while its names stay behind.
 */
const inLiveWorkspace = `JOIN app.workspace_storage s ON s.workspace_id = h.workspace_id AND s.stage <> 'unavailable'`;

type UsageWindow = { readonly start: string; readonly end: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Traffic = { requests: number; bytes: number; units: bigint };
/** Server compute per app id in one window, or undefined while the host cannot report it. */
type Compute = Map<string, bigint> | undefined;
/** An app's share of a window: its traffic, or undefined when the window's traffic was charged by an earlier run. */
type AppUsage = { readonly workspaceId: string; readonly appId: string; readonly traffic?: Traffic };

export type PlatformClient = {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
};

/** The workspaces that hold an app name and have not been deleted. */
export async function namedWorkspaces(platform: PlatformClient) {
  const { rows } = await platform.query(`SELECT DISTINCT h.workspace_id FROM app.app_hostnames h ${inLiveWorkspace}`);
  return (rows as { workspace_id: string }[]).map(row => row.workspace_id);
}

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
  /** Runs server apps; `unavailableAppHost` when this server cannot. */
  readonly host: AppHost;
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
export async function heartbeating<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
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

export async function collect(stream: AsyncIterable<Uint8Array>, limit: number) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Where a server build's output is kept: the artifact and the contract that starts it, as JSON. */
export const serverOutputKey = (buildId: string) => `builds/${buildId}/server.json`;

export async function* bytesOf(object: Buffer): AsyncIterable<Uint8Array> {
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
    const settled = await transact(workspaceId, async tx => {
      const { rows } = await tx.client.query(
        `SELECT status FROM ${table(tx, 'tf_app_builds')} WHERE id = $1 FOR UPDATE`,
        [build.id],
      );
      const status = (rows[0] as { status: string } | undefined)?.status;
      if (status !== 'queued' && status !== 'running')
        return { status: status === 'succeeded' ? ('succeeded' as const) : ('failed' as const), now: false };
      await finishBuild(tx, build.id, outcome);
      if (units > 0n) await work.credits.debit(tx, units, { id: `app-build:${build.id}`, activity: 'app-build' });
      // The draft preview serves files; a server build has none.
      if (outcome.ok && build.recipe.kind !== 'server') await setPreviewBuild(tx, build.id);
      return { status: outcome.ok ? ('succeeded' as const) : ('failed' as const), now: true };
    });
    if (settled.now) recordAppBuild(outcome.ok ? null : outcome.failure.code);
    return { status: settled.status };
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
    if (build.recipe.kind === 'server') throw new Error('Server recipes build through buildServer');
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

  async function produceServer(
    workspaceId: string,
    build: AppBuild,
    signal: AbortSignal,
  ): Promise<
    { ok: true; output: AppServerBuildOutput; units: bigint } | { ok: false; failure: AppFailure; units: bigint }
  > {
    if (build.recipe.kind !== 'server') throw new Error(`Build ${build.id} is not a server build`);
    const recipe = build.recipe;
    const repository = await work.source(workspaceId, build.appId, build.commit);
    const timeout = AbortSignal.timeout(appLimits.buildSeconds * 1000);
    const result = await work.builder!.buildServer!(
      {
        workspaceId,
        appId: build.appId,
        buildId: build.id,
        recipe,
        source: () => archive(repository, build.commit),
        limits: {
          seconds: appLimits.buildSeconds,
          outputBytes: appLimits.artifactBytes,
          outputFiles: appLimits.artifactFiles,
        },
      },
      AbortSignal.any([signal, timeout]),
    ).catch(error => {
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
    return { ok: true, output: result.output, units: result.units };
  }

  async function projectEdge(input: { readonly workspaceId: string; readonly appId: string }, signal: AbortSignal) {
    const found = await transact(input.workspaceId, async tx => {
      const app = await readApp(tx, input.appId as AppId);
      return app && { app, server: (await readAppRuntime(tx, app.id)) !== null };
    });
    const name = found?.app.publicName;
    if (!found || !name) return { route: null };
    const { app, server } = found;
    const common = { name, status: edgeStatus(app.stops), version: app.edgeVersion };
    const route: AppRoute = server
      ? { ...common, kind: 'server' }
      : { ...common, kind: 'static', releaseId: app.liveReleaseId };
    await platform.query(
      `UPDATE app.app_hostnames SET kind = $4, release_id = $5, status = $6, edge_version = $7
       WHERE name = $1 AND workspace_id = $2 AND app_id = $3 AND edge_version < $7`,
      [
        route.name,
        input.workspaceId,
        input.appId,
        route.kind,
        route.kind === 'static' ? route.releaseId : null,
        route.status,
        route.version,
      ],
    );
    if (publisher) await publisher.apply(route, signal);
    return { route };
  }

  /** Whether a credit pause holds: the workspace has no credits, or the app passed its limit in the UTC month of `at`. */
  async function overBudget(tx: AppTransaction, app: AppRecord, at: string) {
    const available = await work.credits.available(tx);
    if (available !== null && available <= 0n) return true;
    const limit = app.approval.state === 'approved' ? app.approval.monthlyLimitUnits : null;
    if (limit === null) return false;
    const { rows } = await tx.client.query(
      `SELECT COALESCE(SUM(units), 0)::text AS units FROM ${table(tx, 'tf_app_usage_windows')}
       WHERE app_id = $1 AND window_start >= date_trunc('month', $2::timestamptz, 'UTC')`,
      [app.id, at],
    );
    return BigInt((rows[0] as { units: string }).units) > limit;
  }

  /** Clears the credit pause of each app whose cause is gone as of the newest settled hour, and serves it again. */
  async function liftBudgetPauses(workspaceId: string, appIds: readonly string[], now: number, signal: AbortSignal) {
    const at = new Date(settledBefore(now) - hour).toISOString();
    const lifted = await transact(workspaceId, async tx => {
      const ids: string[] = [];
      for (const id of appIds) {
        const app = await readApp(tx, id as AppId, true);
        if (!app?.stops.budgetPausedAt || (await overBudget(tx, app, at))) continue;
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_apps')} SET budget_paused_at = NULL, edge_version = edge_version + 1 WHERE id = $1`,
          [id],
        );
        ids.push(id);
      }
      return ids;
    });
    for (const appId of lifted) await projectEdge({ workspaceId, appId }, signal);
  }

  async function readTraffic(window: UsageWindow, signal: AbortSignal) {
    const traffic = new Map<string, Traffic>();
    for await (const used of publisher!.usage(window, signal)) {
      const total = traffic.get(used.name) ?? { requests: 0, bytes: 0, units: 0n };
      traffic.set(used.name, {
        requests: total.requests + used.requests,
        bytes: total.bytes + used.bytes,
        units: total.units + used.units,
      });
    }
    return traffic;
  }

  /** A host that cannot report the window is logged and counted, not thrown, so traffic billing goes on without it. */
  async function readCompute(window: UsageWindow, signal: AbortSignal): Promise<Compute> {
    const compute = new Map<string, bigint>();
    if (!work.host.usage) return compute;
    try {
      for await (const used of work.host.usage(window, signal)) {
        const appId = used.appId.toLowerCase();
        if (uuid.test(appId)) compute.set(appId, (compute.get(appId) ?? 0n) + used.units);
      }
      return compute;
    } catch (error) {
      signal.throwIfAborted();
      recordAppUsageReadFailure('compute');
      log('error', 'dependency', 'call_failed', { operation: 'app.compute_usage', ...errorAttributes(error) });
      return undefined;
    }
  }

  /**
   * The apps traffic billing charges for a window, whatever the workspace's app-hosting flag, since billing follows
   * serving: each app with traffic on any of its names, and each app served now, so the next run knows where to resume.
   */
  async function trafficByApp(traffic: Map<string, Traffic>) {
    const { rows: owners } = await platform.query(
      `SELECT h.name, h.workspace_id, h.app_id FROM app.app_hostnames h ${inLiveWorkspace}
       WHERE h.name = ANY($1::text[]) OR (h.state = 'current' AND h.status IS NOT NULL)`,
      [[...traffic.keys()]],
    );
    const perApp = new Map<string, AppUsage & { traffic: Traffic }>();
    for (const owner of owners as { name: string; workspace_id: string; app_id: string }[]) {
      const used = traffic.get(owner.name) ?? { requests: 0, bytes: 0, units: 0n };
      const key = `${owner.workspace_id}/${owner.app_id}`;
      const total = perApp.get(key)?.traffic ?? { requests: 0, bytes: 0, units: 0n };
      perApp.set(key, {
        workspaceId: owner.workspace_id,
        appId: owner.app_id,
        traffic: {
          requests: total.requests + used.requests,
          bytes: total.bytes + used.bytes,
          units: total.units + used.units,
        },
      });
    }
    return perApp;
  }

  /**
   * Records an app's traffic for a window with its compute when the host reported it, and debits both at once. Once
   * the traffic is recorded, only compute still unsettled is charged, so a window's compute only ever lands on an app
   * traffic billing charged. Each part is charged once however often this runs. An app whose workspace runs out of
   * credits or passes its monthly limit is paused.
   */
  async function chargeApp(window: UsageWindow, used: AppUsage, compute: Compute, signal: AbortSignal) {
    const computed = compute && (compute.get(used.appId) ?? 0n);
    if (!used.traffic && computed === undefined) return;
    const paused = await transact(used.workspaceId, async tx => {
      const windows = table(tx, 'tf_app_usage_windows');
      let charge: { readonly id: string; readonly units: bigint } | undefined;
      if (used.traffic) {
        const units = used.traffic.units + (computed ?? 0n);
        const inserted = await tx.client.query(
          `INSERT INTO ${windows} (app_id, window_start, requests, bytes, units, compute_units)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
          [
            used.appId,
            window.start,
            used.traffic.requests,
            used.traffic.bytes,
            units.toString(),
            computed?.toString() ?? null,
          ],
        );
        if (inserted.rowCount === 1) charge = { id: `app-hosting:${used.appId}:${window.start}`, units };
      }
      if (!charge && computed !== undefined) {
        const settled = await tx.client.query(
          `UPDATE ${windows} SET compute_units = $3, units = units + $3
           WHERE app_id = $1 AND window_start = $2 AND compute_units IS NULL`,
          [used.appId, window.start, computed.toString()],
        );
        if (settled.rowCount === 1)
          charge = { id: `app-hosting:${used.appId}:${window.start}:compute`, units: computed };
      }
      if (!charge || charge.units === 0n) return false;
      await work.credits.debit(tx, charge.units, { id: charge.id, activity: 'app-hosting' });
      const app = await readApp(tx, used.appId as AppId, true);
      if (!app || app.stops.budgetPausedAt || !(await overBudget(tx, app, window.start))) return false;
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_apps')} SET budget_paused_at = clock_timestamp(), edge_version = edge_version + 1
         WHERE id = $1 AND budget_paused_at IS NULL`,
        [used.appId],
      );
      return true;
    });
    if (paused) await projectEdge(used, signal);
  }

  /** Charges each app outside the skipped workspaces, and returns the workspaces that failed with their errors. */
  async function chargeWindow(
    window: UsageWindow,
    apps: Iterable<AppUsage>,
    compute: Compute,
    signal: AbortSignal,
    skip: ReadonlySet<string> = new Set(),
  ) {
    const failures: { workspaceId: string; error: unknown }[] = [];
    for (const used of apps) {
      signal.throwIfAborted();
      if (skip.has(used.workspaceId)) continue;
      try {
        await chargeApp(window, used, compute, signal);
      } catch (error) {
        failures.push({ workspaceId: used.workspaceId, error });
      }
    }
    return failures;
  }

  async function meterWindow(window: UsageWindow, signal: AbortSignal) {
    if (!publisher) return;
    const apps = await trafficByApp(await readTraffic(window, signal));
    const failures = await chargeWindow(window, apps.values(), await readCompute(window, signal), signal);
    if (failures.length)
      throw new AggregateError(
        failures.map(failure => failure.error),
        'App usage metering failed',
      );
  }

  return {
    /** Builds a queued build once. A build that already finished returns its outcome. */
    async buildApp(input: { readonly workspaceId: string; readonly buildId: string }): Promise<AppBuildOutcome> {
      const id = input.buildId as AppBuildId;
      const build = await transact(input.workspaceId, async tx => {
        const found = await readBuild(tx, id);
        if (!found) throw new Error(`App build ${id} not found`);
        if (found.status.status === 'succeeded' || found.status.status === 'failed') return found;
        if (found.recipe.kind !== 'copy') {
          if (!work.builder) return found;
          const available = await work.credits.available(tx, { lock: true });
          if (available !== null && available <= 0n) return found;
        }
        return startBuild(tx, id);
      });
      if (build.status.status === 'succeeded' || build.status.status === 'failed')
        return { status: build.status.status };
      const chosen = recipeBuilder(build.recipe, appBuilders(work.builder, work.host));
      if (!chosen.ok) return settleBuild(input.workspaceId, build, chosen, 0n);
      if (build.status.status === 'queued')
        return settleBuild(
          input.workspaceId,
          build,
          { ok: false, failure: failure('budget-exhausted', 'The workspace has no credits left for builds') },
          0n,
        );
      if (build.recipe.kind === 'server')
        return heartbeating(async signal => {
          const produced = await produceServer(input.workspaceId, build, signal);
          if (!produced.ok) return settleBuild(input.workspaceId, build, produced, produced.units);
          const body = Buffer.from(JSON.stringify(produced.output));
          const manifestKey = serverOutputKey(build.id);
          await objects.put(
            manifestKey,
            bytesOf(body),
            { contentType: 'application/json', bytes: body.length },
            signal,
          );
          return settleBuild(
            input.workspaceId,
            build,
            {
              ok: true,
              manifestKey,
              manifestDigest: createHash('sha256').update(body).digest('hex'),
              files: 0,
              bytes: 0,
            },
            produced.units,
          );
        });
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

    /**
     * Repairs publisher routes, edge projections, stale name claims, names held by deleted workspaces and staged
     * releases nothing refers to.
     */
    async reconcileApps(signal: AbortSignal, now = Date.now()) {
      type NameRow = {
        name: string;
        workspace_id: string;
        app_id: string;
        state: 'claiming' | 'current' | 'retired';
        kind: AppRoute['kind'];
        release_id: string | null;
        status: AppRoute['status'] | null;
        edge_version: string;
        stale: boolean;
      };
      const readNames = async () =>
        (
          await platform.query(
            `SELECT name, workspace_id, app_id, state, kind, release_id, status, edge_version,
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

      // A deleted workspace's storage never comes back, so its names are retired and their routes removed below.
      const { rowCount: orphaned } = await platform.query(
        `UPDATE app.app_hostnames h SET state = 'retired', retired_at = clock_timestamp()
         FROM app.workspace_storage s
         WHERE s.workspace_id = h.workspace_id AND s.stage = 'unavailable' AND h.state <> 'retired'`,
      );
      for (let i = 0; i < (orphaned ?? 0); i++) recordAppReconcileRepair('name-retired');

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
          await publisher.apply(appRouteFromRow(row)!, signal);
          recordAppReconcileRepair('route-applied');
        }
        for (const route of held.values()) {
          const state = byName.get(route.name)?.state;
          if (state === undefined || state === 'retired') {
            await publisher.remove({ name: route.name, version: route.version + 1 }, signal);
            recordAppReconcileRepair('route-removed');
          }
        }
      }

      const byWorkspace = new Map<string, NameRow[]>();
      for (const row of names)
        if (row.state !== 'retired')
          byWorkspace.set(row.workspace_id, [...(byWorkspace.get(row.workspace_id) ?? []), row]);
      for (const [workspaceId, rows] of byWorkspace) {
        signal.throwIfAborted();
        try {
          const paused = rows.filter(row => row.state === 'current' && row.status === 'paused');
          if (paused.length)
            await liftBudgetPauses(
              workspaceId,
              paused.map(row => row.app_id),
              now,
              signal,
            );
          if (!(await isEnabled(workspaceId))) continue;
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
            if (row.state === 'claiming' && row.stale && app?.public_name !== row.name) {
              const retired = await platform.query(
                `UPDATE app.app_hostnames SET state = 'retired', retired_at = clock_timestamp()
                 WHERE name = $1 AND state = 'claiming'`,
                [row.name],
              );
              if (retired.rowCount) recordAppReconcileRepair('claim-retired');
            }
            if (row.state === 'current' && app && Number(app.edge_version) > Number(row.edge_version)) {
              await projectEdge({ workspaceId, appId: row.app_id }, signal);
              recordAppReconcileRepair('edge-projected');
            }
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
            for (const releaseId of discarded) {
              await publisher.discard({ releaseId }, signal);
              recordAppReconcileRepair('release-discarded');
            }
          } catch (error) {
            complete = false;
            failures.push(error);
          }
        }
        if (complete)
          for (const releaseId of staged) {
            if (known.has(releaseId)) continue;
            await publisher.discard({ releaseId }, signal);
            recordAppReconcileRepair('release-discarded');
          }
      }
      if (failures.length) throw new AggregateError(failures, 'App reconcile failed');
    },

    meterAppUsage: meterWindow,

    /**
     * Meters the newest settled hour, so traffic on a name retired in it is charged, and each earlier one a served app
     * has not recorded, resuming after its newest recorded hour and reaching back at most 48 hours. Metering stops at
     * the first hour whose traffic the publisher cannot read, so no later hour is recorded ahead of it, and returns
     * that hour; the next run reads it again. Compute the host cannot report holds nothing back: its hours stay
     * unsettled and a later run within the same 48 hours charges them, even once the app is no longer served. A
     * workspace that fails is left out of the rest of the run and the others are still charged; the run then throws.
     * Its cursor in `app.app_usage_cursors` stays where this run started, so the next run reads its missed hours
     * again, even when it serves no app and owes only for traffic on retired names. A deleted workspace is not
     * metered, so what it had not been charged is dropped.
     */
    async meterAppTraffic(now: number, signal: AbortSignal) {
      if (!publisher) return undefined;
      const settled = settledBefore(now);
      let from = settled - hour;
      const floor = settled - 48 * hour;
      // Usage windows are only recorded for apps that hold a name, and names are never deleted, so every unsettled
      // window is in a workspace listed here, whether or not it serves an app now.
      const { rows: named } = await platform.query(
        `SELECT h.workspace_id, MIN(c.metered_before) AS metered_before,
           COALESCE(array_agg(h.app_id) FILTER (WHERE h.state = 'current' AND h.status IS NOT NULL), '{}') AS apps
         FROM app.app_hostnames h ${inLiveWorkspace}
         LEFT JOIN app.app_usage_cursors c ON c.workspace_id = h.workspace_id
         GROUP BY h.workspace_id`,
      );
      const pending = new Map<number, Map<string, AppUsage>>();
      const failures: unknown[] = [];
      // Hours other workspaces already recorded are not charged again when a failed workspace holds the start back.
      const failed = new Set<string>();
      type Named = { workspace_id: string; metered_before: Date | null; apps: string[] };
      for (const { workspace_id: workspaceId, metered_before: cursor, apps } of named as Named[]) {
        signal.throwIfAborted();
        from = Math.min(from, Math.max(cursor?.getTime() ?? settled, floor));
        try {
          const next = await transact(workspaceId, async tx => {
            const { rows: unsettled } = await tx.client.query(
              `SELECT app_id, window_start FROM ${table(tx, 'tf_app_usage_windows')}
               WHERE compute_units IS NULL AND window_start >= $1`,
              [new Date(floor).toISOString()],
            );
            for (const row of unsettled as { app_id: string; window_start: Date }[]) {
              const unsettledApps = pending.get(row.window_start.getTime()) ?? new Map<string, AppUsage>();
              unsettledApps.set(`${workspaceId}/${row.app_id}`, { workspaceId, appId: row.app_id });
              pending.set(row.window_start.getTime(), unsettledApps);
            }
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
          failed.add(workspaceId);
          failures.push(error);
        }
      }
      const starts = new Set(pending.keys());
      for (let start = from; start + hour <= settled; start += hour) starts.add(start);
      let hostReports = true;
      let unread: { window: UsageWindow; error: unknown } | undefined;
      for (const start of [...starts].sort((a, b) => a - b)) {
        const window = { start: new Date(start).toISOString(), end: new Date(start + hour).toISOString() };
        const apps = pending.get(start) ?? new Map<string, AppUsage>();
        if (start >= from) {
          let traffic: Map<string, Traffic>;
          try {
            traffic = await readTraffic(window, signal);
          } catch (error) {
            signal.throwIfAborted();
            recordAppUsageReadFailure('traffic');
            unread = { window, error };
            break;
          }
          for (const [key, used] of await trafficByApp(traffic)) apps.set(key, used);
        }
        // A host that cannot report one hour is not asked for the next in the same run, so an outage logs once a run.
        const compute: Compute = hostReports ? await readCompute(window, signal) : undefined;
        hostReports &&= compute !== undefined;
        for (const { workspaceId, error } of await chargeWindow(window, apps.values(), compute, signal, failed)) {
          failed.add(workspaceId);
          failures.push(error);
        }
      }
      const workspaces = (named as Named[]).map(row => row.workspace_id);
      const metered = new Date(unread ? Date.parse(unread.window.start) : settled);
      await platform.query(
        `INSERT INTO app.app_usage_cursors (workspace_id, metered_before)
         SELECT * FROM unnest($1::uuid[], $2::timestamptz[])
         ON CONFLICT (workspace_id) DO UPDATE SET metered_before = EXCLUDED.metered_before
         WHERE app.app_usage_cursors.metered_before < EXCLUDED.metered_before`,
        [workspaces, workspaces.map(id => (failed.has(id) ? new Date(from) : metered))],
      );
      if (failures.length) throw new AggregateError(failures, 'App usage metering failed');
      return unread;
    },
  };
}

export type AppActivities = ReturnType<typeof createAppActivities>;
