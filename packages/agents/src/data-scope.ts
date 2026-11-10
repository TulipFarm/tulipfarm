import { z } from 'zod';
import { canAccessAsset, canUseAgentEnrollment, type HumanActor } from '@tulipfarm/access';
import { scopeSchema } from './contracts.ts';
import { relation, type AgentTransaction } from './store.ts';
import { AgentError } from './saved-contracts.ts';

type Scope = z.infer<typeof scopeSchema>;

/** Only the caller's own teams are candidates; team-wide table policies expand to their current tables. */
export async function tableAccessTeams(tx: AgentTransaction, actor: HumanActor) {
  const teams = z
    .array(z.object({ id: z.uuid(), name: z.string() }))
    .parse(
      (
        await tx.client.query(
          `SELECT t.id,t.name FROM ${relation(tx, 'tf_teams')} t JOIN ${relation(tx, 'tf_member_teams')} m ON m.team_id=t.id WHERE m.membership_id=$1 ORDER BY t.name,t.id`,
          [actor.membershipId],
        )
      ).rows,
    );
  const grants = z
    .array(z.object({ teamId: z.uuid(), assetId: z.uuid(), permissions: scopeSchema.element.shape.permissions }))
    .parse(
      (
        await tx.client.query(
          `SELECT g.team_id AS "teamId",c.id AS "assetId",array_agg(DISTINCT g.permission ORDER BY g.permission) AS permissions
           FROM ${relation(tx, 'tf_grants')} g JOIN ${relation(tx, 'tf_member_teams')} m ON m.team_id=g.team_id
           JOIN ${relation(tx, 'tf_table_catalog')} c ON c.id=g.asset_id OR c.owning_team_id=g.asset_id
           WHERE m.membership_id=$1 AND c.archived_at IS NULL AND g.permission LIKE 'table.row.%'
           GROUP BY g.team_id,c.id`,
          [actor.membershipId],
        )
      ).rows,
    );
  return teams.map(team => ({
    ...team,
    tableScope: grants
      .filter(grant => grant.teamId === team.id)
      .map(({ assetId, permissions }) => ({ assetId, permissions })),
  }));
}

export async function requireTableEnrollment(
  tx: AgentTransaction,
  actor: HumanActor,
  enrollment: readonly string[],
  scope: Scope,
) {
  const teams = await tableAccessTeams(tx, actor);
  if (enrollment.some(id => !teams.some(team => team.id === id)))
    throw new AgentError('agent-table-access-unavailable', 403);
  for (const entry of scope)
    for (const permission of entry.permissions.filter(permission => permission.startsWith('table.row.')))
      if (
        !(await canAccessAsset(tx, actor, entry.assetId, permission)) ||
        !teams.some(
          team =>
            enrollment.includes(team.id) &&
            team.tableScope.some(grant => grant.assetId === entry.assetId && grant.permissions.includes(permission)),
        )
      )
        throw new AgentError('agent-table-access-unavailable', 403);
}

export async function effectiveAgentScope(
  tx: AgentTransaction,
  actor: HumanActor,
  agentId: string,
  activation: Scope,
  invocation: Scope = activation,
): Promise<Scope> {
  const limits = scopeSchema.parse(
    (await tx.client.query(`SELECT scope FROM ${relation(tx, 'tf_agent_limits')} WHERE agent_id=$1`, [agentId])).rows[0]
      ?.scope ?? [],
  );
  const scope: Scope = [];
  for (const entry of invocation) {
    const permissions: Scope[number]['permissions'] = [];
    for (const permission of entry.permissions)
      if (
        activation.some(bound => bound.assetId === entry.assetId && bound.permissions.includes(permission)) &&
        limits.some(bound => bound.assetId === entry.assetId && bound.permissions.includes(permission)) &&
        (await canUseAgentEnrollment(tx, actor, agentId, entry.assetId, permission))
      ) {
        if (
          permission.startsWith('table.') &&
          permission !== 'table.create' &&
          !(
            await tx.client.query(
              `SELECT 1 FROM ${relation(tx, 'tf_table_catalog')} WHERE id=$1 AND archived_at IS NULL AND applied_revision IS NOT NULL`,
              [entry.assetId],
            )
          ).rowCount
        )
          continue;
        permissions.push(permission);
      }
    if (permissions.length) scope.push({ assetId: entry.assetId, permissions });
  }
  return scope;
}

export async function unavailableTableMessage(
  tx: AgentTransaction,
  actor: HumanActor,
  requested: Scope,
  effective: Scope,
) {
  const missing = requested.filter(
    entry =>
      entry.permissions.includes('table.row.read') &&
      !effective.some(bound => bound.assetId === entry.assetId && bound.permissions.includes('table.row.read')),
  );
  if (!missing.length) return null;
  const names: string[] = [];
  for (const entry of missing) {
    const name =
      (await canAccessAsset(tx, actor, entry.assetId, 'table.row.read')) &&
      (
        await tx.client.query(`SELECT display_name FROM ${relation(tx, 'tf_table_catalog')} WHERE id=$1`, [
          entry.assetId,
        ])
      ).rows[0]?.display_name;
    names.push(typeof name === 'string' ? name : 'a selected table');
  }
  return `The agent couldn't reach ${names.join(', ')}. Open the agent's data settings, choose Add table access and a team that grants it, then start a new task.`;
}
