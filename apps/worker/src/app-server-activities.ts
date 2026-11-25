import {
  appLimits,
  defaultServerSize,
  type AppFailure,
  type AppId,
  type AppOperationId,
  type AppReleaseId,
  type AppServerSize,
} from '@tulipfarm/apps';
import {
  failDraftHost,
  failOperation,
  markOperationStaging,
  markReleaseStaged,
  readApp,
  readAppRuntime,
  readBuild,
  readDraftHost,
  readOperation,
  readRelease,
  readRuntimeTarget,
  recordAppEndpoint,
  recordAppEndpointTarget,
  recordDraftHost,
  recordRuntimeCandidate,
  stopDraftHost,
  expireDraftHostStarts,
  draftHostStartMinutes,
  supersedeOperation,
  switchRelease,
  type AppOperationEnd,
  type AppTransaction,
} from '@tulipfarm/apps/store';
import {
  AppHostConflictError,
  AppHostUnavailableError,
  unavailableAppHost,
  type AppServerBuildOutput,
} from '@tulipfarm/extensions';
import { recordAppReconcileRepair } from '@tulipfarm/observability';
import { escapeIdentifier } from 'pg';
import { collect, heartbeating, releaseUnretained, serverOutputKey, type AppWork } from './app-activities.ts';

/** Seconds requests on a replaced host get to finish. */
export const SERVER_DRAIN_S = 30;
/** How long one provision may take to boot a host and see it answer. The app host retries until this ends. */
export const SERVER_PROVISION_MS = 5 * 60_000;
/** How long one endpoint switch may wait for its new host to be ready. The app host retries until this ends. */
export const SERVER_SWITCH_MS = 120_000;
const SERVER_REMOVE_MS = 60_000;
/** The most endpoint repairs, and separately host removals, one reconcile makes. The next run continues. */
export const SERVER_RECONCILE_BATCH = 50;
/** How long a draft host stays up after an editor last opened the draft preview. Reconcile then removes it. */
export const DRAFT_HOST_IDLE_RETIRE_MS = 24 * 60 * 60_000;
/**
 * How old an unreferenced server artifact must be before it is discarded. A build made after the reconcile read its
 * workspace is in no keep list, so this must outlast one reconcile run.
 */
export const SERVER_ARTIFACT_GRACE_MS = 60 * 60_000;

type OperationInput = { readonly workspaceId: string; readonly operationId: string };

export type AppServerTarget = {
  readonly appId: string;
  readonly releaseId: string;
  readonly size: AppServerSize;
  readonly output: AppServerBuildOutput;
};

type DraftInput = { readonly workspaceId: string; readonly appId: string; readonly generation: number };

const lostStart = 'The app server did not start in time. Try again.';

/** What a draft host must run: the draft head's server build, at the app's live size or the default size. */
export type DraftHostTarget = {
  readonly buildId: string;
  readonly size: AppServerSize;
  readonly output: AppServerBuildOutput;
};

const hostless = 'This server cannot run apps that start their own server';
const failure = (code: AppFailure['code'], message: string, retryable: boolean): AppFailure => ({
  code,
  message,
  retryable,
});
const table = (tx: AppTransaction, name: string) => `${escapeIdentifier(tx.schema)}.${escapeIdentifier(name)}`;
const ended = (end: AppOperationEnd) => ({ status: end.operation.status, retiredHostRef: end.retiredHostRef });

/** Runs `call` with a signal that also ends at `ms`, and reports whether that deadline is what ended it. */
async function within<T>(ms: number, signal: AbortSignal, call: (signal: AbortSignal) => Promise<T>) {
  const deadline = AbortSignal.timeout(ms);
  try {
    return { ok: true as const, value: await call(AbortSignal.any([signal, deadline])) };
  } catch (error) {
    if (deadline.aborted && !signal.aborted) return { ok: false as const };
    throw error;
  }
}

/**
 * Server publish, rollback and resize. The release generation in the database decides which operation goes live; the
 * endpoint generation only keeps a stale switch from moving the endpoint. Server apps get no workspace data credentials.
 */
export function createAppServerActivities(work: AppWork) {
  const { transact, host, objects, platform } = work;

  /** Records which workspace each app belongs to, so its hosts can be found once the workspace is deleted. */
  async function recordOwners(workspaceId: string, appIds: readonly string[]) {
    await platform.query(
      `INSERT INTO app.app_server_owners (app_id, workspace_id) SELECT unnest($1::uuid[]), $2
       ON CONFLICT (app_id) DO NOTHING`,
      [appIds, workspaceId],
    );
  }

  async function fail(input: OperationInput, reason: AppFailure) {
    return ended(
      await transact(input.workspaceId, tx => failOperation(tx, input.operationId as AppOperationId, reason)),
    );
  }

  async function failDraft(input: DraftInput, reason: AppFailure) {
    return transact(input.workspaceId, tx => failDraftHost(tx, input.appId as AppId, input.generation, reason));
  }

  /** Reads one server output from the apps bucket. */
  async function serverOutput(buildId: string) {
    const object = await objects.get(serverOutputKey(buildId), new AbortController().signal);
    if (!object) throw new Error(`Missing the server output of build ${buildId}`);
    return JSON.parse((await collect(object.body, 64 * 1024))!.toString('utf8')) as AppServerBuildOutput;
  }

  /** Points the endpoint at `hostRef` and records where it went. Returns null when the deadline passed. */
  async function switchEndpoint(
    workspaceId: string,
    appId: string,
    hostRef: string,
    expectedGeneration: number | undefined,
    signal: AbortSignal,
  ) {
    await transact(workspaceId, tx => recordAppEndpointTarget(tx, appId as AppId, hostRef));
    const switched = await within(SERVER_SWITCH_MS, signal, bounded =>
      host.switch({ appId, hostRef, drainS: SERVER_DRAIN_S, expectedGeneration }, bounded),
    );
    if (!switched.ok) return null;
    const endpoint = { hostRef, generation: switched.value.generation };
    await transact(workspaceId, tx => recordAppEndpoint(tx, appId as AppId, endpoint));
    return endpoint;
  }

  return {
    /**
     * Marks the operation as bringing up its host and returns what the host must run, or null when the operation has
     * ended. Without an app host the operation fails here.
     */
    async prepareAppServer(input: OperationInput): Promise<AppServerTarget | null> {
      const id = input.operationId as AppOperationId;
      if (host === unavailableAppHost) {
        await fail(input, failure('host-unavailable', hostless, false));
        return null;
      }
      const target = await transact(input.workspaceId, async tx => {
        const operation = await readOperation(tx, id);
        if (!operation) throw new Error(`App operation ${id} not found`);
        if (operation.status !== 'admitted' && operation.status !== 'staging') return null;
        await markOperationStaging(tx, id);
        const { releaseId, size } = await readRuntimeTarget(tx, id);
        const release = (await readRelease(tx, releaseId))!;
        const build = (await readBuild(tx, release.buildId))!;
        if (build.recipe.kind !== 'server') throw new Error(`Release ${releaseId} does not run a server`);
        return { appId: operation.appId as string, releaseId: releaseId as string, size, buildId: build.id };
      });
      if (!target) return null;
      const output = await serverOutput(target.buildId);
      return { appId: target.appId, releaseId: target.releaseId, size: target.size, output };
    },

    /**
     * Boots the release at its size. When the host is unavailable or does not answer in time, the operation fails and
     * the live host keeps serving. Never passes workspace data credentials to the host.
     */
    async provisionAppServer(
      input: OperationInput & AppServerTarget,
    ): Promise<{ readonly ok: true; readonly hostRef: string } | { readonly ok: false }> {
      await recordOwners(input.workspaceId, [input.appId]);
      const provisioned = await heartbeating(signal =>
        within(SERVER_PROVISION_MS, signal, bounded =>
          host.provision(
            { appId: input.appId, releaseId: input.releaseId, size: input.size, output: input.output },
            bounded,
          ),
        ).catch(error => {
          if (error instanceof AppHostUnavailableError) return null;
          throw error;
        }),
      );
      if (provisioned === null) {
        await fail(input, failure('host-unavailable', hostless, false));
        return { ok: false };
      }
      if (!provisioned.ok) {
        await fail(input, failure('host-unavailable', 'The app server did not start in time. Try again.', true));
        return { ok: false };
      }
      // A rollback may choose any release that has run.
      await transact(input.workspaceId, tx => markReleaseStaged(tx, input.releaseId as AppReleaseId));
      return { ok: true, hostRef: provisioned.value.hostRef };
    },

    /** Records the host as the app's candidate. A newer operation supersedes this one here, before any switch. */
    async recordAppServerCandidate(input: OperationInput & { readonly hostRef: string }) {
      return ended(
        await transact(input.workspaceId, tx =>
          recordRuntimeCandidate(tx, input.operationId as AppOperationId, input.hostRef),
        ),
      );
    },

    /**
     * Moves the endpoint to the operation's host, then the live pointer in the database. A switch the host refuses
     * because the endpoint moved, or a newer generation in the database, supersedes the operation. If the endpoint
     * moved but the database switch lost, the endpoint goes back to the live host.
     */
    async switchAppServer(input: OperationInput & { readonly hostRef: string }) {
      const id = input.operationId as AppOperationId;
      const outcome = (end: { status: string; retiredHostRef: string | null }, appId: string, switched = false) => ({
        appId,
        status: end.status,
        switched,
        retiredHostRef: end.retiredHostRef,
      });
      const checked = await transact(input.workspaceId, async tx => {
        const operation = await readOperation(tx, id);
        if (!operation) throw new Error(`App operation ${id} not found`);
        if (operation.status !== 'admitted' && operation.status !== 'staging')
          return { ended: { status: operation.status, retiredHostRef: null }, appId: operation.appId as string };
        const app = (await readApp(tx, operation.appId))!;
        if (app.releaseGeneration !== operation.generation)
          return { ended: ended(await supersedeOperation(tx, id)), appId: operation.appId as string };
        const runtime = await readAppRuntime(tx, operation.appId);
        return { ended: null, appId: operation.appId as string, expected: runtime?.endpoint?.generation };
      });
      if (checked.ended) return outcome(checked.ended, checked.appId);
      const { appId } = checked;
      return heartbeating(async signal => {
        let moved: Awaited<ReturnType<typeof switchEndpoint>>;
        try {
          moved = await switchEndpoint(input.workspaceId, appId, input.hostRef, checked.expected, signal);
        } catch (error) {
          if (!(error instanceof AppHostConflictError)) throw error;
          const current = await transact(input.workspaceId, async tx => {
            const operation = (await readOperation(tx, id))!;
            const app = (await readApp(tx, operation.appId))!;
            if (operation.status !== 'admitted' && operation.status !== 'staging')
              return { status: operation.status, retiredHostRef: null };
            if (app.releaseGeneration === operation.generation) return true;
            return ended(await supersedeOperation(tx, id));
          });
          if (current !== true) return outcome(current, appId);
          // No newer operation exists, so the endpoint moved without a record, as when a switch succeeded but recording
          // it was lost. Waiting would conflict forever, so this operation takes the endpoint from whatever holds it.
          moved = await switchEndpoint(input.workspaceId, appId, input.hostRef, undefined, signal);
        }
        if (!moved)
          return outcome(
            await fail(input, failure('host-unavailable', 'The app server was not ready in time. Try again.', true)),
            appId,
          );
        const result = await transact(input.workspaceId, async tx => {
          const switched = await switchRelease(tx, id);
          return { switched, live: (await readAppRuntime(tx, appId as AppId))?.hostRef ?? null };
        });
        const won = result.switched.edgeVersion !== null;
        if (!won && result.live && result.live !== input.hostRef)
          await switchEndpoint(input.workspaceId, appId, result.live, moved.generation, signal).catch(error => {
            if (!(error instanceof AppHostConflictError)) throw error;
          });
        return outcome(ended(result.switched), appId, won);
      });
    },

    /** Ends an operation whose host could not be brought up or switched to, and returns its host to remove, if any. */
    async failAppServerOperation(input: OperationInput & { readonly message: string }) {
      return fail(input, failure('host-unavailable', input.message, true));
    },

    /**
     * Returns what the draft host start at `generation` must run, or null when a newer start replaced it or it ended.
     * Without an app host, without workspace credits, or for an app that is paused for credits, archived or disabled,
     * the start fails here.
     */
    async prepareDraftHost(input: DraftInput): Promise<DraftHostTarget | null> {
      if (host === unavailableAppHost) {
        await failDraft(input, failure('host-unavailable', hostless, false));
        return null;
      }
      const appId = input.appId as AppId;
      const target = await transact(input.workspaceId, async tx => {
        const draft = await readDraftHost(tx, appId, true);
        if (draft?.generation !== input.generation || draft.state !== 'starting') return null;
        const app = await readApp(tx, appId);
        const stop =
          !app || app.archivedAt !== null || app.stops.disabledAt !== null
            ? failure('not-found', 'App not found', false)
            : app.stops.budgetPausedAt !== null
              ? failure('budget-exhausted', 'This app is paused until it has credits to run.', false)
              : await work.credits
                  .available(tx)
                  .then(available =>
                    available !== null && available <= 0n
                      ? failure('budget-exhausted', 'The workspace has no credits left to run this draft.', false)
                      : null,
                  );
        if (stop) {
          await failDraftHost(tx, appId, input.generation, stop);
          return null;
        }
        const size = (await readAppRuntime(tx, appId))?.size ?? defaultServerSize;
        return { buildId: draft.buildId as string, size };
      });
      if (!target) return null;
      await recordOwners(input.workspaceId, [input.appId]);
      return { ...target, output: await serverOutput(target.buildId) };
    },

    /**
     * Boots the draft's build as a draft host, which the endpoint never points at. When the host is unavailable or does
     * not answer in time, the start fails. Never passes workspace data credentials to the host.
     */
    async provisionDraftHost(
      input: DraftInput & DraftHostTarget,
    ): Promise<{ readonly ok: true; readonly hostRef: string } | { readonly ok: false }> {
      const provisioned = await heartbeating(signal =>
        within(SERVER_PROVISION_MS, signal, bounded =>
          host.provision(
            {
              appId: input.appId,
              draftBuildId: input.buildId,
              draftGeneration: input.generation,
              size: input.size,
              output: input.output,
            },
            bounded,
          ),
        ).catch(error => {
          if (error instanceof AppHostUnavailableError) return null;
          throw error;
        }),
      );
      if (provisioned === null) {
        await failDraft(input, failure('host-unavailable', hostless, false));
        return { ok: false };
      }
      if (!provisioned.ok) {
        await failDraft(input, failure('host-unavailable', lostStart, true));
        return { ok: false };
      }
      return { ok: true, hostRef: provisioned.value.hostRef };
    },

    /** Records the draft host a start brought up. A start that a newer one replaced gets its host back to remove. */
    async recordDraftHost(input: DraftInput & { readonly hostRef: string }) {
      return transact(input.workspaceId, tx =>
        recordDraftHost(tx, input.appId as AppId, input.generation, input.hostRef),
      );
    },

    /** Ends a draft host start that could not bring up its host. */
    async failDraftHost(input: DraftInput & { readonly message: string }) {
      await failDraft(input, failure('host-unavailable', input.message, true));
    },

    /** Removes a host nothing serves from. Removing one that is already gone succeeds. */
    async removeAppHost(input: { readonly appId: string; readonly hostRef: string }) {
      await heartbeating(async signal => {
        const removed = await within(SERVER_REMOVE_MS, signal, bounded => host.remove(input, bounded));
        if (!removed.ok) throw new Error(`Removing host ${input.hostRef} took too long`);
      });
    },

    /**
     * Moves each server app's endpoint back to its live host when a lost race left it elsewhere, and removes hosts that
     * are not live, not a candidate, not the draft host, and belong to an app with no operation or draft host start in
     * flight. A draft host no editor opened for `DRAFT_HOST_IDLE_RETIRE_MS`, or whose build is no longer the draft head's
     * newest build, is live, or belongs to an archived or disabled app, is stopped and removed. A draft host start that
     * recorded nothing for `draftHostStartMinutes` fails, and no longer holds the app's hosts. The endpoint only ever
     * moves to the live host. Apps of workspaces without app hosting, and hosts of apps no workspace knows, are left
     * alone. Every host of an app whose workspace was deleted is removed without reading that workspace. Makes at most
     * `SERVER_RECONCILE_BATCH` repairs of each kind.
     */
    async reconcileAppServers(signal: AbortSignal) {
      if (host === unavailableAppHost) return;
      // Listed before any runtime is read, so a host brought up during the reconcile is not in the list.
      const listed = new Map<string, string[]>();
      for await (const found of host.list(signal))
        listed.set(found.appId, [...(listed.get(found.appId) ?? []), found.hostRef]);
      let repairs = 0;
      let removals = 0;
      const failures: unknown[] = [];

      // A deleted workspace's storage never comes back, so its apps' hosts serve no one. Names and preview hosts also
      // record an app's workspace, for hosts brought up before owners were recorded.
      const { rows: orphaned } = await platform.query(
        `SELECT DISTINCT o.app_id::text AS app_id
         FROM (SELECT app_id, workspace_id FROM app.app_server_owners
               UNION ALL SELECT app_id, workspace_id FROM app.app_hostnames
               UNION ALL SELECT app_id, workspace_id FROM app.app_preview_hosts) o
         JOIN app.workspace_storage s ON s.workspace_id = o.workspace_id AND s.stage = 'unavailable'
         WHERE o.app_id::text = ANY($1::text[])`,
        [[...listed.keys()]],
      );
      for (const { app_id: appId } of orphaned as { app_id: string }[])
        for (const hostRef of listed.get(appId) ?? []) {
          if (removals >= SERVER_RECONCILE_BATCH) break;
          removals++;
          try {
            const done = await within(SERVER_REMOVE_MS, signal, bounded => host.remove({ appId, hostRef }, bounded));
            if (done.ok) recordAppReconcileRepair('host-removed');
          } catch (error) {
            failures.push(error);
          }
        }
      type Row = {
        id: string;
        host_ref: string | null;
        candidate_host_ref: string | null;
        endpoint_host_ref: string | null;
        busy: boolean;
        draft_host_ref: string | null;
        draft_starting: boolean;
        draft_retired: boolean;
      };
      /** Every server app, and every app that has a listed host; or, locked, only the app `only` names. */
      const readServers = (tx: AppTransaction, appIds: readonly string[], only?: string) =>
        tx.client
          .query(
            `SELECT a.id, r.host_ref, r.candidate_host_ref, r.endpoint_host_ref,
               EXISTS (SELECT 1 FROM ${table(tx, 'tf_app_operations')} o
                       WHERE o.app_id = a.id AND o.status IN ('admitted', 'staging')) AS busy,
               h.host_ref AS draft_host_ref,
               COALESCE(h.state = 'starting'
                 AND h.updated_at > clock_timestamp() - make_interval(mins => $3), false) AS draft_starting,
               COALESCE(h.state = 'ready' AND (
                 h.opened_at <= clock_timestamp() - make_interval(secs => $2::double precision / 1000)
                 OR h.build_id IS DISTINCT FROM head.id
                 OR head.id = (SELECT l.build_id FROM ${table(tx, 'tf_app_releases')} l WHERE l.id = a.live_release_id)
                 OR a.archived_at IS NOT NULL OR a.disabled_at IS NOT NULL), false) AS draft_retired
             FROM ${table(tx, 'tf_apps')} a LEFT JOIN ${table(tx, 'tf_app_runtimes')} r ON r.app_id = a.id
             LEFT JOIN ${table(tx, 'tf_app_draft_hosts')} h ON h.app_id = a.id
             LEFT JOIN LATERAL (SELECT b.id FROM ${table(tx, 'tf_app_drafts')} d
                                JOIN ${table(tx, 'tf_app_builds')} b ON b.app_id = d.app_id AND b.commit = d.head_commit
                                WHERE d.app_id = a.id ORDER BY b.created_at DESC LIMIT 1) head ON true
             WHERE ${
               only
                 ? 'a.id = $1 FOR UPDATE OF a'
                 : `r.app_id IS NOT NULL OR h.state IN ('starting', 'ready') OR a.id::text = ANY($1::text[])`
             }`,
            [only ?? appIds, DRAFT_HOST_IDLE_RETIRE_MS, draftHostStartMinutes],
          )
          .then(result => result.rows as Row[]);

      for await (const workspaceId of work.workspaces()) {
        signal.throwIfAborted();
        if (repairs >= SERVER_RECONCILE_BATCH && removals >= SERVER_RECONCILE_BATCH) break;
        try {
          const servers = await transact(workspaceId, async tx => {
            await expireDraftHostStarts(tx, failure('host-unavailable', lostStart, true));
            return readServers(tx, [...listed.keys()]);
          });
          await recordOwners(
            workspaceId,
            servers.map(app => app.id),
          );
          for (const app of servers) {
            const retired = app.draft_retired && removals < SERVER_RECONCILE_BATCH ? app.draft_host_ref : null;
            if (retired) {
              removals++;
              // Under the app row lock no editor can start a draft host, so the host stopped here is the one removed.
              const removed = await transact(workspaceId, async tx => {
                const [now] = await readServers(tx, [], app.id);
                if (!now?.draft_retired || now.draft_host_ref !== retired) return false;
                await stopDraftHost(tx, app.id as AppId, retired);
                // A removal that does not finish leaves an unreferenced host, which a later run removes.
                const done = await within(SERVER_REMOVE_MS, signal, bounded =>
                  host.remove({ appId: app.id, hostRef: retired }, bounded),
                );
                return done.ok;
              });
              if (removed) recordAppReconcileRepair('host-removed');
            }
            // An operation in flight may own a host it has not recorded yet, and will switch the endpoint itself.
            if (app.busy) continue;
            if (app.host_ref && app.endpoint_host_ref !== app.host_ref && repairs < SERVER_RECONCILE_BATCH) {
              repairs++;
              // The list above may be minutes old. Under the app row lock no operation can start, so with none in
              // flight the live host read here is the right target, whatever generation the endpoint reached.
              const moved = await transact(workspaceId, async tx => {
                const [now] = await readServers(tx, [], app.id);
                if (!now?.host_ref || now.busy || now.endpoint_host_ref === now.host_ref) return false;
                const hostRef = now.host_ref;
                const switched = await within(SERVER_SWITCH_MS, signal, bounded =>
                  host.switch({ appId: app.id, hostRef, drainS: SERVER_DRAIN_S }, bounded),
                );
                if (!switched.ok) return false;
                await recordAppEndpoint(tx, app.id as AppId, { hostRef, generation: switched.value.generation });
                return true;
              });
              if (moved) recordAppReconcileRepair('endpoint-switched');
            }
            // A draft host start in flight may own a host it has not recorded yet.
            if (app.draft_starting) continue;
            const kept = (now: Row, hostRef: string) =>
              hostRef === now.host_ref || hostRef === now.candidate_host_ref || hostRef === now.draft_host_ref;
            for (const hostRef of listed.get(app.id) ?? []) {
              if (removals >= SERVER_RECONCILE_BATCH) break;
              if (kept(app, hostRef)) continue;
              removals++;
              // The app row lock holds off a new operation or draft host start, which could otherwise reuse this host,
              // until it is gone.
              const removed = await transact(workspaceId, async tx => {
                const [now] = await readServers(tx, [], app.id);
                if (!now || now.busy || now.draft_starting || kept(now, hostRef)) return false;
                const done = await within(SERVER_REMOVE_MS, signal, bounded =>
                  host.remove({ appId: app.id, hostRef }, bounded),
                );
                return done.ok;
              });
              if (removed) recordAppReconcileRepair('host-removed');
            }
          }
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, 'App server reconcile failed');
    },

    /**
     * Discards server build outputs nothing can run again. A server release that rollback no longer needs loses
     * `staged_at`, by the rule static releases follow. A succeeded server build that no such release, unfinished
     * operation or draft head uses, finished over an hour ago, loses `manifest_key`, so publishing it builds it again.
     * Once every workspace was read, the builder deletes the artifact of every build that is neither in flight nor
     * still holds its output.
     */
    async sweepServerArtifacts(signal: AbortSignal, now = Date.now()) {
      const builder = work.builder;
      if (!builder?.discardServerArtifacts) return;
      const keep = new Set<string>();
      const failures: unknown[] = [];
      let releases = 0;
      for await (const workspaceId of work.workspaces()) {
        signal.throwIfAborted();
        try {
          const kept = await transact(workspaceId, async tx => {
            const builds = table(tx, 'tf_app_builds');
            const releaseTable = table(tx, 'tf_app_releases');
            const operations = table(tx, 'tf_app_operations');
            const server = `b.recipe->>'kind' = 'server'`;
            // Each lock is taken in its own statement, so the next one reads every rollback or publish admitted before.
            const { rows: staged } = await tx.client.query(
              `SELECT r.id FROM ${releaseTable} r JOIN ${builds} b ON b.id = r.build_id
               WHERE r.staged_at IS NOT NULL AND ${server} ORDER BY r.id FOR UPDATE OF r`,
            );
            const discarded = await tx.client.query(
              `UPDATE ${releaseTable} r SET staged_at = NULL FROM ${table(tx, 'tf_apps')} a
               WHERE a.id = r.app_id AND r.id = ANY($1::uuid[]) AND ${releaseUnretained(tx, '$2')}`,
              [(staged as { id: string }[]).map(row => row.id), appLimits.retainedReleases],
            );
            releases += discarded.rowCount ?? 0;
            const { rows: held } = await tx.client.query(
              `SELECT b.id FROM ${builds} b
               WHERE ${server} AND b.status = 'succeeded' AND b.manifest_key IS NOT NULL ORDER BY b.id FOR UPDATE`,
            );
            await tx.client.query(
              `UPDATE ${builds} b SET manifest_key = NULL
               WHERE b.id = ANY($1::text[]) AND b.finished_at <= clock_timestamp() - interval '1 hour'
                 AND NOT EXISTS (
                   SELECT 1 FROM ${releaseTable} r JOIN ${table(tx, 'tf_apps')} a ON a.id = r.app_id
                   WHERE r.build_id = b.id
                     AND (r.staged_at IS NOT NULL OR r.id = a.live_release_id
                          OR EXISTS (SELECT 1 FROM ${operations} o
                                     WHERE o.target_release_id = r.id AND o.status IN ('admitted', 'staging'))))
                 AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_app_drafts')} d
                                 WHERE d.app_id = b.app_id AND d.head_commit = b.commit)`,
              [(held as { id: string }[]).map(row => row.id)],
            );
            const { rows: kept } = await tx.client.query(
              `SELECT b.id FROM ${builds} b
               WHERE ${server} AND (b.status IN ('queued', 'running') OR b.manifest_key IS NOT NULL)`,
            );
            return (kept as { id: string }[]).map(row => row.id);
          });
          for (const id of kept) keep.add(id);
        } catch (error) {
          failures.push(error);
        }
      }
      if (releases) recordAppReconcileRepair('release-discarded', releases);
      // A workspace that was not read may hold builds whose artifacts are still needed.
      if (failures.length) throw new AggregateError(failures, 'Server artifact sweep failed');
      const before = new Date(now - SERVER_ARTIFACT_GRACE_MS).toISOString();
      const { discarded } = await builder.discardServerArtifacts({ keep, before }, signal);
      if (discarded) recordAppReconcileRepair('server-output-discarded', discarded);
    },
  };
}

export type AppServerActivities = ReturnType<typeof createAppServerActivities>;
