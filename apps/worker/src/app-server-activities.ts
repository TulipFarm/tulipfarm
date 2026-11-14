import type { AppFailure, AppId, AppOperationId, AppReleaseId, AppServerSize } from '@tulipfarm/apps';
import {
  failOperation,
  markOperationStaging,
  markReleaseStaged,
  readApp,
  readAppRuntime,
  readBuild,
  readOperation,
  readRelease,
  readRuntimeTarget,
  recordAppEndpoint,
  recordAppEndpointTarget,
  recordRuntimeCandidate,
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
import { collect, heartbeating, serverOutputKey, type AppWork } from './app-activities.ts';

/** Seconds requests on a replaced host get to finish. */
export const SERVER_DRAIN_S = 30;
/** How long one provision may take to boot a host and see it answer. The app host retries until this ends. */
export const SERVER_PROVISION_MS = 5 * 60_000;
/** How long one endpoint switch may wait for its new host to be ready. The app host retries until this ends. */
export const SERVER_SWITCH_MS = 120_000;
const SERVER_REMOVE_MS = 60_000;
/** The most endpoint repairs, and separately host removals, one reconcile makes. The next run continues. */
export const SERVER_RECONCILE_BATCH = 50;

type OperationInput = { readonly workspaceId: string; readonly operationId: string };

export type AppServerTarget = {
  readonly appId: string;
  readonly releaseId: string;
  readonly size: AppServerSize;
  readonly output: AppServerBuildOutput;
};

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
  const { transact, host, objects } = work;

  async function fail(input: OperationInput, reason: AppFailure) {
    return ended(
      await transact(input.workspaceId, tx => failOperation(tx, input.operationId as AppOperationId, reason)),
    );
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
        await fail(
          input,
          failure('host-unavailable', 'This server cannot run apps that start their own server', false),
        );
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
      const object = await objects.get(serverOutputKey(target.buildId), new AbortController().signal);
      if (!object) throw new Error(`Missing the server output of build ${target.buildId}`);
      const output = JSON.parse((await collect(object.body, 64 * 1024))!.toString('utf8')) as AppServerBuildOutput;
      return { appId: target.appId, releaseId: target.releaseId, size: target.size, output };
    },

    /**
     * Boots the release at its size. When the host is unavailable or does not answer in time, the operation fails and
     * the live host keeps serving. Never passes workspace data credentials to the host.
     */
    async provisionAppServer(
      input: OperationInput & AppServerTarget,
    ): Promise<{ readonly ok: true; readonly hostRef: string } | { readonly ok: false }> {
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
        await fail(
          input,
          failure('host-unavailable', 'This server cannot run apps that start their own server', false),
        );
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

    /** Removes a host nothing serves from. Removing one that is already gone succeeds. */
    async removeAppHost(input: { readonly appId: string; readonly hostRef: string }) {
      await heartbeating(async signal => {
        const removed = await within(SERVER_REMOVE_MS, signal, bounded => host.remove(input, bounded));
        if (!removed.ok) throw new Error(`Removing host ${input.hostRef} took too long`);
      });
    },

    /**
     * Moves each server app's endpoint back to its live host when a lost race left it elsewhere, and removes hosts that
     * are not live, not a candidate, and belong to an app with no operation in flight. Apps of workspaces without app
     * hosting, and hosts of apps no workspace knows, are left alone. Makes at most `SERVER_RECONCILE_BATCH` repairs of
     * each kind.
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
      type Row = {
        id: string;
        host_ref: string | null;
        candidate_host_ref: string | null;
        endpoint_host_ref: string | null;
        busy: boolean;
      };
      /** Every server app, and every app that has a listed host; or, locked, only the app `only` names. */
      const readServers = (tx: AppTransaction, appIds: readonly string[], only?: string) =>
        tx.client
          .query(
            `SELECT a.id, r.host_ref, r.candidate_host_ref, r.endpoint_host_ref,
               EXISTS (SELECT 1 FROM ${table(tx, 'tf_app_operations')} o
                       WHERE o.app_id = a.id AND o.status IN ('admitted', 'staging')) AS busy
             FROM ${table(tx, 'tf_apps')} a LEFT JOIN ${table(tx, 'tf_app_runtimes')} r ON r.app_id = a.id
             WHERE ${only ? 'a.id = $1 FOR UPDATE OF a' : 'r.app_id IS NOT NULL OR a.id::text = ANY($1::text[])'}`,
            [only ?? appIds],
          )
          .then(result => result.rows as Row[]);

      for await (const workspaceId of work.workspaces()) {
        signal.throwIfAborted();
        if (repairs >= SERVER_RECONCILE_BATCH && removals >= SERVER_RECONCILE_BATCH) break;
        try {
          if (!(await work.enabled(workspaceId))) continue;
          const servers = await transact(workspaceId, tx => readServers(tx, [...listed.keys()]));
          for (const app of servers) {
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
            for (const hostRef of listed.get(app.id) ?? []) {
              if (removals >= SERVER_RECONCILE_BATCH) break;
              if (hostRef === app.host_ref || hostRef === app.candidate_host_ref) continue;
              removals++;
              // The app row lock holds off a new operation, which could otherwise reuse this host, until it is gone.
              const removed = await transact(workspaceId, async tx => {
                const [now] = await readServers(tx, [], app.id);
                if (!now || now.busy || hostRef === now.host_ref || hostRef === now.candidate_host_ref) return false;
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
  };
}

export type AppServerActivities = ReturnType<typeof createAppServerActivities>;
