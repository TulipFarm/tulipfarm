import { z } from 'zod';
import { AccessDenied, currentMember, type AuthorizationTransaction, type HumanActor } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
export {
  integrationRecommendationState,
  changedIntegrationRecommendationMembers,
  recordIntegrationRecommendationChange,
  watchIntegrationRecommendations,
  type IntegrationRecommendationState,
} from './recommendations.ts';

export const managerGrantsSchema = z.strictObject({
  memberIds: z.array(z.uuid()).max(1000),
  teamIds: z.array(z.uuid()).max(1000),
});
type Managers = z.infer<typeof managerGrantsSchema>;
const domains = {
  mcp: { table: 'tf_mcp_managers', column: 'integration_id' },
  atlassian: { table: 'tf_atlassian_account_managers', column: 'account_id' },
  slack: { table: 'tf_slack_installation_managers', column: 'installation_id' },
} as const;
type Domain = keyof typeof domains;

export async function canManageIntegration(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  domain: Domain,
  id: string,
) {
  await currentMember(tx, actor);
  const target = domains[domain];
  return Boolean(
    (
      await tx.client.query(
        `SELECT 1 FROM ${qualified(tx.schema, target.table)} g WHERE g.${target.column}=$1 AND
    (g.membership_id=$2 OR EXISTS (SELECT 1 FROM ${qualified(tx.schema, 'tf_member_teams')} mt WHERE mt.team_id=g.team_id AND mt.membership_id=$2)) LIMIT 1`,
        [id, actor.membershipId],
      )
    ).rowCount,
  );
}

export async function integrationManagers(tx: AuthorizationTransaction, domain: Domain, id: string): Promise<Managers> {
  const target = domains[domain];
  const rows = z
    .array(z.object({ membership_id: z.uuid().nullable(), team_id: z.uuid().nullable() }))
    .parse(
      (
        await tx.client.query(
          `SELECT membership_id,team_id FROM ${qualified(tx.schema, target.table)} WHERE ${target.column}=$1`,
          [id],
        )
      ).rows,
    );
  return {
    memberIds: rows.flatMap(row => (row.membership_id ? [row.membership_id] : [])),
    teamIds: rows.flatMap(row => (row.team_id ? [row.team_id] : [])),
  };
}

// Members are discoverable collaborators. Teams stay private: an actor may add only
// teams they belong to, while keeping teams that already hold a grant on the target.
export async function validateIntegrationRecipients(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  grants: Managers,
  retainedTeamIds: readonly string[] = [],
) {
  for (const id of new Set(grants.memberIds))
    if (
      !(
        await tx.client.query(
          `SELECT 1 FROM ${qualified(tx.schema, 'tf_memberships')} WHERE id=$1 AND removed_at IS NULL`,
          [id],
        )
      ).rowCount
    )
      throw new AccessDenied();
  for (const id of new Set(grants.teamIds)) {
    if (retainedTeamIds.includes(id)) continue;
    if (
      !(
        await tx.client.query(
          `SELECT 1 FROM ${qualified(tx.schema, 'tf_member_teams')} WHERE team_id=$1 AND membership_id=$2`,
          [id, actor.membershipId],
        )
      ).rowCount
    )
      throw new AccessDenied();
  }
}

export async function setIntegrationManagers(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  domain: Domain,
  id: string,
  grants: Managers,
) {
  await validateIntegrationRecipients(tx, actor, grants, (await integrationManagers(tx, domain, id)).teamIds);
  const active = await tx.client.query(
    `SELECT 1 FROM ${qualified(tx.schema, 'tf_memberships')} m WHERE m.removed_at IS NULL AND
    (m.id=ANY($1::uuid[]) OR EXISTS (SELECT 1 FROM ${qualified(tx.schema, 'tf_member_teams')} mt WHERE mt.membership_id=m.id AND mt.team_id=ANY($2::uuid[]))) LIMIT 1`,
    [grants.memberIds, grants.teamIds],
  );
  if (!active.rowCount) throw new AccessDenied();
  const target = domains[domain];
  await tx.client.query(`DELETE FROM ${qualified(tx.schema, target.table)} WHERE ${target.column}=$1`, [id]);
  for (const member of new Set(grants.memberIds))
    await tx.client.query(
      `INSERT INTO ${qualified(tx.schema, target.table)} (${target.column},membership_id) VALUES ($1,$2)`,
      [id, member],
    );
  for (const team of new Set(grants.teamIds))
    await tx.client.query(
      `INSERT INTO ${qualified(tx.schema, target.table)} (${target.column},team_id) VALUES ($1,$2)`,
      [id, team],
    );
}

export type DefaultKnowledgeProduct = 'google-drive' | 'gmail' | 'slack' | 'github' | 'jira' | 'confluence';
/**
 * Records durable automatic-Knowledge intent for a new eligible enablement. `enabled` runs before the credential
 * transaction; `record` runs inside it so a crash after credential persistence cannot lose the intent.
 */
export type DefaultKnowledgeHook = {
  enabled(workspaceId: string, userId: string): Promise<boolean>;
  record(
    tx: AuthorizationTransaction,
    input: { product: DefaultKnowledgeProduct; membershipId: string; accountKey: string; accountLabel: string },
  ): Promise<{ intentId: string; created: boolean }>;
  /** Best-effort start after commit; due-work dispatch recovers anything missed. */
  started?(workspaceId: string, intentIds: string[]): void;
};
