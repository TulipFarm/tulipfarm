import { AccessDenied, currentMember, type AuthorizationTransaction, type HumanActor } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';

export async function canAccessSlackInstallation(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  installationId: string,
  permission: 'manage' | 'use',
) {
  await currentMember(tx, actor);
  const name = permission === 'manage' ? 'tf_slack_installation_managers' : 'tf_slack_installation_grants';
  return Boolean(
    (
      await tx.client.query(
        `SELECT 1 FROM ${qualified(tx.schema, name)} g WHERE g.installation_id=$1 AND (g.membership_id=$2 OR EXISTS (SELECT 1 FROM ${qualified(tx.schema, 'tf_member_teams')} mt WHERE mt.team_id=g.team_id AND mt.membership_id=$2)) LIMIT 1`,
        [installationId, actor.membershipId],
      )
    ).rowCount,
  );
}
export async function requireSlackInstallationUse(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  installationId: string,
) {
  if (!(await canAccessSlackInstallation(tx, actor, installationId, 'use'))) throw new AccessDenied();
}
