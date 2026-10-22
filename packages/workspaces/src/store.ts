import type { Pool } from 'pg';
import { z } from 'zod';
import { commonTables, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceSchema, workspaceSetupSchema, type CreateWorkspace, type Workspace } from './contracts.ts';
import { commonCompatibility, type WorkspaceStore } from './storage.ts';
import type { SqlClient } from '@tulipfarm/workspace-storage/provisioning';

const rowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  created_by: z.uuid(),
  created_at: z.date(),
  soul_commit: z.string().nullable(),
  icon: z.string().nullish(),
});

function workspace(value: unknown) {
  const row = rowSchema.parse(value);
  return workspaceSchema.parse({
    id: row.id,
    name: row.name,
    slug: row.slug,
    icon: row.icon ?? null,
    createdAt: row.created_at.toISOString(),
    ...(row.soul_commit ? { status: 'ready', soulCommit: row.soul_commit } : { status: 'provisioning' }),
  });
}

export class WorkspaceConflict extends Error {}
export class WorkspaceNotFound extends Error {}
export class WorkspaceDiscoveryUnavailable extends Error {}

async function isMember(store: WorkspaceStore, workspaceId: string, userId: string) {
  return store.runtime.transaction(workspaceId, commonCompatibility, async ({ client, schema }) => {
    await client.query(`SELECT id FROM ${qualified(schema, commonTables.authorizationLock)} WHERE id = 1 FOR SHARE`);
    const result = await client.query(
      `SELECT id FROM ${qualified(schema, commonTables.memberships)} WHERE user_id = $1 AND removed_at IS NULL`,
      [userId],
    );
    return result.rowCount !== 0;
  });
}

export async function reserveWorkspace(
  client: SqlClient,
  userId: string,
  input: CreateWorkspace,
  beforeCreate: () => Promise<void>,
) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `workspace-create:${userId}:${input.requestId}`,
  ]);
  const existing = await client.query('SELECT id FROM app.workspaces WHERE created_by = $1 AND request_id = $2', [
    userId,
    input.requestId,
  ]);
  if (!existing.rows[0]) await beforeCreate();
  const result = await client.query(
    `INSERT INTO app.workspaces (request_id, created_by, name, slug, icon)
    VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING *`,
    [input.requestId, userId, input.name, input.slug, input.icon ?? null],
  );
  const inserted = Boolean(result.rows[0]);
  const value =
    result.rows[0] ??
    (
      await client.query(
        `SELECT * FROM app.workspaces
    WHERE created_by = $1 AND request_id = $2`,
        [userId, input.requestId],
      )
    ).rows[0];
  if (!value) throw new WorkspaceConflict('This workspace URL is already taken.');
  const row = rowSchema.parse(value);
  if (!inserted) {
    const storage = await client.query('SELECT stage FROM app.workspace_storage WHERE workspace_id = $1', [row.id]);
    if (!storage.rows[0] || storage.rows[0].stage === 'unavailable') throw new WorkspaceNotFound('Workspace not found');
  }
  const creation = z.object({ creation_name: z.string().optional() }).parse(value);
  if ((creation.creation_name ?? row.name) !== input.name || row.slug !== input.slug)
    throw new WorkspaceConflict('This creation request was already used. Reload and try again.');
  if (inserted) await client.query('INSERT INTO app.workspace_storage (workspace_id) VALUES ($1)', [row.id]);
  return { workspace: workspace(value), inserted };
}

export async function createWorkspace(
  store: WorkspaceStore,
  userId: string,
  input: CreateWorkspace,
  beforeCreate: () => Promise<void>,
) {
  const client = await store.pool.connect();
  let result: Workspace;
  let inserted = false;
  try {
    await client.query('BEGIN');
    const reservation = await reserveWorkspace(client, userId, input, beforeCreate);
    result = reservation.workspace;
    inserted = reservation.inserted;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    if (error instanceof Error && 'code' in error && error.code === '23505')
      throw new WorkspaceConflict('This workspace URL is already taken.');
    throw error;
  } finally {
    client.release();
  }
  if (!inserted && result.status === 'ready' && !(await isMember(store, result.id, userId)))
    throw new WorkspaceNotFound('Workspace not found');
  return result;
}

export async function listWorkspaces(store: WorkspaceStore, userId: string) {
  const pageSize = 100;
  const maximumCandidates = 1000;
  const deadline = performance.now() + 30_000;
  const candidates: z.infer<typeof rowSchema>[] = [];
  const visible: Workspace[] = [];
  let cursor: z.infer<typeof rowSchema> | undefined;
  const client = await store.pool.connect().catch(cause => {
    throw new WorkspaceDiscoveryUnavailable('Workspace discovery is incomplete. Retry.', { cause });
  });
  let destroy = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL idle_in_transaction_session_timeout = '60s'");
    for (;;) {
      if (performance.now() >= deadline)
        throw new WorkspaceDiscoveryUnavailable('Workspace discovery exceeded its time budget. Retry.');
      const result = await client.query(
        `SELECT w.* FROM app.workspaces w JOIN app.workspace_storage s ON s.workspace_id = w.id
        WHERE s.stage = 'ready' AND ($1::text IS NULL OR (w.name, w.id) > ($1, $2::uuid))
        ORDER BY w.name, w.id LIMIT $3`,
        [cursor?.name ?? null, cursor?.id ?? null, Math.min(pageSize, maximumCandidates - candidates.length + 1)],
      );
      const page = z.array(rowSchema).parse(result.rows);
      candidates.push(...page);
      if (candidates.length > maximumCandidates)
        throw new WorkspaceDiscoveryUnavailable('Workspace discovery exceeds its 1000-candidate safety limit');
      if (page.length < pageSize) break;
      cursor = page.at(-1);
    }
    await client.query('COMMIT');
  } catch (error) {
    destroy = true;
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof WorkspaceDiscoveryUnavailable) throw error;
    throw new WorkspaceDiscoveryUnavailable('Workspace discovery is incomplete. Retry.', { cause: error });
  } finally {
    client.release(destroy);
  }
  for (let offset = 0; offset < candidates.length; offset += 4) {
    if (performance.now() >= deadline)
      throw new WorkspaceDiscoveryUnavailable('Workspace discovery exceeded its time budget. Retry.');
    const batch = await Promise.allSettled(
      candidates
        .slice(offset, offset + 4)
        .map(async row => ((await isMember(store, row.id, userId)) ? workspace(row) : null)),
    );
    const rejected = batch.find((item): item is PromiseRejectedResult => item.status === 'rejected');
    if (rejected)
      throw new WorkspaceDiscoveryUnavailable('Workspace discovery is incomplete. Retry.', { cause: rejected.reason });
    for (const item of batch) if (item.status === 'fulfilled' && item.value) visible.push(item.value);
  }
  if (performance.now() >= deadline)
    throw new WorkspaceDiscoveryUnavailable('Workspace discovery exceeded its time budget. Retry.');
  return visible;
}

export async function getWorkspace(store: WorkspaceStore, userId: string, slug: string) {
  const result = await store.pool.query(
    `SELECT w.* FROM app.workspaces w JOIN app.workspace_storage s ON s.workspace_id = w.id
    WHERE w.slug = $1 AND s.stage = 'ready'`,
    [slug],
  );
  if (!result.rows[0]) return null;
  const row = rowSchema.parse(result.rows[0]);
  return (await isMember(store, row.id, userId)) ? workspace(row) : null;
}

export async function getLastWorkspace(store: WorkspaceStore, userId: string) {
  const result = await store.pool.query(
    `SELECT w.* FROM app.users u
    JOIN app.workspaces w ON w.id = u.last_workspace_id
    JOIN app.workspace_storage s ON s.workspace_id = w.id
    WHERE u.id = $1 AND s.stage = 'ready'`,
    [userId],
  );
  if (!result.rows[0]) return null;
  const row = rowSchema.parse(result.rows[0]);
  return (await isMember(store, row.id, userId)) ? workspace(row) : null;
}

export async function rememberLastWorkspace(store: WorkspaceStore, userId: string, slug: string) {
  const workspace = await getWorkspace(store, userId, slug);
  if (!workspace) throw new WorkspaceNotFound('Workspace not found');
  await store.pool.query('UPDATE app.users SET last_workspace_id = $2 WHERE id = $1', [userId, workspace.id]);
}

export async function getWorkspaceSetup(pool: Pool, userId: string, id: string) {
  const result = await pool.query(
    `SELECT w.id, s.stage, s.error_code FROM app.workspaces w
    JOIN app.workspace_storage s ON s.workspace_id = w.id WHERE w.id = $1 AND w.created_by = $2`,
    [id, userId],
  );
  if (!result.rows[0]) return null;
  const row = z
    .object({
      id: z.uuid(),
      stage: z.enum(['reserved', 'database', 'ready', 'unavailable']),
      error_code: z.string().nullable(),
    })
    .parse(result.rows[0]);
  return workspaceSetupSchema.parse({ id: row.id, stage: row.stage, error: row.error_code });
}

export async function pendingWorkspaceIds(pool: Pool) {
  const result =
    await pool.query(`SELECT w.id FROM app.workspaces w JOIN app.workspace_storage s ON s.workspace_id = w.id
    WHERE s.stage IN ('reserved', 'database') ORDER BY s.updated_at, w.id LIMIT 100`);
  return z
    .array(z.object({ id: z.uuid() }))
    .parse(result.rows)
    .map(row => row.id);
}

export async function workspaceSeed(pool: Pool, id: string) {
  const result = await pool.query('SELECT * FROM app.workspaces WHERE id = $1', [z.uuid().parse(id)]);
  const row = rowSchema.parse(result.rows[0]);
  return { workspaceId: row.id, createdBy: row.created_by, createdAt: row.created_at.toISOString() };
}
