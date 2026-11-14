import type { AppId, GitCommit } from '../ids.ts';
import { readDraft, readStagedChanges, treeLimitFailure } from './drafts.ts';
import type { AppRepositories, AppSourceBundle } from './repository.ts';
import { failed, rows, table, type AppResult, type AppTransaction, type AppTransactions } from './sql.ts';

type BundleRow = {
  seq: number;
  base_commit: string | null;
  head_commit: string;
  object_key: string;
  sha256: string;
  bytes: string;
};

export async function readSourceBundles(tx: AppTransaction, appId: AppId): Promise<AppSourceBundle[]> {
  const found = await rows<BundleRow>(
    tx,
    `SELECT seq, base_commit, head_commit, object_key, sha256, bytes FROM ${table(tx, 'tf_app_source_bundles')}
     WHERE app_id = $1 ORDER BY seq`,
    [appId],
  );
  return found.map(row => ({
    seq: row.seq,
    baseCommit: row.base_commit as GitCommit | null,
    headCommit: row.head_commit as GitCommit,
    objectKey: row.object_key,
    sha256: row.sha256,
    bytes: Number(row.bytes),
  }));
}

// Matching the lease id keeps a save that outlived its lease from freeing the lease another chat took since.
const releaseLease = (tx: AppTransaction, appId: AppId, leaseId: string) =>
  tx.client.query(
    `UPDATE ${table(tx, 'tf_app_drafts')} SET lease_id = NULL, lease_conversation_id = NULL,
       lease_membership_id = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
     WHERE app_id = $1 AND lease_id = $2`,
    [appId, leaseId],
  );

/**
 * Saves the lease holder's staged changes as one commit. The bundle is stored before the transaction that records it,
 * so an acknowledged save can always be restored; a crash in between leaves only an unreferenced object, and the
 * staged changes stay in place for the next save.
 */
export async function saveDraft(
  transact: AppTransactions,
  repositories: AppRepositories,
  input: {
    readonly workspaceId: string;
    readonly appId: AppId;
    readonly leaseId: string;
    readonly expectedRevision: number;
    readonly coAuthor: { readonly name: string; readonly email: string };
    /** Frees the lease after saving, as at the end of a turn. */
    readonly endLease: boolean;
  },
): Promise<AppResult<{ readonly commit: GitCommit | null; readonly revision: number }>> {
  const read = await transact(async tx => {
    const draft = await readDraft(tx, input.appId);
    if (!draft) return failed('not-found', 'App not found');
    if (draft.lease?.id !== input.leaseId || draft.revision !== input.expectedRevision)
      return failed('stale-draft', 'The draft changed since this save started', true);
    const changes = await readStagedChanges(tx, input.appId, input.leaseId);
    if (!changes.length && input.endLease) await releaseLease(tx, input.appId, input.leaseId);
    return { ok: true as const, draft, changes, bundles: await readSourceBundles(tx, input.appId) };
  });
  if (!read.ok) return read;
  const { draft, changes, bundles } = read;
  if (!changes.length) return { ok: true, commit: draft.headCommit, revision: draft.revision };

  const repository = await repositories.open(input.workspaceId, input.appId, draft.headCommit, bundles);
  const saved = await repositories.commit(repository, {
    head: draft.headCommit,
    changes,
    coAuthor: input.coAuthor,
    message: 'Save app draft',
  });
  const limit = treeLimitFailure(saved.sizes);
  if (limit) return { ok: false, failure: limit };
  const seq = (bundles.at(-1)?.seq ?? 0) + 1;
  const stored = await repositories.upload(input.workspaceId, input.appId, seq, saved.bundle);

  return transact(async tx => {
    const current = await readDraft(tx, input.appId, true);
    if (
      current?.lease?.id !== input.leaseId ||
      current.revision !== input.expectedRevision ||
      current.headCommit !== draft.headCommit
    )
      return failed('stale-draft', 'The draft changed while it was being saved', true);
    await tx.client.query(
      `INSERT INTO ${table(tx, 'tf_app_source_bundles')} (app_id, seq, base_commit, head_commit, object_key, sha256, bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [input.appId, seq, draft.headCommit, saved.commit, stored.objectKey, stored.sha256, stored.bytes],
    );
    const [updated] = await rows<{ revision: string }>(
      tx,
      `UPDATE ${table(tx, 'tf_app_drafts')} SET head_commit = $2, revision = revision + 1, failure = NULL,
         updated_at = clock_timestamp()
       WHERE app_id = $1 RETURNING revision`,
      [input.appId, saved.commit],
    );
    await tx.client.query(`DELETE FROM ${table(tx, 'tf_app_draft_changes')} WHERE app_id = $1 AND lease_id = $2`, [
      input.appId,
      input.leaseId,
    ]);
    if (input.endLease) await releaseLease(tx, input.appId, input.leaseId);
    return { ok: true, commit: saved.commit, revision: Number(updated!.revision) };
  });
}
