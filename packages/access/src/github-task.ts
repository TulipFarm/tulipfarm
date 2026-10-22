import { escapeIdentifier } from 'pg';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  requireCurrentActor,
  requireTaskInvocation,
  type AuthorizationTransaction,
  type HumanActor,
} from './index.ts';

const table = (tx: AuthorizationTransaction, name: string) =>
  `${escapeIdentifier(tx.schema)}.${escapeIdentifier(name)}`;
export async function githubTaskContext(tx: AuthorizationTransaction, taskId: string) {
  const installed = (
    await tx.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [table(tx, 'tf_github_task_selection')])
  ).rows[0]?.installed;
  if (!installed) return { generation: 0, sequence: 0 };
  return z
    .object({ generation: z.number(), sequence: z.number() })
    .parse(
      (
        await tx.client.query(
          `SELECT task_generation AS generation,context_start AS sequence FROM ${table(tx, 'tf_github_task_selection')} WHERE task_id=$1`,
          [taskId],
        )
      ).rows[0] ?? { generation: 0, sequence: 0 },
    );
}
const taskGitHubSourceSchema = z.object({
  kind: z.literal('github-personal'),
  origin: z.literal('task'),
  taskId: z.string(),
  taskGeneration: z.number(),
});
export function withoutGitHubSourcesBefore(sources: unknown, taskId: string, generation: number) {
  return z
    .array(z.unknown())
    .parse(sources)
    .filter(source => {
      const team = z
        .object({
          kind: z.literal('github-source'),
          investigation: z.object({
            origin: z.object({ kind: z.literal('task'), taskId: z.string(), generation: z.number() }),
          }),
        })
        .safeParse(source);
      if (team.success && team.data.investigation.origin.taskId === taskId)
        return team.data.investigation.origin.generation >= generation;
      const github = taskGitHubSourceSchema.safeParse(source);
      return !github.success || github.data.taskId !== taskId || github.data.taskGeneration >= generation;
    });
}
export async function requireGitHubTask(tx: AuthorizationTransaction, actor: HumanActor, taskId: string) {
  await currentMember(tx, actor);
  await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 648291))', [`${tx.schema}:${taskId}`]);
  const task = z
    .object({ agent_id: z.uuid(), generation: z.number(), status: z.string() })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT agent_id,generation,status FROM ${table(tx, 'tf_agent_tasks')} WHERE id=$1 AND owner_user_id=$2 AND owner_membership_id=$3`,
          [taskId, actor.userId, actor.membershipId],
        )
      ).rows[0],
    );
  if (!task) throw new AccessDenied();
  await requireTaskInvocation(tx, actor, task.agent_id);
  return task;
}

export async function requireGitHubTaskExecution(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  taskId: string,
  generation: number,
  tool?: string,
) {
  const task = await requireGitHubTask(tx, actor, taskId);
  if (task.generation !== generation || !['pending', 'waiting-approval'].includes(task.status))
    throw new AccessDenied();
  if (
    (
      await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'tf_agent_task_activity')} WHERE task_id=$1 AND status='running' AND expires_at<=clock_timestamp()`,
        [taskId],
      )
    ).rowCount
  )
    throw new AccessDenied();
  const run = z
    .object({ run_id: z.uuid(), tools: z.array(z.string()) })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT b.run_id,d.definition->'tools' AS tools FROM ${table(tx, 'tf_agent_task_runs')} b JOIN ${table(tx, 'tf_agent_runs')} r ON r.id=b.run_id JOIN ${table(tx, 'tf_agent_definitions')} d ON d.agent_id=r.agent_id AND d.revision=r.definition_revision WHERE b.task_id=$1 AND b.generation=$2 AND r.kind='delegated' AND r.user_id=$3 AND r.membership_id=$4 AND r.status IN ('ready','running','waiting')`,
          [taskId, generation, actor.userId, actor.membershipId],
        )
      ).rows[0],
    );
  if (!run || (tool && !run.tools.includes(tool))) throw new AccessDenied();
  await requireCurrentActor(tx, { kind: 'agent', runId: run.run_id });
  return run.run_id;
}
