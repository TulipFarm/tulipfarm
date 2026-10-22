import { z } from 'zod';
import { relation, type AgentTransaction } from './store.ts';
import { attemptAccounting, settleAttempt, type MeteredUsage, type ModelContinuity } from './continuity.ts';
import type { InferenceResult } from './inference.ts';

const count = z.number().int().nonnegative();
const observationSchema = z.object({
  actualModel: z.string().nullable(),
  requestId: z.string().nullable(),
  usage: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('unknown') }),
    z.object({
      kind: z.literal('known'),
      input: count,
      output: count,
      cacheRead: count,
      cacheWrite: count,
      cacheWrite5m: count,
      cacheWrite1h: count,
    }),
  ]),
  dispatch: z.literal('not-started').optional(),
});

export async function observeTaskModel(
  tx: AgentTransaction,
  attemptId: string,
  result: InferenceResult,
  elapsed: number,
) {
  const observation = observationSchema.parse(result);
  await tx.client.query(
    `UPDATE ${relation(tx, 'tf_agent_task_model_accounting')} SET observation=CASE WHEN observation->'usage'->>'kind'='known' THEN observation ELSE $2 END,observed_milliseconds=GREATEST(observed_milliseconds,$3),pending=true WHERE attempt_id=$1 AND (observation IS NULL OR observed_milliseconds<$3 OR (observation->'usage'->>'kind'='unknown' AND $2::jsonb->'usage'->>'kind'='known'))`,
    [attemptId, observation, Math.max(0, Math.ceil(elapsed))],
  );
}

export async function settleTaskModelTime(tx: AgentTransaction, attemptId: string) {
  const row = z
    .object({
      task_id: z.uuid(),
      reserved_milliseconds: z.string(),
      observed_milliseconds: z.string(),
      settled_milliseconds: z.string().nullable(),
    })
    .parse(
      (
        await tx.client.query(
          `SELECT * FROM ${relation(tx, 'tf_agent_task_model_accounting')} WHERE attempt_id=$1 FOR UPDATE`,
          [attemptId],
        )
      ).rows[0],
    );
  await tx.client.query(
    `UPDATE ${relation(tx, 'tf_agent_tasks')} SET active_milliseconds=GREATEST(0,active_milliseconds-$2+$3) WHERE id=$1`,
    [row.task_id, row.settled_milliseconds ?? row.reserved_milliseconds, row.observed_milliseconds],
  );
  await tx.client.query(
    `UPDATE ${relation(tx, 'tf_agent_task_model_accounting')} SET settled_milliseconds=observed_milliseconds,pending=false WHERE attempt_id=$1`,
    [attemptId],
  );
}

export async function recoverableTaskModels(tx: AgentTransaction, taskId: string) {
  return z
    .array(z.object({ attempt_id: z.uuid(), observation: observationSchema }))
    .parse(
      (
        await tx.client.query(
          `SELECT c.attempt_id,c.observation FROM ${relation(tx, 'tf_agent_task_model_accounting')} c JOIN ${relation(tx, 'tf_model_attempts')} a ON a.id=c.attempt_id JOIN ${relation(tx, 'tf_model_generations')} g USING (run_id,generation) WHERE c.task_id=$1 AND c.pending AND (a.status<>'running' OR a.lease_until<=clock_timestamp() OR g.status<>'running' OR g.deadline<=clock_timestamp()) FOR UPDATE OF c`,
          [taskId],
        )
      ).rows,
    );
}

// Recovery retains accounting only. It cannot turn a lost publication into a decision.
export async function recoverTaskModelUsage(
  tx: AgentTransaction,
  model: ModelContinuity,
  taskId: string,
  onMetered?: (usage: MeteredUsage) => void,
) {
  const rows = await recoverableTaskModels(tx, taskId);
  for (const row of rows) {
    const { attempt, generation } = await attemptAccounting(tx, row.attempt_id);
    await tx.client.query(
      `UPDATE ${relation(tx, 'tf_model_attempts')} SET status='abandoned',finished_at=clock_timestamp(),outcome='{"kind":"failure","reason":"abandoned"}' WHERE id=$1 AND status='running'`,
      [attempt.id],
    );
    const { dispatch, ...attribution } = row.observation;
    await settleAttempt(
      tx,
      model,
      generation,
      attempt,
      {
        kind: 'failure',
        reason: 'timeout',
        status: null,
        retryAfterMs: null,
        ...attribution,
        ...(dispatch ? { dispatch } : {}),
      },
      onMetered,
    );
    await settleTaskModelTime(tx, attempt.id);
  }
  return rows.length > 0;
}
