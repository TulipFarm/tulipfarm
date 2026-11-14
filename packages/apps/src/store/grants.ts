import type { AppId, MembershipId } from '../ids.ts';
import { failed, rows, table, type AppResult, type AppTransaction } from './sql.ts';

export type AppRole = 'use' | 'edit';

export type AppGrantee =
  | { readonly kind: 'workspace' }
  | { readonly kind: 'member'; readonly membershipId: MembershipId }
  | { readonly kind: 'team'; readonly teamId: string };

export type AppGrant = { readonly grantee: AppGrantee; readonly role: AppRole; readonly grantedBy: MembershipId };

export function granteeKey(grantee: AppGrantee) {
  switch (grantee.kind) {
    case 'workspace':
      return 'workspace';
    case 'member':
      return `member:${grantee.membershipId}`;
    case 'team':
      return `team:${grantee.teamId}`;
  }
}

/** Gives a grantee a role, replacing any role it held. Everyone in the workspace may only be given `use`. */
export async function putAppGrant(
  tx: AppTransaction,
  input: {
    readonly appId: AppId;
    readonly grantee: AppGrantee;
    readonly role: AppRole;
    readonly grantedBy: MembershipId;
  },
): Promise<AppResult<{ readonly grant: AppGrant }>> {
  if (input.grantee.kind === 'workspace' && input.role !== 'use')
    return failed('forbidden', 'Everyone in the workspace can only be given use access');
  const key = granteeKey(input.grantee);
  await tx.client.query(`DELETE FROM ${table(tx, 'tf_app_grants')} WHERE app_id = $1 AND grantee = $2`, [
    input.appId,
    key,
  ]);
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_app_grants')} (app_id, grantee, membership_id, team_id, role, granted_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.appId,
      key,
      input.grantee.kind === 'member' ? input.grantee.membershipId : null,
      input.grantee.kind === 'team' ? input.grantee.teamId : null,
      input.role,
      input.grantedBy,
    ],
  );
  return { ok: true, grant: { grantee: input.grantee, role: input.role, grantedBy: input.grantedBy } };
}

export async function revokeAppGrant(tx: AppTransaction, appId: AppId, grantee: AppGrantee) {
  const result = await tx.client.query(`DELETE FROM ${table(tx, 'tf_app_grants')} WHERE app_id = $1 AND grantee = $2`, [
    appId,
    granteeKey(grantee),
  ]);
  return { revoked: result.rowCount === 1 };
}

type GrantRow = { membership_id: string | null; team_id: string | null; role: AppRole; granted_by: string };

export async function listAppGrants(tx: AppTransaction, appId: AppId): Promise<AppGrant[]> {
  const found = await rows<GrantRow>(
    tx,
    `SELECT membership_id, team_id, role, granted_by FROM ${table(tx, 'tf_app_grants')}
     WHERE app_id = $1 ORDER BY grantee`,
    [appId],
  );
  return found.map(row => ({
    grantee:
      row.membership_id !== null
        ? { kind: 'member', membershipId: row.membership_id as MembershipId }
        : row.team_id !== null
          ? { kind: 'team', teamId: row.team_id }
          : { kind: 'workspace' },
    role: row.role,
    grantedBy: row.granted_by as MembershipId,
  }));
}

/** The strongest role a current member holds on an app directly, through a team or through the workspace. */
export async function appRole(tx: AppTransaction, appId: AppId, membershipId: MembershipId): Promise<AppRole | null> {
  const [row] = await rows<{ role: AppRole }>(
    tx,
    `SELECT g.role FROM ${table(tx, 'tf_app_grants')} g
     JOIN ${table(tx, 'tf_memberships')} m ON m.id = $2 AND m.removed_at IS NULL
     WHERE g.app_id = $1 AND (
       g.grantee = 'workspace'
       OR g.membership_id = m.id
       OR g.team_id IN (SELECT team_id FROM ${table(tx, 'tf_member_teams')} WHERE membership_id = m.id)
     )
     ORDER BY g.role = 'edit' DESC LIMIT 1`,
    [appId, membershipId],
  );
  return row?.role ?? null;
}
