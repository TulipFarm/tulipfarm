import { randomUUID } from 'node:crypto';
import {
  AccessDenied,
  hasWorkflowGrant,
  lockAuthorization,
  resolveHuman,
  type AuthorizationTransaction,
} from '@tulipfarm/access';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { z } from 'zod';
import { disabledReasonSchema, idSchema, type DisabledReason } from './contracts.ts';
import type { WorkflowRuntime } from './service.ts';
import { recordRecommendationChange, recommendationsInstalled } from '@tulipfarm/workspace-storage/recommendations';

export type WorkflowTransaction = AuthorizationTransaction & { commonVersion: number };

export function workflowTransaction<T>(
  runtime: WorkflowRuntime,
  workspaceId: string,
  operation: (tx: WorkflowTransaction) => Promise<T>,
  mode: 'read' | 'write' = 'write',
) {
  return runtime.transaction(idSchema.parse(workspaceId), commonCompatibility, async tx => {
    await lockAuthorization(tx, mode);
    return operation(tx);
  });
}

export const workflowMember = resolveHuman;
const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
export type GrantDomain = 'workflow' | 'provider';
export function grantTable(domain: GrantDomain) {
  return domain === 'workflow'
    ? { name: 'tf_workflow_grants', column: 'workflow_id' }
    : { name: 'tf_workflow_provider_grants', column: 'integration_id' };
}
const granted = (
  tx: AuthorizationTransaction,
  domain: GrantDomain,
  membership: string,
  target: string,
  permission: string,
) => {
  const grants = grantTable(domain);
  return `EXISTS (SELECT 1 FROM ${table(tx, grants.name)} g JOIN ${table(tx, 'tf_memberships')} m ON m.id=${membership} AND m.removed_at IS NULL
    WHERE g.${grants.column}=${target} AND (g.permission=${permission} OR ${permission}='read') AND (g.membership_id=m.id OR EXISTS (SELECT 1 FROM ${table(tx, 'tf_member_teams')} mt WHERE mt.team_id=g.team_id AND mt.membership_id=m.id)))`;
};
export const readableWorkflow = (tx: AuthorizationTransaction, alias: string, membership: string) =>
  granted(tx, 'workflow', membership, `${alias}.id`, `'read'`);
export async function hasGrant(
  tx: AuthorizationTransaction,
  membershipId: string,
  id: string,
  permission: 'read' | 'invoke' | 'manage' | 'use',
  domain: GrantDomain = 'workflow',
) {
  return hasWorkflowGrant(tx, membershipId, idSchema.parse(id), permission, domain);
}
export async function requireGrant(
  tx: AuthorizationTransaction,
  membershipId: string,
  id: string,
  permission: 'read' | 'invoke' | 'manage' | 'use',
  domain: GrantDomain = 'workflow',
) {
  if (!(await hasGrant(tx, membershipId, id, permission, domain))) throw new AccessDenied();
}
export async function workflowSponsor(tx: AuthorizationTransaction, workflowId: string, revision?: string) {
  const row = (
    await tx.client.query(
      `SELECT sponsor_membership_id,sponsorship_id FROM ${table(tx, 'tf_workflows')} WHERE id=$1 AND sponsorship_revision=COALESCE($2::uuid,active_revision)`,
      [workflowId, revision ?? null],
    )
  ).rows[0];
  const sponsor = z.object({ sponsor_membership_id: idSchema, sponsorship_id: idSchema }).safeParse(row);
  if (!sponsor.success) throw new AccessDenied();
  return sponsor.data;
}
export async function requireSponsor(tx: AuthorizationTransaction, workflowId: string, revision?: string) {
  const sponsor = await workflowSponsor(tx, workflowId, revision);
  await requireGrant(tx, sponsor.sponsor_membership_id, workflowId, 'invoke');
  return sponsor;
}
// Every workflow transaction holds the workspace authorization lock, so clock_timestamp() orders audit rows by lock order, unlike now().
export async function auditWorkflow(
  tx: AuthorizationTransaction,
  actorId: string,
  operation: string,
  subjectId: string,
  invalidate = operation !== 'workflow.activate',
) {
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_audit_events')} (id,actor_id,operation,subject_id,created_at) VALUES ($1,$2,$3,$4,clock_timestamp())`,
    [randomUUID(), actorId, operation, subjectId],
  );
  if (
    operation === 'workflow.activate' ||
    operation === 'workflow.archive' ||
    operation === 'workflow.disable' ||
    operation.startsWith('workflow.disable.')
  ) {
    if (!(await recommendationsInstalled(tx))) return;
    const readers = z.array(z.object({ id: idSchema })).parse(
      (
        await tx.client.query(
          `SELECT recipient.id FROM ${table(tx, 'tf_memberships')} recipient JOIN ${table(tx, 'tf_workflows')} w ON w.id=$1
       WHERE recipient.removed_at IS NULL AND w.active_revision IS NOT NULL AND ${readableWorkflow(tx, 'w', 'recipient.id')} ORDER BY recipient.id`,
          [subjectId],
        )
      ).rows,
    );
    await recordRecommendationChange(tx, {
      id: randomUUID(),
      kind: 'definition',
      sourceId: subjectId,
      membershipIds: readers.map(reader => reader.id),
      invalidate,
    });
  }
}
export type AutomaticDisable = `workflow.disable.${DisabledReason}`;
// The latest activation-state change explains a disabled workflow; a later activation, disable, or sponsor change supersedes it.
export const disabledReasonColumn = (tx: AuthorizationTransaction, alias: string) =>
  `CASE WHEN NOT ${alias}.enabled AND ${alias}.active_revision IS NOT NULL THEN (SELECT CASE e.operation ${disabledReasonSchema.options.map(reason => `WHEN 'workflow.disable.${reason}' THEN '${reason}'`).join(' ')} END FROM ${table(tx, 'tf_audit_events')} e WHERE e.subject_id=${alias}.id AND (e.operation IN ('workflow.activate','workflow.sponsor') OR e.operation LIKE 'workflow.disable%') ORDER BY e.created_at DESC LIMIT 1) END AS "disabledReason"`;
// Unattended triggers stop like a manual disable: open clients see a new generation and the audit trail names the reason.
export async function disableAutomatically(
  tx: AuthorizationTransaction,
  workflowId: string,
  operation: AutomaticDisable,
) {
  const disabled = await tx.client.query(
    `UPDATE ${table(tx, 'tf_workflows')} SET enabled=false,next_run_at=NULL,generation=generation+1 WHERE id=$1 AND enabled`,
    [workflowId],
  );
  if (disabled.rowCount === 1) await auditWorkflow(tx, 'system:workflow-sweep', operation, workflowId);
}
export async function initializeManager(
  tx: AuthorizationTransaction,
  id: string,
  membershipId: string,
  domain: GrantDomain = 'workflow',
) {
  const target = grantTable(domain);
  for (const permission of domain === 'workflow' ? ['read', 'invoke', 'manage'] : ['use', 'manage']) {
    await tx.client.query(
      `INSERT INTO ${table(tx, target.name)} (${target.column},membership_id,permission) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [id, membershipId, permission],
    );
  }
}
