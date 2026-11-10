import { escapeIdentifier } from 'pg';
import { z } from 'zod';
import { AccessDenied, currentMember, type AuthorizationTransaction, type HumanActor } from './index.ts';

async function teamMembership(transaction: AuthorizationTransaction, actor: HumanActor, teamId: string) {
  const member = await currentMember(transaction, actor);
  const result = await transaction.client.query(
    `SELECT mt.role, t.name FROM ${escapeIdentifier(transaction.schema)}.tf_member_teams mt JOIN ${escapeIdentifier(transaction.schema)}.tf_teams t ON t.id = mt.team_id WHERE mt.team_id = $1 AND mt.membership_id = $2`,
    [z.uuid().parse(teamId), actor.membershipId],
  );
  const row = z
    .object({ role: z.enum(['member', 'manager']), name: z.string() })
    .optional()
    .parse(result.rows[0]);
  return row && { role: row.role, name: row.name, workspaceRole: member.role };
}

async function teamRole(transaction: AuthorizationTransaction, actor: HumanActor, teamId: string) {
  return (await teamMembership(transaction, actor, teamId))?.role;
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

// Sharing an asset with a team needs its manager. The internal _admin team holds every admin as a plain member and
// has no manager, so admins may share with it; renaming it or changing its members still needs a manager.
export async function requireTeamAssignment(transaction: AuthorizationTransaction, actor: HumanActor, teamId: string) {
  if (!(await canAssignTeam(transaction, actor, teamId))) throw new AccessDenied();
}

export async function canAssignTeam(transaction: AuthorizationTransaction, actor: HumanActor, teamId: string) {
  const membership = await teamMembership(transaction, actor, teamId);
  return (
    !!membership &&
    (membership.role === 'manager' || (membership.name === '_admin' && membership.workspaceRole === 'admin'))
  );
}

export async function requireTeamMember(transaction: AuthorizationTransaction, actor: HumanActor, teamId: string) {
  if (!(await teamRole(transaction, actor, teamId))) throw new AccessDenied();
}
