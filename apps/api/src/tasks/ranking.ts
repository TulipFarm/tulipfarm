import type { TaskRecord } from "@tulipfarm/storage";

/**
 * Deterministic ordering: blocking tasks first (and when any exist, they suppress the rest —
 * the Companion shows only the gate until it's clear), then overdue/time-bound, then priority,
 * then creation order. No model call.
 */
export function rankTasks(tasks: readonly TaskRecord[], now: Date): TaskRecord[] {
  const blocking = tasks.filter((t) => t.blocking);
  const pool = blocking.length > 0 ? blocking : tasks;

  return [...pool].sort((a, b) => {
    const aDue = dueScore(a, now);
    const bDue = dueScore(b, now);
    if (aDue !== bDue) return aDue - bDue;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

/** Lower sorts first: past-due soonest, then upcoming soonest, then no timing at all. */
function dueScore(task: TaskRecord, now: Date): number {
  const at = task.dueAt ?? task.remindAt;
  if (!at) return Number.POSITIVE_INFINITY;
  const diff = at.getTime() - now.getTime();
  return diff <= 0 ? diff - Number.MAX_SAFE_INTEGER / 2 : diff;
}
