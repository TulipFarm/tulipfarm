import { z } from 'zod';
import type { AuthorizationTransaction, HumanActor } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import type { BlockedReason, Origin } from './contracts.ts';

/**
 * Whether `membershipId` may still invoke the Workflow, as `workflows/src/service.ts` checks before an effect.
 * Injected so `@tulipfarm/social` need not depend on `@tulipfarm/workflows`, which will depend on it.
 */
export type WorkflowGrantCheck = (
  tx: AuthorizationTransaction,
  membershipId: string,
  workflowId: string,
) => Promise<boolean>;

export type OriginResult =
  | { sponsor: HumanActor }
  | { blocked: Extract<BlockedReason, 'origin-revoked' | 'sponsor-removed'> };

const memberSchema = z.object({ user_id: z.string() });
const taskSchema = z.object({ owner_current: z.boolean(), status: z.string(), activation_revoked: z.boolean() });
const runSchema = z.object({
  workflow_id: z.uuid(),
  membership_id: z.uuid().nullable(),
  user_id: z.string().nullable(),
  request_key: z.string(),
  status: z.string(),
  sponsorship_id: z.uuid().nullable(),
  enabled: z.boolean(),
  sponsor_membership_id: z.uuid().nullable(),
  current_sponsorship_id: z.uuid().nullable(),
});

/**
 * The origin check before every mutating step: may this variant still act, and for whom (PRODUCT 22)? The
 * sponsor is the approver for a chat or task post, and the run's sponsor or initiating member for a Workflow.
 */
export function createOriginCheck(options: { workflowGrant?: WorkflowGrantCheck } = {}) {
  async function currentMember(tx: AuthorizationTransaction, membershipId: string | null) {
    if (!membershipId) return null;
    const row = memberSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT user_id FROM ${qualified(tx.schema, 'tf_memberships')} WHERE id=$1 AND removed_at IS NULL`,
            [membershipId],
          )
        ).rows[0],
      );
    return row ? ({ kind: 'human', userId: row.user_id, membershipId } as const) : null;
  }

  return async function check(
    tx: AuthorizationTransaction,
    origin: Origin,
    decisionSponsor: string | null,
  ): Promise<OriginResult> {
    if (origin.kind === 'conversation') {
      const chat = await tx.client.query(
        `SELECT 1 FROM ${qualified(tx.schema, 'tf_conversations')} WHERE id=$1 AND deleted_at IS NULL`,
        [origin.conversationId],
      );
      if (!chat.rowCount) return { blocked: 'origin-revoked' };
      const sponsor = await currentMember(tx, decisionSponsor);
      return sponsor ? { sponsor } : { blocked: 'sponsor-removed' };
    }
    if (origin.kind === 'task') {
      // A task has no cancelled status; `failed` is how a task stops for good.
      const task = taskSchema.optional().parse(
        (
          await tx.client.query(
            `SELECT EXISTS (SELECT 1 FROM ${qualified(tx.schema, 'tf_memberships')} m
                             WHERE m.id=t.owner_membership_id AND m.removed_at IS NULL) AS owner_current,
                    t.status, a.revoked_at IS NOT NULL AS activation_revoked
               FROM ${qualified(tx.schema, 'tf_agent_tasks')} t
               JOIN ${qualified(tx.schema, 'tf_agent_activations')} a ON a.id=t.activation_id
              WHERE t.id=$1`,
            [origin.taskId],
          )
        ).rows[0],
      );
      if (!task || task.status === 'failed' || task.activation_revoked) return { blocked: 'origin-revoked' };
      const sponsor = await currentMember(tx, decisionSponsor);
      if (!sponsor || !task.owner_current) return { blocked: 'sponsor-removed' };
      return { sponsor };
    }
    const run = runSchema.optional().parse(
      (
        await tx.client.query(
          `SELECT r.workflow_id,r.membership_id,m.user_id,r.request_key,r.status,r.sponsorship_id,w.enabled,
                  w.sponsor_membership_id,w.sponsorship_id AS current_sponsorship_id
             FROM ${qualified(tx.schema, 'tf_workflow_runs')} r
             JOIN ${qualified(tx.schema, 'tf_workflows')} w ON w.id=r.workflow_id
             LEFT JOIN ${qualified(tx.schema, 'tf_memberships')} m ON m.id=r.membership_id AND m.removed_at IS NULL
            WHERE r.id=$1`,
          [origin.runId],
        )
      ).rows[0],
    );
    if (
      !run ||
      !run.enabled ||
      !['running', 'waiting'].includes(run.status) ||
      (run.sponsorship_id
        ? run.sponsorship_id !== run.current_sponsorship_id || run.membership_id !== run.sponsor_membership_id
        : !/^(manual|event):/.test(run.request_key))
    )
      return { blocked: 'origin-revoked' };
    if (!run.membership_id || run.user_id === null) return { blocked: 'sponsor-removed' };
    // Without the Workflow grant check, a Workflow post cannot act.
    if (!options.workflowGrant || !(await options.workflowGrant(tx, run.membership_id, run.workflow_id)))
      return { blocked: 'origin-revoked' };
    return { sponsor: { kind: 'human', userId: run.user_id, membershipId: run.membership_id } };
  };
}
export type OriginCheck = ReturnType<typeof createOriginCheck>;
