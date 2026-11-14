import type { AppRuntimeState, AppServerSize } from '../app.ts';
import type { AppId, AppOperationId, AppReleaseId } from '../ids.ts';
import { rows, table, type AppTransaction } from './sql.ts';

/** The host an operation is bringing up to serve next. */
export type AppRuntimeCandidate = {
  readonly operationId: AppOperationId;
  readonly releaseId: AppReleaseId;
  readonly size: AppServerSize;
  readonly hostRef: string;
};

/** The running server of one server app. `hostRef` is the app host's own name for the live host. */
export type AppRuntime = {
  readonly appId: AppId;
  readonly liveReleaseId: AppReleaseId | null;
  readonly size: AppServerSize;
  readonly hostRef: string | null;
  readonly state: AppRuntimeState;
  readonly candidate: AppRuntimeCandidate | null;
  /**
   * The host the endpoint was last switched to, or a switch since may have moved it to, and the generation last
   * reported, or null before the first switch.
   */
  readonly endpoint: AppEndpoint | null;
  readonly updatedAt: string;
};

export type AppEndpoint = { readonly hostRef: string; readonly generation: number };

type RuntimeRow = {
  app_id: string;
  live_release_id: string | null;
  size_vcpu: number;
  size_mem_mib: number;
  host_ref: string | null;
  state: AppRuntimeState;
  candidate_operation_id: string | null;
  candidate_release_id: string | null;
  candidate_size_vcpu: number | null;
  candidate_size_mem_mib: number | null;
  candidate_host_ref: string | null;
  endpoint_host_ref: string | null;
  endpoint_generation: string | null;
  updated_at: Date;
};

const runtimeOf = (row: RuntimeRow): AppRuntime => ({
  appId: row.app_id as AppId,
  liveReleaseId: row.live_release_id as AppReleaseId | null,
  size: { vcpu: row.size_vcpu, memMiB: row.size_mem_mib },
  hostRef: row.host_ref,
  state: row.state,
  candidate:
    row.candidate_operation_id === null
      ? null
      : {
          operationId: row.candidate_operation_id as AppOperationId,
          releaseId: row.candidate_release_id as AppReleaseId,
          size: { vcpu: row.candidate_size_vcpu!, memMiB: row.candidate_size_mem_mib! },
          hostRef: row.candidate_host_ref!,
        },
  endpoint:
    row.endpoint_host_ref === null
      ? null
      : { hostRef: row.endpoint_host_ref, generation: Number(row.endpoint_generation) },
  updatedAt: row.updated_at.toISOString(),
});

export async function readAppRuntime(tx: AppTransaction, appId: AppId, lock = false) {
  const [row] = await rows<RuntimeRow>(
    tx,
    `SELECT * FROM ${table(tx, 'tf_app_runtimes')} WHERE app_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [appId],
  );
  return row ? runtimeOf(row) : null;
}

/** Creates or replaces an app's runtime record and returns it as stored. The endpoint is kept as it was. */
export async function putAppRuntime(tx: AppTransaction, runtime: Omit<AppRuntime, 'updatedAt' | 'endpoint'>) {
  const { candidate } = runtime;
  const [row] = await rows<RuntimeRow>(
    tx,
    `INSERT INTO ${table(tx, 'tf_app_runtimes')} (app_id, live_release_id, size_vcpu, size_mem_mib, host_ref, state,
       candidate_operation_id, candidate_release_id, candidate_size_vcpu, candidate_size_mem_mib, candidate_host_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (app_id) DO UPDATE SET live_release_id = EXCLUDED.live_release_id,
       size_vcpu = EXCLUDED.size_vcpu, size_mem_mib = EXCLUDED.size_mem_mib, host_ref = EXCLUDED.host_ref,
       state = EXCLUDED.state, candidate_operation_id = EXCLUDED.candidate_operation_id,
       candidate_release_id = EXCLUDED.candidate_release_id, candidate_size_vcpu = EXCLUDED.candidate_size_vcpu,
       candidate_size_mem_mib = EXCLUDED.candidate_size_mem_mib, candidate_host_ref = EXCLUDED.candidate_host_ref,
       updated_at = clock_timestamp()
     RETURNING *`,
    [
      runtime.appId,
      runtime.liveReleaseId,
      runtime.size.vcpu,
      runtime.size.memMiB,
      runtime.hostRef,
      runtime.state,
      candidate?.operationId ?? null,
      candidate?.releaseId ?? null,
      candidate?.size.vcpu ?? null,
      candidate?.size.memMiB ?? null,
      candidate?.hostRef ?? null,
    ],
  );
  return runtimeOf(row!);
}

/**
 * Records the host a switch is about to move the endpoint to, keeping the stored generation. A switch the host applies
 * but no one records then still shows the endpoint off the live host, so reconcile moves it back.
 */
export async function recordAppEndpointTarget(tx: AppTransaction, appId: AppId, hostRef: string) {
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_app_runtimes')} SET endpoint_host_ref = $2, updated_at = clock_timestamp()
     WHERE app_id = $1 AND endpoint_generation IS NOT NULL`,
    [appId, hostRef],
  );
}

/**
 * Records where an endpoint switch left the app's endpoint. A report older than the one stored is ignored, so a late
 * retry cannot move the record back.
 */
export async function recordAppEndpoint(tx: AppTransaction, appId: AppId, endpoint: AppEndpoint) {
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_app_runtimes')} SET endpoint_host_ref = $2, endpoint_generation = $3,
       updated_at = clock_timestamp()
     WHERE app_id = $1 AND (endpoint_generation IS NULL OR endpoint_generation < $3)`,
    [appId, endpoint.hostRef, endpoint.generation],
  );
}
