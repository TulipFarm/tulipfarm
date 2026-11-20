import { z } from 'zod';
import { canAccessAsset, type HumanActor } from '@tulipfarm/access';
import { agentDefinitionSchema, scopeSchema, type Scope } from './contracts.ts';
import { withKnowledgeRetrieveGrant } from './knowledge-tool-contracts.ts';
import { taskReadTools } from './model.ts';
import { readOnlyCall } from './tools.ts';
import { relation, type AgentTransaction } from './store.ts';
import { resolveProcedures } from './workspace-skills.ts';

export { requireAgentPermission, withHuman } from './saved-policy.ts';
export { relation };

/**
 * A saved agent as an eval run sees it: its current definition and revision, its skills resolved for `actor`, and its
 * permission limit narrowed to what `actor` can access, as if `actor` were chatting with it.
 */
export async function savedAgentForEval(tx: AgentTransaction, actor: HumanActor, agentId: string) {
  const row = z
    .object({ definitionRevision: z.string(), definition: agentDefinitionSchema, limits: scopeSchema.nullable() })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT s.definition_revision AS "definitionRevision", d.definition, l.scope AS limits
           FROM ${relation(tx, 'tf_agents')} a
           JOIN ${relation(tx, 'tf_agent_saved_revisions')} s ON s.agent_id = a.id AND s.soul_revision = a.saved_revision
           JOIN ${relation(tx, 'tf_agent_definitions')} d ON d.agent_id = s.agent_id AND d.revision = s.definition_revision
           LEFT JOIN ${relation(tx, 'tf_agent_limits')} l ON l.agent_id = a.id
           WHERE a.id = $1 AND a.deleted_at IS NULL`,
          [agentId],
        )
      ).rows[0],
    );
  if (!row) return null;
  const scope: Scope = [];
  for (const entry of row.limits ?? []) {
    const permissions: Scope[number]['permissions'] = [];
    for (const permission of entry.permissions)
      if (await canAccessAsset(tx, actor, entry.assetId, permission)) permissions.push(permission);
    if (permissions.length) scope.push({ assetId: entry.assetId, permissions });
  }
  const procedures = await resolveProcedures(tx, row.definition.skills, actor);
  return { definitionRevision: row.definitionRevision, definition: row.definition, scope, procedures };
}

/** The current definition revision of a saved agent, or null when it is deleted. */
export async function savedAgentRevision(tx: AgentTransaction, agentId: string) {
  const row = (
    await tx.client.query(
      `SELECT s.definition_revision FROM ${relation(tx, 'tf_agents')} a JOIN ${relation(tx, 'tf_agent_saved_revisions')} s ON s.agent_id = a.id AND s.soul_revision = a.saved_revision WHERE a.id = $1 AND a.deleted_at IS NULL`,
      [agentId],
    )
  ).rows[0];
  return row ? z.string().parse(row.definition_revision) : null;
}

/**
 * Whether an eval run may read `call` live for this agent: the same read tools a private task offers it, and, for a
 * table, only a table inside its narrowed permission limit.
 */
export function evalReadAdmitted(
  definition: z.infer<typeof agentDefinitionSchema>,
  scope: Scope,
  call: { tool: string; [key: string]: unknown },
) {
  const offered =
    readOnlyCall(call) &&
    taskReadTools.has(call.tool) &&
    !call.tool.startsWith('mcp.') &&
    (withKnowledgeRetrieveGrant(definition.tools).includes(call.tool as never) ||
      (call.tool === 'skills.read' && (definition.skills?.length ?? 0) > 0));
  if (!offered) return false;
  const tableId = typeof call.tableId === 'string' ? call.tableId : null;
  return tableId === null || scope.some(entry => entry.assetId === tableId);
}
