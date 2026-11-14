import type { AppRoute } from '@tulipfarm/extensions';
import { z } from 'zod';
import type { AppId } from '../ids.ts';
import type { AppName } from '../names.ts';
import { failed, rows, table, type AppResult, type AppTransaction, type SqlClient } from './sql.ts';

type NameClaim = { readonly name: AppName; readonly workspaceId: string; readonly appId: AppId };

/**
 * Claims a public name on the platform before the workspace records it. A name held by another app, or retired by
 * any app, is taken; a claim this app already holds is a retry and succeeds.
 */
export async function claimAppName(platform: SqlClient, claim: NameClaim): Promise<AppResult<object>> {
  await platform.query(
    `INSERT INTO app.app_hostnames (name, workspace_id, app_id, state) VALUES ($1, $2, $3, 'claiming')
     ON CONFLICT (name) DO NOTHING`,
    [claim.name, claim.workspaceId, claim.appId],
  );
  const [row] = (
    await platform.query<{ workspace_id: string; app_id: string; state: string }>(
      'SELECT workspace_id, app_id, state FROM app.app_hostnames WHERE name = $1',
      [claim.name],
    )
  ).rows;
  if (row?.workspace_id === claim.workspaceId && row.app_id === claim.appId && row.state !== 'retired')
    return { ok: true };
  return failed('name-taken', 'Another app already uses this name');
}

/** Records the claimed name on the app and bumps the edge version when the name changes. */
export async function setAppPublicName(tx: AppTransaction, appId: AppId, name: AppName) {
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_apps')} SET public_name = $2, edge_version = edge_version + 1
     WHERE id = $1 AND kind = 'public' AND public_name IS DISTINCT FROM $2`,
    [appId, name],
  );
  const [row] = await rows<{ edge_version: string }>(
    tx,
    `SELECT edge_version FROM ${table(tx, 'tf_apps')} WHERE id = $1`,
    [appId],
  );
  return { edgeVersion: Number(row!.edge_version) };
}

/**
 * Makes a claimed name the app's current name and retires the one it replaces, which is returned so its route can be
 * removed. Run it inside one platform transaction. Running it again returns no old name.
 */
export async function promoteAppName(
  platform: SqlClient,
  claim: NameClaim,
): Promise<{ readonly retired: AppName | null }> {
  const retired = await platform.query<{ name: AppName }>(
    `UPDATE app.app_hostnames SET state = 'retired', retired_at = clock_timestamp()
     WHERE workspace_id = $1 AND app_id = $2 AND state = 'current' AND name <> $3 RETURNING name`,
    [claim.workspaceId, claim.appId, claim.name],
  );
  const promoted = await platform.query(
    `UPDATE app.app_hostnames SET state = 'current'
     WHERE name = $1 AND workspace_id = $2 AND app_id = $3 AND state IN ('claiming', 'current')`,
    [claim.name, claim.workspaceId, claim.appId],
  );
  if (promoted.rowCount !== 1) throw new Error(`App name ${claim.name} is not claimed by app ${claim.appId}`);
  return { retired: retired.rows[0]?.name ?? null };
}

const routeRowSchema = z.object({
  name: z.string(),
  kind: z.enum(['static', 'server']),
  release_id: z.uuid().nullable(),
  status: z.enum(['active', 'paused', 'disabled']).nullable(),
  edge_version: z.coerce.number().int().nonnegative(),
});

/** The `app.app_hostnames` columns that `appRouteFromRow` reads. */
export const appRouteColumns = 'name, kind, release_id, status, edge_version';

/**
 * Reads the route an `app.app_hostnames` row holds. A row with no status was never routed or has been removed, so it
 * holds no route.
 */
export function appRouteFromRow(row: unknown): AppRoute | null {
  const parsed = routeRowSchema.parse(row);
  if (parsed.status === null) return null;
  const common = { name: parsed.name, status: parsed.status, version: parsed.edge_version };
  return parsed.kind === 'server'
    ? { ...common, kind: 'server' }
    : { ...common, kind: 'static', releaseId: parsed.release_id };
}

export type CurrentAppRoute = {
  readonly workspaceId: string;
  readonly appId: AppId;
  /** Null until the app's edge state is first projected. */
  readonly route: AppRoute | null;
};

/** The app that holds a public name now and the route its edge serves, or null when no app holds the name. */
export async function readCurrentAppRoute(platform: SqlClient, name: string): Promise<CurrentAppRoute | null> {
  const [row] = (
    await platform.query<{ workspace_id: string; app_id: string }>(
      `SELECT workspace_id, app_id, ${appRouteColumns} FROM app.app_hostnames WHERE name = $1 AND state = 'current'`,
      [name],
    )
  ).rows;
  if (!row) return null;
  return { workspaceId: row.workspace_id, appId: row.app_id as AppId, route: appRouteFromRow(row) };
}
