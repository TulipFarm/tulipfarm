import { randomUUID } from 'node:crypto';
import {
  appServerSizeSchema,
  defaultServerSize,
  type AppFailure,
  type AppOperationKind,
  type AppOperationStatus,
  type AppServerSize,
} from '../app.ts';
import type { AppBuildId, AppGeneration, AppId, AppOperationId, AppReleaseId, MembershipId } from '../ids.ts';
import { appRecord, readApp, type AppRecord, type AppRow } from './apps.ts';
import { appRole } from './grants.ts';
import { putAppRuntime, readAppRuntime, type AppRuntime } from './runtimes.ts';
import { failed, rows, table, type AppResult, type AppTransaction } from './sql.ts';

export type AppOperation = {
  readonly id: AppOperationId;
  readonly appId: AppId;
  readonly kind: AppOperationKind;
  readonly requestId: string;
  readonly requestedBy: MembershipId;
  readonly generation: AppGeneration;
  readonly targetReleaseId: AppReleaseId | null;
  /** Set only on a resize. */
  readonly targetSize: AppServerSize | null;
  /** The host a server operation brought up, once it has recorded one. */
  readonly hostRef: string | null;
  readonly status: AppOperationStatus['status'];
  /** The generation that had replaced this one when it tried to switch. */
  readonly supersededBy: AppGeneration | null;
  readonly failure: AppFailure | null;
};

export type AppRelease = {
  readonly id: AppReleaseId;
  readonly appId: AppId;
  readonly number: number;
  readonly buildId: AppBuildId;
  readonly commit: string;
  readonly manifestDigest: string;
  readonly staged: boolean;
};

type OperationRow = {
  id: string;
  app_id: string;
  kind: AppOperationKind;
  request_id: string;
  requested_by: string;
  generation: string;
  target_release_id: string | null;
  target_size_vcpu: number | null;
  target_size_mem_mib: number | null;
  host_ref: string | null;
  status: AppOperationStatus['status'];
  failure: (AppFailure & { by?: number }) | null;
};

const operationOf = (row: OperationRow): AppOperation => {
  const { by, ...failure } = row.failure ?? {};
  return {
    id: row.id as AppOperationId,
    appId: row.app_id as AppId,
    kind: row.kind,
    requestId: row.request_id,
    requestedBy: row.requested_by as MembershipId,
    generation: Number(row.generation) as AppGeneration,
    targetReleaseId: row.target_release_id as AppReleaseId | null,
    targetSize: row.target_size_vcpu === null ? null : { vcpu: row.target_size_vcpu, memMiB: row.target_size_mem_mib! },
    hostRef: row.host_ref,
    status: row.status,
    supersededBy: by === undefined ? null : (by as AppGeneration),
    failure: row.failure ? (failure as AppFailure) : null,
  };
};

export async function readOperation(tx: AppTransaction, id: AppOperationId, lock = false) {
  const [row] = await rows<OperationRow>(
    tx,
    `SELECT * FROM ${table(tx, 'tf_app_operations')} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return row ? operationOf(row) : null;
}

async function requested(tx: AppTransaction, requestedBy: MembershipId, requestId: string) {
  const [row] = await rows<OperationRow>(
    tx,
    `SELECT * FROM ${table(tx, 'tf_app_operations')} WHERE requested_by = $1 AND request_id = $2`,
    [requestedBy, requestId],
  );
  return row ? operationOf(row) : null;
}

async function insertOperation(
  tx: AppTransaction,
  input: {
    readonly appId: AppId;
    readonly requestId: string;
    readonly requestedBy: MembershipId;
    readonly kind: AppOperationKind;
    readonly generation: number;
    readonly targetReleaseId: string | null;
    readonly targetSize?: AppServerSize | undefined;
    readonly status: 'admitted' | 'switched';
  },
) {
  const [row] = await rows<OperationRow>(
    tx,
    `INSERT INTO ${table(tx, 'tf_app_operations')} (id, app_id, request_id, requested_by, kind, generation,
       target_release_id, target_size_vcpu, target_size_mem_mib, status, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $10 = 'switched' THEN clock_timestamp() END)
     RETURNING *`,
    [
      randomUUID(),
      input.appId,
      input.requestId,
      input.requestedBy,
      input.kind,
      input.generation,
      input.targetReleaseId,
      input.targetSize?.vcpu ?? null,
      input.targetSize?.memMiB ?? null,
      input.status,
    ],
  );
  return operationOf(row!);
}

type Request = { readonly appId: AppId; readonly requestId: string; readonly requestedBy: MembershipId };
type Admission = AppResult<{ readonly operation: AppOperation }>;

type Target = { readonly releaseId: (generation: number) => Promise<string>; readonly size?: AppServerSize };

/**
 * Admits a publish, rollback or resize under the app row lock: a repeated request returns its operation, otherwise
 * the operation claims the next release generation. Only the operation holding the newest generation can switch.
 */
async function admitRelease(
  tx: AppTransaction,
  request: Request,
  kind: 'publish' | 'rollback' | 'resize',
  target: (app: AppRecord) => Promise<AppResult<Target>>,
): Promise<Admission> {
  const app = await readApp(tx, request.appId, true);
  if (!app || app.archivedAt) return failed('not-found', 'App not found');
  const repeat = await requested(tx, request.requestedBy, request.requestId);
  if (repeat) return repeat.appId === app.id ? { ok: true, operation: repeat } : failed('not-found', 'App not found');
  if ((await appRole(tx, app.id, request.requestedBy)) !== 'edit')
    return failed('forbidden', 'You need edit access to this app');
  if (app.kind !== 'public') return failed('forbidden', 'Only public apps have hosted releases');
  if (app.approval.state !== 'approved')
    return failed('approval-required', 'A workspace admin must approve this app before it goes live');
  const chosen = await target(app);
  if (!chosen.ok) return chosen;
  const [claimed] = await rows<{ release_generation: string }>(
    tx,
    `UPDATE ${table(tx, 'tf_apps')} SET release_generation = release_generation + 1 WHERE id = $1
     RETURNING release_generation`,
    [app.id],
  );
  const generation = Number(claimed!.release_generation);
  const operation = await insertOperation(tx, {
    ...request,
    kind,
    generation,
    targetReleaseId: await chosen.releaseId(generation),
    targetSize: chosen.size,
    status: 'admitted',
  });
  return { ok: true, operation };
}

/** Admits publishing a succeeded build of this app as its next numbered release. */
export function admitPublish(
  tx: AppTransaction,
  input: Request & { readonly buildId: AppBuildId },
): Promise<Admission> {
  return admitRelease(tx, input, 'publish', async app => {
    const [build] = await rows<{ commit: string; manifest_digest: string }>(
      tx,
      `SELECT commit, manifest_digest FROM ${table(tx, 'tf_app_builds')}
       WHERE id = $1 AND app_id = $2 AND status = 'succeeded'`,
      [input.buildId, app.id],
    );
    if (!build) return failed('not-found', 'This build has not finished');
    return {
      ok: true,
      releaseId: async () => {
        const id = randomUUID();
        await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_app_releases')} (id, app_id, number, build_id, commit, manifest_digest, published_by)
           SELECT $1, $2, COALESCE(MAX(number), 0) + 1, $3, $4, $5, $6 FROM ${table(tx, 'tf_app_releases')} WHERE app_id = $2`,
          [id, app.id, input.buildId, build.commit, build.manifest_digest, input.requestedBy],
        );
        return id;
      },
    };
  });
}

/**
 * Admits pointing the app back at one of its earlier releases that the publisher already holds. The share lock waits
 * out a cleanup that is discarding the release, which clears `staged_at` first.
 */
export function admitRollback(
  tx: AppTransaction,
  input: Request & { readonly releaseId: AppReleaseId },
): Promise<Admission> {
  return admitRelease(tx, input, 'rollback', async app => {
    const [release] = await rows<{ id: string }>(
      tx,
      `SELECT id FROM ${table(tx, 'tf_app_releases')} WHERE id = $1 AND app_id = $2 AND staged_at IS NOT NULL
       FOR SHARE`,
      [input.releaseId, app.id],
    );
    if (!release) return failed('not-found', 'Release not found');
    return { ok: true, releaseId: async () => release.id };
  });
}

/**
 * Admits moving a running server app to a new size. The live release stays: a resize targets it and goes live through
 * the same generation-checked switch as a publish, so whichever was admitted last wins.
 */
export function admitResize(
  tx: AppTransaction,
  input: Request & {
    readonly size: AppServerSize;
    /** The largest size this workspace allows, or null while no workspace limit is set. */
    readonly maximumSize: AppServerSize | null;
  },
): Promise<Admission> {
  return admitRelease(tx, input, 'resize', async app => {
    const parsed = appServerSizeSchema.safeParse(input.size);
    if (!parsed.success)
      return failed('limit-exceeded', 'A server needs a whole number of vCPUs and MiB, at least 1 of each');
    const size = parsed.data;
    const maximum = input.maximumSize;
    if (maximum && (size.vcpu > maximum.vcpu || size.memMiB > maximum.memMiB))
      return failed(
        'limit-exceeded',
        `This workspace allows up to ${maximum.vcpu} vCPUs and ${maximum.memMiB} MiB per app`,
      );
    const runtime = await readAppRuntime(tx, app.id);
    const live = runtime?.liveReleaseId;
    if (!live) return failed('not-found', 'This app has no running server to resize');
    return { ok: true, releaseId: async () => live, size };
  });
}

export async function readRelease(tx: AppTransaction, id: AppReleaseId): Promise<AppRelease | null> {
  const [row] = await rows<{
    id: string;
    app_id: string;
    number: number;
    build_id: string;
    commit: string;
    manifest_digest: string;
    staged_at: Date | null;
  }>(tx, `SELECT * FROM ${table(tx, 'tf_app_releases')} WHERE id = $1`, [id]);
  return row
    ? {
        id: row.id as AppReleaseId,
        appId: row.app_id as AppId,
        number: row.number,
        buildId: row.build_id as AppBuildId,
        commit: row.commit,
        manifestDigest: row.manifest_digest,
        staged: row.staged_at !== null,
      }
    : null;
}

/** Marks an admitted operation as copying its release into delivery. */
export async function markOperationStaging(tx: AppTransaction, id: AppOperationId) {
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_app_operations')} SET status = 'staging' WHERE id = $1 AND status = 'admitted'`,
    [id],
  );
  return (await readOperation(tx, id))!;
}

/** Records that the publisher holds every file of a release. */
export async function markReleaseStaged(tx: AppTransaction, id: AppReleaseId) {
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_app_releases')} SET staged_at = clock_timestamp() WHERE id = $1 AND staged_at IS NULL`,
    [id],
  );
}

/**
 * What a finished operation leaves behind. `retiredHostRef` is a host nothing serves from any more, which the caller
 * removes: the replaced live host after a switch, or the operation's own host when it lost or failed. It is null when
 * that host is still live, still a candidate or still wanted by an active operation, since hosts are shared by release
 * and size.
 */
export type AppOperationEnd = { readonly operation: AppOperation; readonly retiredHostRef: string | null };

const active = (operation: AppOperation) => operation.status === 'admitted' || operation.status === 'staging';

function unused(hostRef: string | null, runtime: AppRuntime | null) {
  return hostRef !== null && hostRef !== runtime?.hostRef && hostRef !== runtime?.candidate?.hostRef ? hostRef : null;
}

/**
 * Clears the operation's candidate, if it still holds the slot, and returns its host unless something still uses it.
 * An active operation for the same release and size will reuse the host even before it records it. The app row lock
 * keeps a new one from being admitted while this looks.
 */
async function releaseCandidate(tx: AppTransaction, operation: AppOperation, idle: 'none' | 'failed') {
  if (operation.hostRef === null) return null;
  await readApp(tx, operation.appId, true);
  let runtime = await readAppRuntime(tx, operation.appId, true);
  if (runtime && runtime.candidate?.operationId === operation.id)
    runtime = await putAppRuntime(tx, {
      ...runtime,
      state: runtime.liveReleaseId === null ? idle : 'serving',
      candidate: null,
    });
  const size = runtime?.size ?? defaultServerSize;
  const target = operation.targetSize ?? size;
  const [sharing] = await rows<{ id: string }>(
    tx,
    `SELECT id FROM ${table(tx, 'tf_app_operations')}
     WHERE app_id = $1 AND id <> $2 AND status IN ('admitted', 'staging')
       AND (host_ref = $3 OR (target_release_id = $4
         AND COALESCE(target_size_vcpu, $5) = $6 AND COALESCE(target_size_mem_mib, $7) = $8))
     LIMIT 1`,
    [
      operation.appId,
      operation.id,
      operation.hostRef,
      operation.targetReleaseId,
      size.vcpu,
      target.vcpu,
      size.memMiB,
      target.memMiB,
    ],
  );
  return sharing ? null : unused(operation.hostRef, runtime);
}

async function supersede(tx: AppTransaction, operation: AppOperation): Promise<AppOperationEnd> {
  const app = (await readApp(tx, operation.appId))!;
  const failure = {
    code: 'superseded',
    message: 'A newer publish, rollback or resize replaced this one',
    retryable: false,
    by: app.releaseGeneration,
  };
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_app_operations')} SET status = 'superseded', failure = $2, finished_at = clock_timestamp()
     WHERE id = $1`,
    [operation.id, JSON.stringify(failure)],
  );
  return {
    operation: (await readOperation(tx, operation.id))!,
    retiredHostRef: await releaseCandidate(tx, operation, 'none'),
  };
}

/**
 * Ends an unfinished operation as superseded, for when the app host refused its switch because another switch moved
 * the endpoint first. The live release keeps serving.
 */
export async function supersedeOperation(tx: AppTransaction, id: AppOperationId): Promise<AppOperationEnd> {
  const operation = await readOperation(tx, id, true);
  if (!operation) throw new Error(`App operation ${id} not found`);
  if (!active(operation)) return { operation, retiredHostRef: null };
  return supersede(tx, operation);
}

/** Whether an operation's release runs as a server on an app host rather than as files the publisher delivers. */
export async function runsServer(tx: AppTransaction, operation: AppOperation) {
  if (operation.kind === 'resize') return true;
  const [row] = await rows<{ kind: string }>(
    tx,
    `SELECT b.recipe->>'kind' AS kind FROM ${table(tx, 'tf_app_releases')} r
     JOIN ${table(tx, 'tf_app_builds')} b ON b.id = r.build_id WHERE r.id = $1`,
    [operation.targetReleaseId],
  );
  return row?.kind === 'server';
}

/** Ends an unfinished operation with a failure. The live release keeps serving. */
export async function failOperation(
  tx: AppTransaction,
  id: AppOperationId,
  failure: AppFailure,
): Promise<AppOperationEnd> {
  const [row] = await rows<OperationRow>(
    tx,
    `UPDATE ${table(tx, 'tf_app_operations')} SET status = 'failed', failure = $2, finished_at = clock_timestamp()
     WHERE id = $1 AND status IN ('admitted', 'staging') RETURNING *`,
    [id, JSON.stringify(failure)],
  );
  if (!row) return { operation: (await readOperation(tx, id))!, retiredHostRef: null };
  const operation = operationOf(row);
  return { operation, retiredHostRef: await releaseCandidate(tx, operation, 'failed') };
}

/** The release and size a server operation's host must run. A publish or rollback keeps the app's current size. */
export async function readRuntimeTarget(
  tx: AppTransaction,
  id: AppOperationId,
): Promise<{ readonly releaseId: AppReleaseId; readonly size: AppServerSize }> {
  const operation = await readOperation(tx, id);
  if (!operation?.targetReleaseId) throw new Error(`App operation ${id} has no release to run`);
  const runtime = await readAppRuntime(tx, operation.appId);
  return { releaseId: operation.targetReleaseId, size: operation.targetSize ?? runtime?.size ?? defaultServerSize };
}

/**
 * Records the host a server operation brought up as the app's candidate, replacing any older candidate. If a newer
 * operation was admitted meanwhile, the operation is superseded here instead, before anything switches to its host.
 */
export async function recordRuntimeCandidate(
  tx: AppTransaction,
  id: AppOperationId,
  hostRef: string,
): Promise<AppOperationEnd> {
  const found = await readOperation(tx, id, true);
  if (!found) throw new Error(`App operation ${id} not found`);
  if (!active(found)) return { operation: found, retiredHostRef: null };
  await tx.client.query(`UPDATE ${table(tx, 'tf_app_operations')} SET host_ref = $2 WHERE id = $1`, [id, hostRef]);
  const operation = { ...found, hostRef };
  const app = (await readApp(tx, operation.appId, true))!;
  if (app.releaseGeneration !== operation.generation) return supersede(tx, operation);
  const target = await readRuntimeTarget(tx, id);
  const runtime = await readAppRuntime(tx, app.id, true);
  const live = runtime?.liveReleaseId ?? null;
  await putAppRuntime(tx, {
    appId: app.id,
    liveReleaseId: live,
    size: runtime?.size ?? defaultServerSize,
    hostRef: runtime?.hostRef ?? null,
    state: live === null ? 'starting' : 'replacing',
    candidate: { operationId: id, ...target, hostRef },
  });
  return { operation, retiredHostRef: null };
}

/**
 * Moves the live pointer to the operation's release only while its generation is still the newest. An operation
 * admitted later wins even if it finishes first; the older one is then superseded. A server operation's candidate
 * becomes the live host and size in the same transaction. Stop columns are never written, so a publish or resize
 * cannot undo a pause or disable. Running it again returns the recorded outcome.
 */
export async function switchRelease(
  tx: AppTransaction,
  id: AppOperationId,
): Promise<AppOperationEnd & { readonly edgeVersion: number | null }> {
  const operation = await readOperation(tx, id, true);
  if (!operation) throw new Error(`App operation ${id} not found`);
  if (!active(operation)) return { operation, edgeVersion: null, retiredHostRef: null };
  const [switched] = await rows<{ edge_version: string }>(
    tx,
    `UPDATE ${table(tx, 'tf_apps')} SET live_release_id = $3, edge_version = edge_version + 1
     WHERE id = $1 AND release_generation = $2 RETURNING edge_version`,
    [operation.appId, operation.generation, operation.targetReleaseId],
  );
  if (!switched) return { ...(await supersede(tx, operation)), edgeVersion: null };
  const retiredHostRef = operation.hostRef === null ? null : await promoteCandidate(tx, operation);
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_app_operations')} SET status = 'switched', finished_at = clock_timestamp() WHERE id = $1`,
    [id],
  );
  return {
    operation: (await readOperation(tx, id))!,
    edgeVersion: Number(switched.edge_version),
    retiredHostRef,
  };
}

/** Makes the operation's candidate the live host and size, and returns the host it replaced. */
async function promoteCandidate(tx: AppTransaction, operation: AppOperation) {
  const runtime = await readAppRuntime(tx, operation.appId, true);
  const candidate = runtime?.candidate;
  if (!runtime || candidate?.operationId !== operation.id)
    throw new Error(`App operation ${operation.id} brought up a host but is not the app's candidate`);
  const promoted = await putAppRuntime(tx, {
    appId: runtime.appId,
    liveReleaseId: candidate.releaseId,
    size: candidate.size,
    hostRef: candidate.hostRef,
    state: 'serving',
    candidate: null,
  });
  return unused(runtime.hostRef, promoted);
}

export type AppStopKind = 'pause' | 'resume' | 'disable' | 'enable';

const stopChanges: Record<AppStopKind, string> = {
  pause: 'editor_paused_at = COALESCE(editor_paused_at, clock_timestamp())',
  resume: 'editor_paused_at = NULL',
  disable: 'disabled_at = COALESCE(disabled_at, clock_timestamp()), disabled_by = COALESCE(disabled_by, $2)',
  enable: 'disabled_at = NULL, disabled_by = NULL',
};

/**
 * Sets or clears one stop column and bumps the edge version, recording the request as a finished operation. Editors
 * pause and resume; only workspace admins disable and enable.
 */
export async function changeAppStop(
  tx: AppTransaction,
  input: Request & { readonly kind: AppStopKind },
): Promise<AppResult<{ readonly operation: AppOperation; readonly app: AppRecord }>> {
  const app = await readApp(tx, input.appId, true);
  if (!app) return failed('not-found', 'App not found');
  const repeat = await requested(tx, input.requestedBy, input.requestId);
  if (repeat)
    return repeat.appId === app.id ? { ok: true, operation: repeat, app } : failed('not-found', 'App not found');
  if (input.kind === 'disable' || input.kind === 'enable') {
    const [member] = await rows<{ role: string }>(
      tx,
      `SELECT role FROM ${table(tx, 'tf_memberships')} WHERE id = $1 AND removed_at IS NULL`,
      [input.requestedBy],
    );
    if (member?.role !== 'admin') return failed('forbidden', 'Only a workspace admin can disable or enable an app');
  } else if ((await appRole(tx, app.id, input.requestedBy)) !== 'edit') {
    return failed('forbidden', 'You need edit access to this app');
  }
  const [row] = await rows<AppRow>(
    tx,
    `UPDATE ${table(tx, 'tf_apps')} SET ${stopChanges[input.kind]}, edge_version = edge_version + 1
     WHERE id = $1 RETURNING *`,
    input.kind === 'disable' ? [app.id, input.requestedBy] : [app.id],
  );
  const changed = appRecord(row!);
  const operation = await insertOperation(tx, {
    ...input,
    generation: changed.releaseGeneration,
    targetReleaseId: changed.liveReleaseId,
    status: 'switched',
  });
  return { ok: true, operation, app: changed };
}
