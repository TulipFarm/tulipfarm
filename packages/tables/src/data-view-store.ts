import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  canAccessTable,
  currentMember,
  lockAuthorization,
  uuidSchema,
  type AppActor,
  type HumanActor,
  type TablePermission,
} from '@tulipfarm/access';
import { table, type TableTransaction } from './service-store.ts';
import { TableValidationError, type TableDefinition } from './definition.ts';
import {
  dataViewDraftSchema,
  dataViewSchema,
  rangedHiddenField,
  unresolvedDataViewField,
  type DataView,
} from './data-views.ts';
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

const grantRequestSchema = z.strictObject({ appId: uuidSchema, viewId: uuidSchema });

/** Why a view serves no requests now. A view with none serves whichever release of its app is live. */
export type DataViewBlocker = 'app-not-serving' | 'not-approved' | 'view-unresolvable';

export type DataViewEntry = DataView & {
  createdBy: string;
  createdAt: Date;
  sharedBy: string | null;
  sharedAt: Date | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  blockers: DataViewBlocker[];
};

/** Sharing a view needs authority over its table: schema management plus every row permission the view uses. */
async function maySharePermissions(
  tx: TableTransaction,
  sharer: HumanActor,
  view: Pick<DataView, 'tableId' | 'actions'>,
) {
  const permissions: TablePermission[] = [
    'table.schema.manage',
    ...view.actions.map(action => `table.row.${action}` as const),
  ];
  for (const permission of permissions) if (!(await canAccessTable(tx, sharer, view.tableId, permission))) return false;
  return true;
}

/** The table's current definition, or null when no view may be made of it. */
async function shareableDefinition(tx: TableTransaction, tableId: string): Promise<TableDefinition | null> {
  if ((await store.workspaceMembersTable(tx))?.coreDefinition.id === tableId) return null;
  const generation = await store.activeGeneration(tx, tableId).catch(error => {
    if (error instanceof store.GenerationError) return null;
    throw error;
  });
  return generation?.definition ?? null;
}

async function resolves(tx: TableTransaction, view: DataView) {
  const definition = await shareableDefinition(tx, view.tableId);
  return definition !== null && unresolvedDataViewField(view, definition) === undefined;
}

async function requireShareable(tx: TableTransaction, view: DataView) {
  if (!(await resolves(tx, view))) throw new AccessDenied();
}

async function readView(tx: TableTransaction, appId: string, viewId: string) {
  const row = (
    await tx.client.query(
      `SELECT id,app_id,table_id,field_ids,predicate,actions FROM ${table(tx, 'tf_app_data_views')} WHERE id=$1 AND app_id=$2`,
      [viewId, appId],
    )
  ).rows[0];
  if (!row) throw new AccessDenied();
  return viewRowSchema.parse(row);
}

/** The live release of `appId` while the app serves public requests, otherwise null. */
async function servingRelease(tx: TableTransaction, appId: string) {
  const row = (
    await tx.client.query(
      `SELECT live_release_id FROM ${table(tx, 'tf_apps')} WHERE id=$1 AND kind='public' AND approval_state='approved'
        AND disabled_at IS NULL AND archived_at IS NULL AND editor_paused_at IS NULL AND budget_paused_at IS NULL`,
      [appId],
    )
  ).rows[0] as { live_release_id: string | null } | undefined;
  return row?.live_release_id ?? null;
}

/**
 * Everything that stops `view` serving now, in the order a member would fix them. An approval is a recorded decision: it
 * keeps serving after the people who shared and approved it leave or lose rights, until it is revoked.
 */
async function viewBlockers(tx: TableTransaction, view: DataView, approved: boolean) {
  const blockers: DataViewBlocker[] = [];
  if ((await servingRelease(tx, view.appId)) === null) blockers.push('app-not-serving');
  if (!approved) blockers.push('not-approved');
  if (!(await resolves(tx, view))) blockers.push('view-unresolvable');
  return blockers;
}

/**
 * Saves a view for a public app under `id`. Only a member who could share the table may describe a view of it. Saving
 * an id again returns the view saved first.
 */
export async function createDataView(
  tx: TableTransaction,
  creator: HumanActor,
  input: unknown,
  id: string = randomUUID(),
) {
  const draft = dataViewDraftSchema.parse(input);
  await currentMember(tx, creator);
  const app = (
    await tx.client.query(
      `SELECT 1 FROM ${table(tx, 'tf_apps')} WHERE id=$1 AND kind='public' AND archived_at IS NULL`,
      [draft.appId],
    )
  ).rowCount;
  if (!app || !(await maySharePermissions(tx, creator, draft))) throw new AccessDenied();
  const definition = await shareableDefinition(tx, draft.tableId);
  if (!definition) throw new AccessDenied();
  const unresolved = unresolvedDataViewField(draft, definition);
  if (unresolved)
    throw new TableValidationError('A view can use only fields of this table that hold plain values', unresolved);
  const ranged = rangedHiddenField(draft);
  if (ranged)
    throw new TableValidationError('A parameter may only test a field the view does not list for equality', ranged);
  const view = dataViewSchema.parse({ ...draft, id: uuidSchema.parse(id) });
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_app_data_views')} (id,app_id,table_id,field_ids,predicate,actions,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
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
  return readView(tx, view.appId, view.id);
}

/** Shares a view with its app, for every release. The share serves nothing until an admin approves it. */
export async function shareDataView(tx: TableTransaction, sharer: HumanActor, input: unknown) {
  const { appId, viewId } = grantRequestSchema.parse(input);
  await currentMember(tx, sharer);
  const view = await readView(tx, appId, viewId);
  const app = (
    await tx.client.query(
      `SELECT 1 FROM ${table(tx, 'tf_apps')} WHERE id=$1 AND kind='public' AND archived_at IS NULL`,
      [view.appId],
    )
  ).rowCount;
  if (!app) throw new AccessDenied();
  await requireShareable(tx, view);
  if (!(await maySharePermissions(tx, sharer, view))) throw new AccessDenied();
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_app_data_view_grants')} (view_id,shared_by) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [viewId, sharer.membershipId],
  );
}

/** An admin approves a shared view. Approving twice keeps the first decision. */
export async function approveDataView(tx: TableTransaction, admin: HumanActor, input: unknown) {
  const { appId, viewId } = grantRequestSchema.parse(input);
  if ((await currentMember(tx, admin)).role !== 'admin') throw new AccessDenied();
  const view = await readView(tx, appId, viewId);
  await requireShareable(tx, view);
  const { rowCount } = await tx.client.query(
    `SELECT 1 FROM ${table(tx, 'tf_app_data_view_grants')} WHERE view_id=$1 FOR UPDATE`,
    [viewId],
  );
  if (!rowCount) throw new AccessDenied();
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_app_data_view_grants')} SET approved_by=$2,approved_at=clock_timestamp() WHERE view_id=$1 AND approved_by IS NULL`,
    [viewId, admin.membershipId],
  );
}

/**
 * Removes a view's share and approval for every release. It takes the authorization lock for writing, so it waits for
 * app requests already running and every later request sees the grant gone. Revoking a missing grant does nothing.
 */
export async function revokeDataView(tx: TableTransaction, member: HumanActor, input: unknown) {
  const { appId, viewId } = grantRequestSchema.parse(input);
  await lockAuthorization(tx, 'write');
  await currentMember(tx, member);
  await readView(tx, appId, viewId);
  await tx.client.query(`DELETE FROM ${table(tx, 'tf_app_data_view_grants')} WHERE view_id=$1`, [viewId]);
}

const entryRowSchema = z.object({
  created_by: z.uuid(),
  created_at: z.date(),
  shared_by: z.uuid().nullable(),
  shared_at: z.date().nullable(),
  approved_by: z.uuid().nullable(),
  approved_at: z.date().nullable(),
});

/** The app's views, oldest first, each with who shared and approved it and what stops it serving. */
export async function listDataViews(tx: TableTransaction, appId: string, viewId?: string): Promise<DataViewEntry[]> {
  const { rows } = await tx.client.query(
    `SELECT v.id,v.app_id,v.table_id,v.field_ids,v.predicate,v.actions,v.created_by,v.created_at,
      g.shared_by,g.shared_at,g.approved_by,g.approved_at
    FROM ${table(tx, 'tf_app_data_views')} v LEFT JOIN ${table(tx, 'tf_app_data_view_grants')} g ON g.view_id=v.id
    WHERE v.app_id=$1 AND ($2::uuid IS NULL OR v.id=$2) ORDER BY v.created_at, v.id`,
    [uuidSchema.parse(appId), viewId === undefined ? null : uuidSchema.parse(viewId)],
  );
  const entries: DataViewEntry[] = [];
  for (const row of rows) {
    const view = viewRowSchema.parse(row);
    const grant = entryRowSchema.parse(row);
    entries.push({
      ...view,
      createdBy: grant.created_by,
      createdAt: grant.created_at,
      sharedBy: grant.shared_by,
      sharedAt: grant.shared_at,
      approvedBy: grant.approved_by,
      approvedAt: grant.approved_at,
      blockers: await viewBlockers(tx, view, grant.approved_by !== null),
    });
  }
  return entries;
}

/**
 * The view `actor` may use now: an approved view of the actor's app, which is public and serving, from the release that
 * is live now. A host still running an older release is refused. A viewer adds nothing.
 */
export async function approvedDataView(tx: TableTransaction, actor: AppActor, viewId: string) {
  const view = await readView(tx, actor.appId, uuidSchema.parse(viewId));
  if ((await servingRelease(tx, view.appId)) !== actor.releaseId) throw new AccessDenied();
  const { rowCount } = await tx.client.query(
    `SELECT 1 FROM ${table(tx, 'tf_app_data_view_grants')} WHERE view_id=$1 AND approved_by IS NOT NULL`,
    [view.id],
  );
  if ((await viewBlockers(tx, view, Boolean(rowCount))).length) throw new AccessDenied();
  return view;
}
