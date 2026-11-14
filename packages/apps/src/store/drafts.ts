import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appLimits, type AppFailure } from '../app.ts';
import type { AppBuildId, AppId, GitCommit, MembershipId } from '../ids.ts';
import { failed, rows, table, type AppResult, type AppTransaction } from './sql.ts';

export const appLeaseMinutes = 15;

/** A path inside the app tree. It can never name a file outside the tree or inside Git's own directory. */
export const appFilePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(path => !path.startsWith('/') && !path.includes('\\') && !path.includes('\0'), {
    error: 'Use a relative path with / separators',
  })
  .refine(path => path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'), {
    error: 'Path must stay inside the app',
  })
  .refine(path => path.split('/').every(segment => segment.toLowerCase() !== '.git'), {
    error: 'Path must stay inside the app',
  });

export type AppDraft = {
  readonly appId: AppId;
  readonly revision: number;
  readonly headCommit: GitCommit | null;
  readonly lease: {
    readonly id: string;
    readonly conversationId: string;
    readonly membershipId: MembershipId;
    readonly expiresAt: string;
    readonly expired: boolean;
  } | null;
  readonly previewBuildId: AppBuildId | null;
  readonly failure: AppFailure | null;
};

type DraftRow = {
  app_id: string;
  revision: string;
  head_commit: string | null;
  lease_id: string | null;
  lease_conversation_id: string | null;
  lease_membership_id: string | null;
  lease_expires_at: Date | null;
  expired: boolean;
  preview_build_id: string | null;
  failure: AppFailure | null;
};

const draftOf = (row: DraftRow): AppDraft => ({
  appId: row.app_id as AppId,
  revision: Number(row.revision),
  headCommit: row.head_commit as GitCommit | null,
  lease:
    row.lease_id === null
      ? null
      : {
          id: row.lease_id,
          conversationId: row.lease_conversation_id!,
          membershipId: row.lease_membership_id as MembershipId,
          expiresAt: row.lease_expires_at!.toISOString(),
          expired: row.expired,
        },
  previewBuildId: row.preview_build_id as AppBuildId | null,
  failure: row.failure,
});

export async function readDraft(tx: AppTransaction, appId: AppId, lock = false): Promise<AppDraft | null> {
  const [row] = await rows<DraftRow>(
    tx,
    `SELECT *, COALESCE(lease_expires_at <= clock_timestamp(), false) AS expired
     FROM ${table(tx, 'tf_app_drafts')} WHERE app_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [appId],
  );
  return row ? draftOf(row) : null;
}

/** A private app's draft pages as last written, unchecked, with the revision a replace must name. */
export async function readDraftDefinition(
  tx: AppTransaction,
  appId: AppId,
): Promise<{ readonly revision: number; readonly definition: unknown } | null> {
  const [row] = await rows<{ revision: string; definition: unknown }>(
    tx,
    `SELECT revision, definition FROM ${table(tx, 'tf_app_drafts')} WHERE app_id = $1`,
    [appId],
  );
  return row ? { revision: Number(row.revision), definition: row.definition } : null;
}

export type AppStagedChange = { readonly path: string; readonly content: Uint8Array | null };

export async function readStagedChanges(tx: AppTransaction, appId: AppId, leaseId: string): Promise<AppStagedChange[]> {
  return rows<AppStagedChange>(
    tx,
    `SELECT path, content FROM ${table(tx, 'tf_app_draft_changes')} WHERE app_id = $1 AND lease_id = $2 ORDER BY path`,
    [appId, leaseId],
  );
}

/**
 * Takes or renews the editing lease for a chat, keeping the chat's own lease and staged changes even after it expired.
 * Another chat's live lease makes the draft busy. Taking over another chat's expired lease drops the changes its holder
 * staged and never saved.
 */
export async function takeLease(
  tx: AppTransaction,
  input: { readonly appId: AppId; readonly conversationId: string; readonly membershipId: MembershipId },
): Promise<AppResult<{ readonly leaseId: string; readonly revision: number }>> {
  const [taken] = await rows<{ lease_id: string; revision: string }>(
    tx,
    `UPDATE ${table(tx, 'tf_app_drafts')} SET
       lease_id = CASE WHEN lease_conversation_id = $2 THEN lease_id ELSE $4 END,
       lease_conversation_id = $2,
       lease_membership_id = $3,
       lease_expires_at = clock_timestamp() + make_interval(mins => $5),
       updated_at = clock_timestamp()
     WHERE app_id = $1 AND (lease_id IS NULL OR lease_expires_at <= clock_timestamp() OR lease_conversation_id = $2)
     RETURNING lease_id, revision`,
    [input.appId, input.conversationId, input.membershipId, randomUUID(), appLeaseMinutes],
  );
  if (!taken) {
    const draft = await readDraft(tx, input.appId);
    if (!draft) return failed('not-found', 'App not found');
    return failed('draft-busy', 'Another chat is editing this app', true);
  }
  await tx.client.query(`DELETE FROM ${table(tx, 'tf_app_draft_changes')} WHERE app_id = $1 AND lease_id <> $2`, [
    input.appId,
    taken.lease_id,
  ]);
  return { ok: true, leaseId: taken.lease_id, revision: Number(taken.revision) };
}

/**
 * Stages one file write or delete (`content: null`) for the chat holding the lease, taking the lease if it is free.
 * `headTree` maps each path at the draft head commit to its size, so the limits apply to the tree a save would commit.
 */
export async function stageDraftChange(
  tx: AppTransaction,
  input: {
    readonly appId: AppId;
    readonly conversationId: string;
    readonly membershipId: MembershipId;
    readonly path: string;
    readonly content: Uint8Array | null;
  },
  headTree: ReadonlyMap<string, number>,
): Promise<AppResult<{ readonly leaseId: string; readonly revision: number }>> {
  const path = appFilePathSchema.safeParse(input.path);
  if (!path.success) return failed('limit-exceeded', `${input.path}: ${path.error.issues[0]?.message}`);
  if (input.content && input.content.byteLength > appLimits.fileBytes)
    return failed('limit-exceeded', `${input.path} is larger than ${appLimits.fileBytes} bytes`);
  const lease = await takeLease(tx, input);
  if (!lease.ok) return lease;
  const tree = new Map(headTree);
  for (const change of await readStagedChanges(tx, input.appId, lease.leaseId)) {
    if (change.content === null) tree.delete(change.path);
    else tree.set(change.path, change.content.byteLength);
  }
  if (input.content === null) tree.delete(path.data);
  else tree.set(path.data, input.content.byteLength);
  const limit = treeLimitFailure(tree);
  if (limit) return { ok: false, failure: limit };
  // The runtime role cannot update staged rows, so a rewrite of the same path replaces the row.
  await tx.client.query(
    `DELETE FROM ${table(tx, 'tf_app_draft_changes')} WHERE app_id = $1 AND lease_id = $2 AND path = $3`,
    [input.appId, lease.leaseId, path.data],
  );
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_app_draft_changes')} (app_id, lease_id, path, content, sha256)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.appId,
      lease.leaseId,
      path.data,
      input.content && Buffer.from(input.content),
      input.content && createHash('sha256').update(input.content).digest('hex'),
    ],
  );
  const [bumped] = await rows<{ revision: string }>(
    tx,
    `UPDATE ${table(tx, 'tf_app_drafts')} SET revision = revision + 1, updated_at = clock_timestamp()
     WHERE app_id = $1 RETURNING revision`,
    [input.appId],
  );
  return { ok: true, leaseId: lease.leaseId, revision: Number(bumped!.revision) };
}

export function treeLimitFailure(tree: ReadonlyMap<string, number>): AppFailure | null {
  if (tree.size > appLimits.files)
    return { code: 'limit-exceeded', message: `An app can hold at most ${appLimits.files} files`, retryable: false };
  let bytes = 0;
  for (const size of tree.values()) bytes += size;
  if (bytes > appLimits.treeBytes)
    return {
      code: 'limit-exceeded',
      message: `An app can hold at most ${appLimits.treeBytes} bytes`,
      retryable: false,
    };
  return null;
}

/** Most bytes a private app's draft pages may take as JSON. */
export const appDefinitionBytes = 1024 * 1024;

/**
 * Writes a private app's draft pages for a chat, taking the lease if it is free. The pages are kept even when they do
 * not pass the check yet, so an editor can build them up across calls; publishing checks them again.
 */
export async function writeDraftDefinition(
  tx: AppTransaction,
  input: {
    readonly appId: AppId;
    readonly conversationId: string;
    readonly membershipId: MembershipId;
    readonly expectedRevision: number;
    readonly definition: unknown;
  },
): Promise<AppResult<{ readonly revision: number }>> {
  const json = JSON.stringify(input.definition);
  if (Buffer.byteLength(json) > appDefinitionBytes)
    return failed('limit-exceeded', `An app's pages can take at most ${appDefinitionBytes} bytes`);
  const lease = await takeLease(tx, input);
  if (!lease.ok) return lease;
  if (lease.revision !== input.expectedRevision)
    return failed('stale-draft', `The draft is at revision ${lease.revision}. Read it again, then replace the page.`);
  const [written] = await rows<{ revision: string }>(
    tx,
    `UPDATE ${table(tx, 'tf_app_drafts')} SET definition = $2::jsonb, revision = revision + 1,
       updated_at = clock_timestamp()
     WHERE app_id = $1 RETURNING revision`,
    [input.appId, json],
  );
  return { ok: true, revision: Number(written!.revision) };
}

/** Drops what a cancelled or failed turn staged and frees the lease. The saved draft and the live app are untouched. */
export async function discardDraftChanges(tx: AppTransaction, appId: AppId, leaseId: string) {
  await tx.client.query(`DELETE FROM ${table(tx, 'tf_app_draft_changes')} WHERE app_id = $1 AND lease_id = $2`, [
    appId,
    leaseId,
  ]);
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_app_drafts')} SET lease_id = NULL, lease_conversation_id = NULL,
       lease_membership_id = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
     WHERE app_id = $1 AND lease_id = $2`,
    [appId, leaseId],
  );
}
