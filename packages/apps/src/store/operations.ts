import { randomUUID } from 'node:crypto';
import type { AppFailure, AppOperationKind, AppOperationStatus } from '../app.ts';
import type { AppBuildId, AppGeneration, AppId, AppOperationId, AppReleaseId, MembershipId } from '../ids.ts';
import { appRecord, readApp, type AppRecord, type AppRow } from './apps.ts';
import { appRole } from './grants.ts';
import { failed, rows, table, type AppResult, type AppTransaction } from './sql.ts';

export type AppOperation = {
  readonly id: AppOperationId;
  readonly appId: AppId;
  readonly kind: AppOperationKind;
  readonly requestId: string;
  readonly requestedBy: MembershipId;
  readonly generation: AppGeneration;
  readonly targetReleaseId: AppReleaseId | null;
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
    readonly status: 'admitted' | 'switched';
  },
) {
  const [row] = await rows<OperationRow>(
    tx,
    `INSERT INTO ${table(tx, 'tf_app_operations')}
       (id, app_id, request_id, requested_by, kind, generation, target_release_id, status, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $8 = 'switched' THEN clock_timestamp() END)
     RETURNING *`,
    [
      randomUUID(),
      input.appId,
      input.requestId,
      input.requestedBy,
      input.kind,
      input.generation,
      input.targetReleaseId,
      input.status,
    ],
  );
  return operationOf(row!);
}

type Request = { readonly appId: AppId; readonly requestId: string; readonly requestedBy: MembershipId };
type Admission = AppResult<{ readonly operation: AppOperation }>;

/**
 * Admits a publish or rollback under the app row lock: a repeated request returns its operation, otherwise the
 * operation claims the next release generation. Only the operation holding the newest generation can switch.
 */
async function admitRelease(
  tx: AppTransaction,
  request: Request,
  kind: 'publish' | 'rollback',
  target: (app: AppRecord) => Promise<AppResult<{ readonly releaseId: (generation: number) => Promise<string> }>>,
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

/** Ends an unfinished operation with a failure. The live release keeps serving. */
export async function failOperation(tx: AppTransaction, id: AppOperationId, failure: AppFailure) {
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_app_operations')} SET status = 'failed', failure = $2, finished_at = clock_timestamp()
     WHERE id = $1 AND status IN ('admitted', 'staging')`,
    [id, JSON.stringify(failure)],
  );
  return (await readOperation(tx, id))!;
}

/**
 * Moves the live pointer to the operation's release only while its generation is still the newest. An operation
 * admitted later wins even if it finishes first; the older one is then superseded. Stop columns are never written, so
 * a publish cannot undo a pause or disable. Running it again returns the recorded outcome.
 */
export async function switchRelease(
  tx: AppTransaction,
  id: AppOperationId,
): Promise<{ readonly operation: AppOperation; readonly edgeVersion: number | null }> {
  const operation = await readOperation(tx, id, true);
  if (!operation) throw new Error(`App operation ${id} not found`);
  if (operation.status !== 'admitted' && operation.status !== 'staging') return { operation, edgeVersion: null };
  const [switched] = await rows<{ edge_version: string }>(
    tx,
    `UPDATE ${table(tx, 'tf_apps')} SET live_release_id = $3, edge_version = edge_version + 1
     WHERE id = $1 AND release_generation = $2 RETURNING edge_version`,
    [operation.appId, operation.generation, operation.targetReleaseId],
  );
  if (switched) {
    await tx.client.query(
      `UPDATE ${table(tx, 'tf_app_operations')} SET status = 'switched', finished_at = clock_timestamp() WHERE id = $1`,
      [id],
    );
    return { operation: (await readOperation(tx, id))!, edgeVersion: Number(switched.edge_version) };
  }
  const app = (await readApp(tx, operation.appId))!;
  const failure = {
    code: 'superseded',
    message: 'A newer publish or rollback replaced this one',
    retryable: false,
    by: app.releaseGeneration,
  };
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_app_operations')} SET status = 'superseded', failure = $2, finished_at = clock_timestamp()
     WHERE id = $1`,
    [id, JSON.stringify(failure)],
  );
  return { operation: (await readOperation(tx, id))!, edgeVersion: null };
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
