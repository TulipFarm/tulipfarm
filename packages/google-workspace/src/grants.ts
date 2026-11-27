import { z } from 'zod';
import type { AuthorizationTransaction, HumanActor } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import type { GoogleGrantRole, GoogleGrantTarget, GoogleOwnership } from './public-contracts.ts';

export type GoogleAccess = { canUse: boolean; canManage: boolean };

export type GoogleOwnedRow = {
  id: string;
  ownership: GoogleOwnership;
  user_id: string;
  membership_id: string;
};

export function granteeKey(grant: GoogleGrantTarget): string {
  if (grant.kind === 'workspace') return 'workspace';
  return grant.kind === 'member' ? `member:${grant.membershipId}` : `team:${grant.teamId}`;
}

export async function googleGrantRoleForActor(
  tx: AuthorizationTransaction,
  integrationId: string,
  membershipId: string,
): Promise<GoogleGrantRole | null> {
  const grantsTable = qualified(tx.schema, 'tf_google_grants');
  const memberTeamsTable = qualified(tx.schema, 'tf_member_teams');
  const rows = z.array(z.object({ role: z.enum(['use', 'manage']) })).parse(
    (
      await tx.client.query(
        `SELECT g.role
           FROM ${grantsTable} g
           WHERE g.integration_id = $1
             AND (
               g.grantee = 'workspace'
               OR g.membership_id = $2
               OR EXISTS (
                 SELECT 1 FROM ${memberTeamsTable} mt
                 WHERE mt.team_id = g.team_id AND mt.membership_id = $2
               )
             )`,
        [integrationId, membershipId],
      )
    ).rows,
  );
  if (rows.some(row => row.role === 'manage')) return 'manage';
  if (rows.length > 0) return 'use';
  return null;
}

export async function googleAccountAccess(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  row: GoogleOwnedRow,
): Promise<GoogleAccess> {
  if (row.ownership === 'personal') {
    const owned = row.membership_id === actor.membershipId && row.user_id === actor.userId;
    return { canUse: owned, canManage: owned };
  }
  const role = await googleGrantRoleForActor(tx, row.id, actor.membershipId);
  return { canUse: role !== null, canManage: role === 'manage' };
}
