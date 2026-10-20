import { escapeIdentifier } from 'pg';
import { z } from 'zod';
import {
  AccessDenied,
  canAccessTable,
  currentMember,
  requireTaskInvocation,
  type AuthorizationTransaction,
  type HumanActor,
} from './index.ts';
import type { SourceDependency } from './source-dependencies.ts';

const table = (tx: AuthorizationTransaction, name: string) =>
  `${escapeIdentifier(tx.schema)}.${escapeIdentifier(name)}`;
export async function hasWorkflowGrant(
  tx: AuthorizationTransaction,
  membershipId: string,
  id: string,
  permission: 'read' | 'invoke' | 'manage' | 'use',
  domain: 'workflow' | 'provider' = 'workflow',
) {
  const relation = domain === 'workflow' ? 'tf_workflow_grants' : 'tf_workflow_provider_grants';
  const column = domain === 'workflow' ? 'workflow_id' : 'integration_id';
  return (
    (
      await tx.client.query(
        `SELECT 1 FROM ${table(tx, relation)} g JOIN ${table(tx, 'tf_memberships')} m ON m.id=$1 AND m.removed_at IS NULL
    WHERE g.${column}=$2 AND (g.permission=$3 OR $3='read') AND (g.membership_id=m.id OR EXISTS (SELECT 1 FROM ${table(tx, 'tf_member_teams')} mt WHERE mt.team_id=g.team_id AND mt.membership_id=m.id)) LIMIT 1`,
        [membershipId, z.uuid().parse(id), permission],
      )
    ).rowCount === 1
  );
}

export async function requireWorkflowProvider(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  integrationId: string,
  generation?: number,
) {
  if (!(await hasWorkflowGrant(tx, actor.membershipId, integrationId, 'use', 'provider'))) throw new AccessDenied();
  if (
    !(
      await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'tf_provider_integrations')} c JOIN ${table(tx, 'tf_memberships')} m ON m.id=c.membership_id AND m.removed_at IS NULL WHERE c.id=$1 AND c.enabled AND ($2::integer IS NULL OR c.generation=$2)`,
        [integrationId, generation ?? null],
      )
    ).rowCount
  )
    throw new AccessDenied();
}

export async function requireWorkflowSource(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  source: Extract<SourceDependency, { kind: 'workflow-definition' | 'workflow-provider' }>,
) {
  await currentMember(tx, actor);
  if (source.kind === 'workflow-provider')
    return requireWorkflowProvider(tx, actor, source.integrationId, source.generation);
  if (!(await hasWorkflowGrant(tx, actor.membershipId, source.workflowId, 'read'))) throw new AccessDenied();
  const row = (
    await tx.client.query(
      `SELECT definition FROM ${table(tx, 'tf_workflow_revisions')} WHERE workflow_id=$1 AND id=$2`,
      [source.workflowId, source.revision],
    )
  ).rows[0];
  if (!row) throw new AccessDenied();
  const target = z.object({
    kind: z.string(),
    tableId: z.uuid().optional(),
    agentId: z.uuid().optional(),
    integrationId: z.uuid().optional(),
    credential: z.object({ integrationId: z.uuid() }).optional(),
  });
  const definition = z.object({ trigger: target, steps: z.array(target) }).parse(row.definition);
  for (const item of [definition.trigger, ...definition.steps]) {
    if (item.tableId && !(await canAccessTable(tx, actor, item.tableId, 'table.row.read'))) throw new AccessDenied();
    if (item.agentId) await requireTaskInvocation(tx, actor, item.agentId);
    const integrationId = item.integrationId ?? item.credential?.integrationId;
    if (integrationId) await requireWorkflowProvider(tx, actor, integrationId);
  }
}
