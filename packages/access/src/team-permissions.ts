import { escapeIdentifier } from 'pg';
import { z } from 'zod';
import { AccessDenied, currentMember, type AuthorizationTransaction, type HumanActor } from './index.ts';

async function teamRole(transaction: AuthorizationTransaction, actor: HumanActor, teamId: string) {
  await currentMember(transaction, actor);
  const result = await transaction.client.query(
    `SELECT role FROM ${escapeIdentifier(transaction.schema)}.tf_member_teams WHERE team_id = $1 AND membership_id = $2`,
    [z.uuid().parse(teamId), actor.membershipId],
  );
  return z
    .object({ role: z.enum(['member', 'manager']) })
    .optional()
    .parse(result.rows[0])?.role;
}

export async function canManageTeam(
  transaction: AuthorizationTransaction,
  actor: HumanActor,
  teamId: string,
): Promise<boolean> {
  return (await teamRole(transaction, actor, teamId)) === 'manager';
}

export async function requireTeamManager(transaction: AuthorizationTransaction, actor: HumanActor, teamId: string) {
  if (!(await canManageTeam(transaction, actor, teamId))) throw new AccessDenied();
}

export async function requireTeamMember(transaction: AuthorizationTransaction, actor: HumanActor, teamId: string) {
  if (!(await teamRole(transaction, actor, teamId))) throw new AccessDenied();
}
