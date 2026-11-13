import type { AppBuildStatus, AppFailure } from '../app.ts';
import type { AppBuildId, AppId, GitCommit, MembershipId } from '../ids.ts';
import { appBuildId, type AppRecipe } from '../recipe.ts';
import { rows, table, type AppTransaction } from './sql.ts';

export type AppBuild = {
  readonly id: AppBuildId;
  readonly appId: AppId;
  readonly commit: GitCommit;
  readonly recipe: AppRecipe;
  readonly builder: string;
  readonly status: AppBuildStatus;
  readonly manifestKey: string | null;
};

type BuildRow = {
  id: string;
  app_id: string;
  commit: string;
  recipe: AppRecipe;
  builder: string;
  status: AppBuildStatus['status'];
  manifest_key: string | null;
  manifest_digest: string | null;
  files: number | null;
  bytes: string | null;
  failure: AppFailure | null;
  created_at: Date;
};

function statusOf(row: BuildRow): AppBuildStatus {
  switch (row.status) {
    case 'queued':
      return { status: 'queued' };
    case 'running':
      // The table keeps no separate start time, so a running build reports when it was requested.
      return { status: 'running', startedAt: row.created_at.toISOString() };
    case 'succeeded':
      return { status: 'succeeded', manifestDigest: row.manifest_digest!, files: row.files!, bytes: Number(row.bytes) };
    case 'failed':
      return { status: 'failed', failure: row.failure! };
  }
}

const buildOf = (row: BuildRow): AppBuild => ({
  id: row.id as AppBuildId,
  appId: row.app_id as AppId,
  commit: row.commit as GitCommit,
  recipe: row.recipe,
  builder: row.builder,
  status: statusOf(row),
  manifestKey: row.manifest_key,
});

export async function readBuild(tx: AppTransaction, id: AppBuildId): Promise<AppBuild | null> {
  const [row] = await rows<BuildRow>(tx, `SELECT * FROM ${table(tx, 'tf_app_builds')} WHERE id = $1`, [id]);
  return row ? buildOf(row) : null;
}

/** Records a queued build of a commit. Requesting the same commit, recipe and builder again returns the same build. */
export async function requestBuild(
  tx: AppTransaction,
  input: {
    readonly appId: AppId;
    readonly commit: GitCommit;
    readonly recipe: AppRecipe;
    readonly builder: string;
    readonly requestedBy: MembershipId;
  },
): Promise<AppBuild> {
  const id = await appBuildId(input.commit, input.recipe, input.builder);
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_app_builds')} (id, app_id, commit, recipe, builder, status, requested_by)
     VALUES ($1, $2, $3, $4, $5, 'queued', $6) ON CONFLICT (id) DO NOTHING`,
    [id, input.appId, input.commit, JSON.stringify(input.recipe), input.builder, input.requestedBy],
  );
  return (await readBuild(tx, id))!;
}

/** Moves a queued build to running. A finished build stays finished. */
export async function startBuild(tx: AppTransaction, id: AppBuildId) {
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_app_builds')} SET status = 'running' WHERE id = $1 AND status = 'queued'`,
    [id],
  );
  return (await readBuild(tx, id))!;
}

/** Records the outcome of a build once. A retried activity finds the first outcome and leaves it in place. */
export async function finishBuild(
  tx: AppTransaction,
  id: AppBuildId,
  outcome:
    | {
        readonly ok: true;
        readonly manifestKey: string;
        readonly manifestDigest: string;
        readonly files: number;
        readonly bytes: number;
      }
    | { readonly ok: false; readonly failure: AppFailure },
) {
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_app_builds')} SET status = $2, manifest_key = $3, manifest_digest = $4, files = $5,
       bytes = $6, failure = $7, finished_at = clock_timestamp()
     WHERE id = $1 AND status IN ('queued', 'running')`,
    outcome.ok
      ? [id, 'succeeded', outcome.manifestKey, outcome.manifestDigest, outcome.files, outcome.bytes, null]
      : [id, 'failed', null, null, null, null, JSON.stringify(outcome.failure)],
  );
  return (await readBuild(tx, id))!;
}

/** Points the draft preview at a succeeded build, only while the draft head is still the commit it built. */
export async function setPreviewBuild(tx: AppTransaction, id: AppBuildId) {
  const result = await tx.client.query(
    `UPDATE ${table(tx, 'tf_app_drafts')} d SET preview_build_id = b.id, updated_at = clock_timestamp()
     FROM ${table(tx, 'tf_app_builds')} b
     WHERE b.id = $1 AND b.status = 'succeeded' AND d.app_id = b.app_id AND d.head_commit = b.commit`,
    [id],
  );
  return { previewed: result.rowCount === 1 };
}
