import { randomBytes } from 'node:crypto';
import type { AppApproval, AppKind, AppStops } from '../app.ts';
import type { AppGeneration, AppId, AppReleaseId, MembershipId } from '../ids.ts';
import type { AppName, AppSlug } from '../names.ts';
import { failed, rows, table, type AppResult, type AppTransaction } from './sql.ts';

export type AppRecord = {
  readonly id: AppId;
  readonly kind: AppKind;
  readonly slug: AppSlug;
  readonly title: string;
  readonly createdBy: MembershipId;
  readonly publicName: AppName | null;
  readonly approval: AppApproval;
  readonly releaseGeneration: AppGeneration;
  readonly liveReleaseId: AppReleaseId | null;
  readonly edgeVersion: number;
  readonly stops: AppStops;
  readonly previewKey: string | null;
  readonly archivedAt: string | null;
};

export type AppRow = {
  id: string;
  kind: AppKind;
  slug: string;
  title: string;
  created_by: string;
  public_name: string | null;
  approval_state: AppApproval['state'];
  approval_by: string | null;
  approval_at: Date | null;
  monthly_limit_units: string | null;
  release_generation: string;
  live_release_id: string | null;
  edge_version: string;
  editor_paused_at: Date | null;
  budget_paused_at: Date | null;
  disabled_at: Date | null;
  preview_key: string | null;
  archived_at: Date | null;
};

const iso = (value: Date | null) => value?.toISOString() ?? null;

function approvalOf(row: AppRow): AppApproval {
  const by = row.approval_by as MembershipId;
  const at = iso(row.approval_at) ?? '';
  switch (row.approval_state) {
    case 'not-requested':
      return { state: 'not-requested' };
    case 'requested':
      return { state: 'requested', requestedBy: by, at };
    case 'approved':
      return {
        state: 'approved',
        approvedBy: by,
        at,
        monthlyLimitUnits: row.monthly_limit_units === null ? null : BigInt(row.monthly_limit_units),
      };
    case 'rejected':
      return { state: 'rejected', rejectedBy: by, at };
  }
}

export function appRecord(row: AppRow): AppRecord {
  return {
    id: row.id as AppId,
    kind: row.kind,
    slug: row.slug as AppSlug,
    title: row.title,
    createdBy: row.created_by as MembershipId,
    publicName: row.public_name as AppName | null,
    approval: approvalOf(row),
    releaseGeneration: Number(row.release_generation) as AppGeneration,
    liveReleaseId: row.live_release_id as AppReleaseId | null,
    edgeVersion: Number(row.edge_version),
    stops: {
      disabledAt: iso(row.disabled_at),
      editorPausedAt: iso(row.editor_paused_at),
      budgetPausedAt: iso(row.budget_paused_at),
    },
    previewKey: row.preview_key,
    archivedAt: iso(row.archived_at),
  };
}

/** Reads the app row; `lock` takes the row lock that serializes publishes, stops and renames of one app. */
export async function readApp(tx: AppTransaction, id: AppId, lock = false): Promise<AppRecord | null> {
  const [row] = await rows<AppRow>(
    tx,
    `SELECT * FROM ${table(tx, 'tf_apps')} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return row ? appRecord(row) : null;
}

const previewKeyAlphabet = 'abcdefghijklmnopqrstuvwxyz234567';
const newPreviewKey = () => Array.from(randomBytes(26), byte => previewKeyAlphabet[byte % 32]).join('');

/**
 * Creates the app, its empty draft and the creator's edit grant together. Repeating a create with the same id returns
 * the app it made.
 */
export async function createApp(
  tx: AppTransaction,
  input: {
    readonly id: AppId;
    readonly kind: AppKind;
    readonly slug: AppSlug;
    readonly title: string;
    readonly createdBy: MembershipId;
  },
): Promise<AppResult<{ readonly app: AppRecord }>> {
  const [inserted] = await rows<AppRow>(
    tx,
    `INSERT INTO ${table(tx, 'tf_apps')} (id, kind, slug, title, created_by, preview_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING RETURNING *`,
    [input.id, input.kind, input.slug, input.title, input.createdBy, input.kind === 'public' ? newPreviewKey() : null],
  );
  if (!inserted) {
    const existing = await readApp(tx, input.id);
    if (existing && existing.createdBy === input.createdBy && existing.kind === input.kind)
      return { ok: true, app: existing };
    return failed('name-taken', 'Another app already uses this address');
  }
  await tx.client.query(`INSERT INTO ${table(tx, 'tf_app_drafts')} (app_id) VALUES ($1)`, [input.id]);
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_app_grants')} (app_id, grantee, membership_id, role, granted_by)
     VALUES ($1, 'member:' || $2::text, $2::uuid, 'edit', $2::uuid)`,
    [input.id, input.createdBy],
  );
  return { ok: true, app: appRecord(inserted) };
}
