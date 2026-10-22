import { z } from 'zod';
import { AccessDenied, requireGitHubTask, type AuthorizationTransaction, type HumanActor } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { GitHubReadError } from './read-contracts.ts';
import { contextColumn, contextId, selectionTable, type GitHubContext } from './origin.ts';

const rowSchema = z.object({
  accountId: z.uuid().nullable(),
  generation: z.number().int().positive().nullable(),
  integrationId: z.uuid().nullable(),
  integrationGeneration: z.number().int().positive().nullable(),
  investigation: z.boolean(),
  version: z.number().int().nonnegative(),
});
export async function githubSelection(tx: AuthorizationTransaction, context: GitHubContext) {
  return rowSchema.parse(
    (
      await tx.client.query(
        `SELECT account_id AS "accountId",account_generation AS generation,integration_id AS "integrationId",integration_generation AS "integrationGeneration",investigation,version FROM ${qualified(tx.schema, selectionTable(context))} WHERE ${contextColumn(context)}=$1`,
        [contextId(context)],
      )
    ).rows[0] ?? {
      accountId: null,
      generation: null,
      integrationId: null,
      integrationGeneration: null,
      investigation: false,
      version: 0,
    },
  );
}

export async function writeGitHubSelection(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  context: GitHubContext,
  value: {
    accountId: string | null;
    generation: number | null;
    integrationId: string | null;
    integrationGeneration: number | null;
    investigation: boolean;
    expectedVersion: number;
  },
) {
  const table = (name: string) => qualified(tx.schema, name);
  const previous = await githubSelection(tx, context);
  if (previous.version !== value.expectedVersion) throw new GitHubReadError('selection-conflict');
  if (
    value.accountId &&
    !(
      await tx.client.query(
        `SELECT 1 FROM ${table('tf_github_accounts')} WHERE id=$1 AND owner_membership_id=$2 AND generation=$3 AND state='active' AND (expires_at IS NULL OR expires_at>clock_timestamp()) FOR SHARE`,
        [value.accountId, actor.membershipId, value.generation],
      )
    ).rowCount
  )
    throw new AccessDenied();
  const reset =
    previous.accountId !== null || previous.integrationId !== null || previous.investigation !== value.investigation;
  const values = [
    contextId(context),
    value.accountId,
    value.generation,
    value.integrationId,
    value.integrationGeneration,
    value.investigation,
  ];
  if (typeof context !== 'string') {
    const task = await requireGitHubTask(tx, actor, context.taskId);
    if (!['paused', 'waiting-clarification', 'failed'].includes(task.status))
      throw new GitHubReadError('selection-conflict');
    if (
      (
        await tx.client.query(
          `SELECT 1 FROM ${table('tf_agent_task_activity')} WHERE task_id=$1 AND status='running' AND expires_at>clock_timestamp() UNION ALL SELECT 1 FROM ${table('tf_model_attempts')} a JOIN ${table('tf_agent_task_runs')} b ON b.run_id=a.run_id WHERE b.task_id=$1 AND a.status='running' AND a.lease_until>clock_timestamp()`,
          [context.taskId],
        )
      ).rowCount
    )
      throw new GitHubReadError('selection-conflict');
    let generation = task.generation,
      contextStart = 0;
    if (reset && previous.version > 0) {
      generation++;
      contextStart = z
        .number()
        .parse(
          (
            await tx.client.query(
              `SELECT COALESCE(max(sequence)+1,0)::integer AS sequence FROM ${table('tf_agent_task_messages')} WHERE task_id=$1`,
              [context.taskId],
            )
          ).rows[0]?.sequence,
        );
      await tx.client.query(
        `UPDATE ${table('tf_agent_tasks')} SET generation=$2,status='waiting-clarification' WHERE id=$1`,
        [context.taskId, generation],
      );
      const message =
        value.investigation || previous.investigation
          ? 'GitHub source selection changed. Earlier context and pending approvals cannot be reused. Describe what to do with this source.'
          : 'GitHub account selection changed. Earlier context and pending approvals cannot be reused. Describe what to do with this account.';
      await tx.client.query(
        `INSERT INTO ${table('tf_agent_task_messages')} (task_id,sequence,generation,role,text,sources) VALUES ($1,$2,$3,'agent',$4,'[]')`,
        [context.taskId, contextStart, generation, message],
      );
    }
    await tx.client.query(
      `INSERT INTO ${table('tf_github_task_selection')} (task_id,account_id,account_generation,integration_id,integration_generation,investigation,task_generation,context_start,version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1) ON CONFLICT (task_id) DO UPDATE SET account_id=EXCLUDED.account_id,account_generation=EXCLUDED.account_generation,integration_id=EXCLUDED.integration_id,integration_generation=EXCLUDED.integration_generation,investigation=EXCLUDED.investigation,task_generation=EXCLUDED.task_generation,context_start=GREATEST(tf_github_task_selection.context_start,EXCLUDED.context_start),version=tf_github_task_selection.version+1`,
      [...values, generation, contextStart],
    );
  } else {
    if (
      (
        await tx.client.query(
          `SELECT 1 FROM ${table('tf_conversation_turns')} WHERE conversation_id=$1 AND status NOT IN ('completed','cancelled','blocked')`,
          [context],
        )
      ).rowCount
    )
      throw new GitHubReadError('selection-conflict');
    await tx.client.query(
      `INSERT INTO ${table('tf_github_chat_selection')} (conversation_id,account_id,account_generation,integration_id,integration_generation,investigation,version,context_start) SELECT id,$2,$3,$4,$5,$6,1,1 FROM ${table('tf_conversations')} WHERE id=$1 ON CONFLICT (conversation_id) DO UPDATE SET account_id=EXCLUDED.account_id,account_generation=EXCLUDED.account_generation,integration_id=EXCLUDED.integration_id,integration_generation=EXCLUDED.integration_generation,investigation=EXCLUDED.investigation,context_start=CASE WHEN $7 THEN (SELECT next_message_sequence FROM ${table('tf_conversations')} WHERE id=$1) ELSE tf_github_chat_selection.context_start END,version=tf_github_chat_selection.version+1`,
      [...values, reset],
    );
  }
  return githubSelection(tx, context);
}
