import { z } from 'zod';
import {
  canAccessAsset,
  canAssignTeam,
  canUseAgentEnrollment,
  currentMember,
  type HumanActor,
} from '@tulipfarm/access';
import { tablePermissionSchema } from '@tulipfarm/access/contracts';
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
  const adminTables =
    teams.some(team => team.name === '_admin') && (await currentMember(tx, actor)).role === 'admin'
      ? (
          await tx.client.query(`SELECT id FROM ${relation(tx, 'tf_table_catalog')} WHERE archived_at IS NULL`)
        ).rows.map(row => ({
          assetId: z.uuid().parse(row.id),
          permissions: tablePermissionSchema.options.filter(permission => permission !== 'table.create'),
        }))
      : [];
  return Promise.all(
    teams.map(async team => ({
      ...team,
      canAssign: await canAssignTeam(tx, actor, team.id),
      tableScope:
        team.name === '_admin' && adminTables.length
          ? adminTables
          : grants
              .filter(grant => grant.teamId === team.id)
              .map(({ assetId, permissions }) => ({ assetId, permissions })),
    })),
  );
}

export async function requireTableEnrollment(
  tx: AgentTransaction,
  actor: HumanActor,
  enrollment: readonly string[],
  scope: Scope,
  agentId: string,
) {
  const previousTeams = (
    await tx.client.query(`SELECT team_id FROM ${relation(tx, 'tf_agent_teams')} WHERE agent_id=$1`, [agentId])
  ).rows.map(row => z.uuid().parse(row.team_id));
  const previousLimits = scopeSchema.parse(
    (await tx.client.query(`SELECT scope FROM ${relation(tx, 'tf_agent_limits')} WHERE agent_id=$1`, [agentId])).rows[0]
      ?.scope ?? [],
  );
  const previousActivations = (
    await tx.client.query(
      `SELECT scope FROM ${relation(tx, 'tf_agent_activations')} WHERE agent_id=$1 AND revoked_at IS NULL`,
      [agentId],
    )
  ).rows.map(row => scopeSchema.parse(row.scope));
  const teams = await tableAccessTeams(tx, actor);
  const adminEnrollment = (
    await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_teams')} WHERE id=ANY($1::uuid[]) AND name='_admin'`, [
      enrollment,
    ])
  ).rowCount;
  if (adminEnrollment && (await currentMember(tx, actor)).role !== 'admin')
    throw new AgentError('agent-team-assignment-required', 403);
  if (enrollment.some(id => !previousTeams.includes(id) && !teams.some(team => team.id === id && team.canAssign)))
    throw new AgentError('agent-team-assignment-required', 403);
  for (const entry of scope)
    for (const permission of entry.permissions.filter(permission => permission.startsWith('table.row.'))) {
      const permits = (bound: Scope) =>
        bound.some(item => item.assetId === entry.assetId && item.permissions.includes(permission));
      if (permits(previousLimits) && previousActivations.some(permits)) continue;
      if (
        !(await canAccessAsset(tx, actor, entry.assetId, permission)) ||
        !(
          adminEnrollment ||
          (
            await tx.client.query(
              `SELECT 1 FROM ${relation(tx, 'tf_grants')} g JOIN ${relation(tx, 'tf_table_catalog')} c ON c.id=$2
           WHERE g.team_id=ANY($1::uuid[]) AND (g.asset_id=c.id OR g.asset_id=c.owning_team_id)
           AND g.permission=$3 AND c.archived_at IS NULL LIMIT 1`,
              [enrollment, entry.assetId, permission],
            )
          ).rowCount
        )
      )
        throw new AgentError('agent-table-access-unavailable', 403);
    }
}

export async function effectiveAgentScope(
  tx: AgentTransaction,
  actor: HumanActor,
  agentId: string,
  activation: Scope,
  invocation: Scope = activation,
  activationId?: string,
): Promise<Scope> {
  if (!invocation.length) return [];
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
        (await canUseAgentEnrollment(tx, actor, agentId, entry.assetId, permission, activationId))
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
  const missing = requested.filter(entry =>
    entry.permissions.some(
      permission =>
        permission.startsWith('table.row.') &&
        !effective.some(bound => bound.assetId === entry.assetId && bound.permissions.includes(permission)),
    ),
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
  return `The agent couldn't reach ${names.join(', ')} with every required permission. Open the agent's Access settings and update Team enrollment, or use Change teams used for access in the builder to choose a granting team, then start a new task.`;
}
