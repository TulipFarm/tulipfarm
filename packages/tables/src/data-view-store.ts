import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  canAccessTable,
  currentMember,
  uuidSchema,
  type AppActor,
  type HumanActor,
  type TablePermission,
} from '@tulipfarm/access';
import { table, type TableTransaction } from './service-store.ts';
import { dataViewSchema, requireDataViewShape, type DataView } from './data-views.ts';
import * as store from './store.ts';

const viewRowSchema = z
  .object({
    id: z.uuid(),
    app_id: z.uuid(),
    table_id: z.uuid(),
    field_ids: z.array(z.uuid()),
    predicate: z.unknown(),
    actions: z.array(z.string()),
  })
  .transform(row =>
    dataViewSchema.parse({
      id: row.id,
      appId: row.app_id,
      tableId: row.table_id,
      fieldIds: row.field_ids,
      predicate: row.predicate,
      actions: row.actions,
    }),
  );

const grantRequestSchema = z.strictObject({ releaseId: uuidSchema, viewId: uuidSchema });

/** The member, if still current, behind `membershipId`. */
async function memberActor(tx: TableTransaction, membershipId: string): Promise<HumanActor | null> {
  const row = (
    await tx.client.query(`SELECT user_id FROM ${table(tx, 'tf_memberships')} WHERE id=$1 AND removed_at IS NULL`, [
      membershipId,
    ])
  ).rows[0];
  return row ? { kind: 'human', userId: z.string().parse(row.user_id), membershipId } : null;
}

/** Sharing a view needs authority over its table: schema management plus every row permission the view uses. */
async function maySharePermissions(tx: TableTransaction, sharer: HumanActor, view: DataView) {
  const permissions: TablePermission[] = [
    'table.schema.manage',
    ...view.actions.map(action => `table.row.${action}` as const),
  ];
  for (const permission of permissions) if (!(await canAccessTable(tx, sharer, view.tableId, permission))) return false;
  return true;
}

async function requireShareable(tx: TableTransaction, view: DataView) {
  const generation = await store.activeGeneration(tx, view.tableId).catch(error => {
    if (error instanceof store.GenerationError) throw new AccessDenied();
    throw error;
  });
  if ((await store.workspaceMembersTable(tx))?.coreDefinition.id === view.tableId) throw new AccessDenied();
  requireDataViewShape(view, generation.definition);
}

async function readView(tx: TableTransaction, viewId: string) {
  const row = (
    await tx.client.query(
      `SELECT id,app_id,table_id,field_ids,predicate,actions FROM ${table(tx, 'tf_app_data_views')} WHERE id=$1`,
      [viewId],
    )
  ).rows[0];
  if (!row) throw new AccessDenied();
  return viewRowSchema.parse(row);
}

/** Saves a view for a public app. Only a member who could share the table may describe a view of it. */
export async function createDataView(tx: TableTransaction, creator: HumanActor, input: unknown) {
  const view = dataViewSchema.parse({ ...dataViewSchema.omit({ id: true }).parse(input), id: randomUUID() });
  await currentMember(tx, creator);
  const app = (
    await tx.client.query(
      `SELECT 1 FROM ${table(tx, 'tf_apps')} WHERE id=$1 AND kind='public' AND archived_at IS NULL`,
      [view.appId],
    )
  ).rowCount;
  if (!app) throw new AccessDenied();
  await requireShareable(tx, view);
  if (!(await maySharePermissions(tx, creator, view))) throw new AccessDenied();
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_app_data_views')} (id,app_id,table_id,field_ids,predicate,actions,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      view.id,
      view.appId,
      view.tableId,
      view.fieldIds,
      JSON.stringify(view.predicate),
      view.actions,
      creator.membershipId,
    ],
  );
  return view;
}

/** Grants a view to one release of its app. The grant serves nothing until an admin approves it. */
export async function shareDataView(tx: TableTransaction, sharer: HumanActor, input: unknown) {
  const { releaseId, viewId } = grantRequestSchema.parse(input);
  await currentMember(tx, sharer);
  const view = await readView(tx, viewId);
  const release = (
    await tx.client.query(
      `SELECT 1 FROM ${table(tx, 'tf_app_releases')} r JOIN ${table(tx, 'tf_apps')} a ON a.id=r.app_id
      WHERE r.id=$1 AND r.app_id=$2 AND a.kind='public' AND a.archived_at IS NULL`,
      [releaseId, view.appId],
    )
  ).rowCount;
  if (!release) throw new AccessDenied();
  await requireShareable(tx, view);
  if (!(await maySharePermissions(tx, sharer, view))) throw new AccessDenied();
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_app_data_view_grants')} (release_id,view_id,shared_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [releaseId, viewId, sharer.membershipId],
  );
}

/** An admin approves a shared view for a release. Approving twice keeps the first decision. */
export async function approveDataView(tx: TableTransaction, admin: HumanActor, input: unknown) {
  const { releaseId, viewId } = grantRequestSchema.parse(input);
  if ((await currentMember(tx, admin)).role !== 'admin') throw new AccessDenied();
  const grant = (
    await tx.client.query(
      `SELECT shared_by FROM ${table(tx, 'tf_app_data_view_grants')} WHERE release_id=$1 AND view_id=$2 FOR UPDATE`,
      [releaseId, viewId],
    )
  ).rows[0];
  if (!grant) throw new AccessDenied();
  const view = await readView(tx, viewId);
  const sharer = await memberActor(tx, uuidSchema.parse(grant.shared_by));
  if (!sharer || !(await maySharePermissions(tx, sharer, view))) throw new AccessDenied();
  await requireShareable(tx, view);
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_app_data_view_grants')} SET approved_by=$3,approved_at=clock_timestamp() WHERE release_id=$1 AND view_id=$2 AND approved_by IS NULL`,
    [releaseId, viewId, admin.membershipId],
  );
}

/**
 * The view `actor` may use now. The view must be granted to the actor's live release of a public, approved app, and
 * approved. The approver must still be an admin and the sharer must still hold the table permissions the view uses: an
 * approval records a decision and stops serving once either person leaves or loses that authority. A viewer adds
 * nothing.
 */
export async function approvedDataView(tx: TableTransaction, actor: AppActor, viewId: string) {
  const row = (
    await tx.client.query(
      `SELECT v.id,v.app_id,v.table_id,v.field_ids,v.predicate,v.actions,g.shared_by
      FROM ${table(tx, 'tf_app_data_views')} v
      JOIN ${table(tx, 'tf_app_data_view_grants')} g ON g.view_id=v.id AND g.release_id=$2
      JOIN ${table(tx, 'tf_app_releases')} r ON r.id=g.release_id AND r.app_id=v.app_id
      JOIN ${table(tx, 'tf_apps')} a ON a.id=v.app_id AND a.live_release_id=r.id
      JOIN ${table(tx, 'tf_memberships')} approver ON approver.id=g.approved_by AND approver.removed_at IS NULL AND approver.role='admin'
      WHERE v.id=$1 AND v.app_id=$3 AND a.kind='public' AND a.approval_state='approved'
        AND a.disabled_at IS NULL AND a.archived_at IS NULL AND a.budget_paused_at IS NULL`,
      [uuidSchema.parse(viewId), actor.releaseId, actor.appId],
    )
  ).rows[0];
  if (!row) throw new AccessDenied();
  const view = viewRowSchema.parse(row);
  const sharer = await memberActor(tx, uuidSchema.parse(row.shared_by));
  if (!sharer || !(await maySharePermissions(tx, sharer, view))) throw new AccessDenied();
  if ((await store.workspaceMembersTable(tx))?.coreDefinition.id === view.tableId) throw new AccessDenied();
  return view;
}
