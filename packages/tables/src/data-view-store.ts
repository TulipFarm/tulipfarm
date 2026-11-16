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

const grantRequestSchema = z.strictObject({ appId: uuidSchema, releaseId: uuidSchema, viewId: uuidSchema });

/** Why a grant serves no requests now. A grant with none serves its release while that release is live. */
export type DataViewBlocker =
  | 'app-not-serving'
  | 'release-not-live'
  | 'not-approved'
  | 'approver-lost-access'
  | 'sharer-lost-access'
  | 'view-unresolvable';

export type DataViewGrant = {
  releaseId: string;
  releaseNumber: number;
  sharedBy: string;
  sharedAt: Date;
  approvedBy: string | null;
  approvedAt: Date | null;
  blockers: DataViewBlocker[];
};

export type DataViewEntry = DataView & { createdBy: string; createdAt: Date; grants: DataViewGrant[] };

const grantRowSchema = z
  .object({
    release_id: z.uuid(),
    release_number: z.number(),
    shared_by: z.uuid(),
    shared_at: z.date(),
    approved_by: z.uuid().nullable(),
    approved_at: z.date().nullable(),
  })
  .transform(row => ({
    releaseId: row.release_id,
    releaseNumber: row.release_number,
    sharedBy: row.shared_by,
    sharedAt: row.shared_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
  }));
type GrantRecord = z.output<typeof grantRowSchema>;

/** The member, if still current, behind `membershipId`. */
async function memberActor(tx: TableTransaction, membershipId: string): Promise<HumanActor | null> {
  const row = (
    await tx.client.query(`SELECT user_id FROM ${table(tx, 'tf_memberships')} WHERE id=$1 AND removed_at IS NULL`, [
      membershipId,
    ])
  ).rows[0];
  return row ? { kind: 'human', userId: z.string().parse(row.user_id), membershipId } : null;
}

async function isCurrentAdmin(tx: TableTransaction, membershipId: string) {
  return Boolean(
    (
      await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'tf_memberships')} WHERE id=$1 AND removed_at IS NULL AND role='admin'`,
        [membershipId],
      )
    ).rowCount,
  );
}

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

/**
 * Everything that stops `grant` serving now, in the order a member would fix them. Approval provenance does not keep
 * authority alive: the approver must still be an admin and the sharer must still hold the table permissions the view
 * uses.
 */
async function grantBlockers(
  tx: TableTransaction,
  view: DataView,
  grant: Pick<GrantRecord, 'releaseId' | 'sharedBy' | 'approvedBy'>,
) {
  const blockers: DataViewBlocker[] = [];
  const app = (
    await tx.client.query(
      `SELECT live_release_id FROM ${table(tx, 'tf_apps')} WHERE id=$1 AND kind='public' AND approval_state='approved'
        AND disabled_at IS NULL AND archived_at IS NULL AND budget_paused_at IS NULL`,
      [view.appId],
    )
  ).rows[0] as { live_release_id: string | null } | undefined;
  if (!app) blockers.push('app-not-serving');
  else if (app.live_release_id !== grant.releaseId) blockers.push('release-not-live');
  if (grant.approvedBy === null) blockers.push('not-approved');
  else if (!(await isCurrentAdmin(tx, grant.approvedBy))) blockers.push('approver-lost-access');
  const sharer = await memberActor(tx, grant.sharedBy);
  if (!sharer || !(await maySharePermissions(tx, sharer, view))) blockers.push('sharer-lost-access');
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

/** Grants a view to one release of its app. The grant serves nothing until an admin approves it. */
export async function shareDataView(tx: TableTransaction, sharer: HumanActor, input: unknown) {
  const { appId, releaseId, viewId } = grantRequestSchema.parse(input);
  await currentMember(tx, sharer);
  const view = await readView(tx, appId, viewId);
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
  const { appId, releaseId, viewId } = grantRequestSchema.parse(input);
  if ((await currentMember(tx, admin)).role !== 'admin') throw new AccessDenied();
  const view = await readView(tx, appId, viewId);
  const grant = (
    await tx.client.query(
      `SELECT shared_by FROM ${table(tx, 'tf_app_data_view_grants')} WHERE release_id=$1 AND view_id=$2 FOR UPDATE`,
      [releaseId, viewId],
    )
  ).rows[0];
  if (!grant) throw new AccessDenied();
  const sharer = await memberActor(tx, uuidSchema.parse(grant.shared_by));
  if (!sharer || !(await maySharePermissions(tx, sharer, view))) throw new AccessDenied();
  await requireShareable(tx, view);
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_app_data_view_grants')} SET approved_by=$3,approved_at=clock_timestamp() WHERE release_id=$1 AND view_id=$2 AND approved_by IS NULL`,
    [releaseId, viewId, admin.membershipId],
  );
}

/**
 * Removes a view's grant to a release, approved or not. It takes the authorization lock for writing, so it waits for
 * app requests already running and every later request sees the grant gone. Revoking a missing grant does nothing.
 */
export async function revokeDataView(tx: TableTransaction, member: HumanActor, input: unknown) {
  const { appId, releaseId, viewId } = grantRequestSchema.parse(input);
  await lockAuthorization(tx, 'write');
  await currentMember(tx, member);
  await readView(tx, appId, viewId);
  await tx.client.query(`DELETE FROM ${table(tx, 'tf_app_data_view_grants')} WHERE release_id=$1 AND view_id=$2`, [
    releaseId,
    viewId,
  ]);
}

/** The app's views, oldest first, each with its grants, newest release first, and what stops each grant serving. */
export async function listDataViews(tx: TableTransaction, appId: string, viewId?: string): Promise<DataViewEntry[]> {
  const { rows } = await tx.client.query(
    `SELECT id,app_id,table_id,field_ids,predicate,actions,created_by,created_at FROM ${table(tx, 'tf_app_data_views')}
    WHERE app_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY created_at, id`,
    [uuidSchema.parse(appId), viewId === undefined ? null : uuidSchema.parse(viewId)],
  );
  const entries: DataViewEntry[] = [];
  for (const row of rows as { created_by: string; created_at: Date }[]) {
    const view = viewRowSchema.parse(row);
    const grants = z.array(grantRowSchema).parse(
      (
        await tx.client.query(
          `SELECT g.release_id,r.number AS release_number,g.shared_by,g.shared_at,g.approved_by,g.approved_at
          FROM ${table(tx, 'tf_app_data_view_grants')} g JOIN ${table(tx, 'tf_app_releases')} r ON r.id=g.release_id
          WHERE g.view_id=$1 ORDER BY r.number DESC`,
          [view.id],
        )
      ).rows,
    );
    entries.push({
      ...view,
      createdBy: row.created_by,
      createdAt: row.created_at,
      grants: await Promise.all(
        grants.map(async grant => ({ ...grant, blockers: await grantBlockers(tx, view, grant) })),
      ),
    });
  }
  return entries;
}

/**
 * The view `actor` may use now: granted to the actor's release, which is the live release of a public, approved app,
 * and approved, with nothing blocking the grant. A viewer adds nothing.
 */
export async function approvedDataView(tx: TableTransaction, actor: AppActor, viewId: string) {
  const view = await readView(tx, actor.appId, uuidSchema.parse(viewId));
  const grant = (
    await tx.client.query(
      `SELECT release_id,shared_by,approved_by FROM ${table(tx, 'tf_app_data_view_grants')} WHERE release_id=$1 AND view_id=$2`,
      [actor.releaseId, view.id],
    )
  ).rows[0] as { release_id: string; shared_by: string; approved_by: string | null } | undefined;
  if (!grant) throw new AccessDenied();
  const blockers = await grantBlockers(tx, view, {
    releaseId: grant.release_id,
    sharedBy: grant.shared_by,
    approvedBy: grant.approved_by,
  });
  if (blockers.length) throw new AccessDenied();
  return view;
}
