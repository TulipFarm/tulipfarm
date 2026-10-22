import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { relation, type AgentTransaction } from './store.ts';
import { taskTransition } from './task-telemetry.ts';

const activitySchema = z.object({
  id: z.uuid(),
  task_id: z.uuid(),
  reserved_milliseconds: z.string(),
  expires_at: z.date(),
});
export type TaskActivity = z.infer<typeof activitySchema>;

type SettlementTransaction = (operation: (tx: AgentTransaction) => Promise<boolean>) => Promise<unknown>;
type Admission = TaskActivity | TaskWork | 'legacy' | null;

class ActiveWork {
  #activity: TaskActivity | null = null;
  #started = 0;
  #owned = false;

  static async run<T>(transaction: SettlementTransaction, operation: (work: TaskWork) => Promise<T>): Promise<T> {
    const work = new ActiveWork();
    try {
      return await operation(work);
    } finally {
      if (work.#owned) await transaction(tx => work.settle(tx));
    }
  }

  async admit(admission: Admission | (() => Promise<Admission>)) {
    const admitted = typeof admission === 'function' ? await admission() : admission;
    if (admitted === null) return false;
    if (admitted === 'legacy') return true;
    this.#activity = admitted instanceof ActiveWork ? admitted.#activity : admitted;
    this.#started = performance.now();
    this.#owned = !(admitted instanceof ActiveWork);
    return true;
  }

  get reserved() {
    return this.#activity !== null;
  }
  get deadlineAt() {
    return this.#activity?.expires_at.getTime();
  }

  async live(tx: AgentTransaction, taskId?: string) {
    if (taskId !== undefined && this.#activity?.task_id !== taskId) return false;
    return this.#activity === null || taskWorkLive(tx, this.#activity);
  }

  withinAllowance() {
    return this.#activity === null || performance.now() - this.#started < Number(this.#activity.reserved_milliseconds);
  }

  async settle(tx: AgentTransaction) {
    return this.#activity !== null && settleTaskWork(tx, this.#activity, performance.now() - this.#started);
  }

  async complete(tx: AgentTransaction) {
    const live = await this.live(tx);
    await this.settle(tx);
    return live;
  }
}

export type TaskWork = ActiveWork;
// Admission resolves after commit. Borrowed batch work has a per-call clock for
// synchronous settlement, but only the batch owner performs final cleanup.
export const withTaskWork = ActiveWork.run;

// Callers hold the task lock. An expired reservation remains charged after worker loss.
export async function activeTaskWork(tx: AgentTransaction, taskId: string) {
  await tx.client.query(
    `UPDATE ${relation(tx, 'tf_agent_task_activity')} SET status='abandoned' WHERE task_id=$1 AND status='running' AND expires_at<=clock_timestamp()`,
    [taskId],
  );
  return Boolean(
    (
      await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_agent_task_activity')} WHERE task_id=$1 AND status='running'`,
        [taskId],
      )
    ).rowCount,
  );
}

export async function reserveTaskWork(tx: AgentTransaction, taskId: string, kind: 'files' | 'tool') {
  if (await activeTaskWork(tx, taskId)) return null;
  const reserved = await tx.client.query(
    `WITH remaining AS (SELECT id,(limits->>'activeMilliseconds')::bigint-active_milliseconds AS milliseconds FROM ${relation(tx, 'tf_agent_tasks')} WHERE id=$1 AND status IN ('pending','waiting-approval') AND active_milliseconds<(limits->>'activeMilliseconds')::bigint) UPDATE ${relation(tx, 'tf_agent_tasks')} t SET active_milliseconds=active_milliseconds+r.milliseconds FROM remaining r WHERE t.id=r.id RETURNING r.milliseconds::text`,
    [taskId],
  );
  if (!reserved.rowCount) {
    const changed = await tx.client.query(
      `UPDATE ${relation(tx, 'tf_agent_tasks')} SET status='paused',pause_reason='limit.activeTime' WHERE id=$1 AND status IN ('pending','waiting-approval') AND status IS DISTINCT FROM 'paused'`,
      [taskId],
    );
    taskTransition(tx, 'paused', changed.rowCount);
    return null;
  }
  const milliseconds = z.string().parse(reserved.rows[0]?.milliseconds);
  return activitySchema.parse(
    (
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_agent_task_activity')} (id,task_id,kind,reserved_milliseconds,expires_at) VALUES ($1,$2,$3,$4::bigint,clock_timestamp()+($4::bigint * interval '1 millisecond')) RETURNING *`,
        [randomUUID(), taskId, kind, milliseconds],
      )
    ).rows[0],
  );
}

export async function settleTaskWork(tx: AgentTransaction, activity: TaskActivity, elapsed: number) {
  const settled = await tx.client.query(
    `UPDATE ${relation(tx, 'tf_agent_task_activity')} SET status='settled',settled_milliseconds=$2 WHERE id=$1 AND status='running' RETURNING id`,
    [activity.id, Math.max(0, Math.ceil(elapsed))],
  );
  if (!settled.rowCount) return false;
  await tx.client.query(
    `UPDATE ${relation(tx, 'tf_agent_tasks')} SET active_milliseconds=GREATEST(0,active_milliseconds-$2+$3) WHERE id=$1`,
    [activity.task_id, activity.reserved_milliseconds, Math.max(0, Math.ceil(elapsed))],
  );
  const changed = await tx.client.query(
    `UPDATE ${relation(tx, 'tf_agent_tasks')} SET status='paused',pause_reason='limit.activeTime' WHERE id=$1 AND status IN ('pending','waiting-approval') AND status IS DISTINCT FROM 'paused' AND active_milliseconds>=(limits->>'activeMilliseconds')::bigint`,
    [activity.task_id],
  );
  taskTransition(tx, 'paused', changed.rowCount);
  return true;
}

export async function taskWorkLive(tx: AgentTransaction, activity: TaskActivity) {
  return Boolean(
    (
      await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_agent_task_activity')} WHERE id=$1 AND status='running' AND expires_at>clock_timestamp()`,
        [activity.id],
      )
    ).rowCount,
  );
}
