import type { TaskStore, UpsertTaskInput } from "@tulipfarm/storage";
import { TaskStoreError } from "@tulipfarm/storage";
import { evaluateTaskChecks, type TaskCheckSignals } from "./task-checks";

export interface ReconcileTasksInput {
  readonly businessId: string;
  readonly signals: TaskCheckSignals;
  readonly taskStore: TaskStore;
  readonly now: Date;
}

/**
 * One pass over every setup-gap check: upserts the ones still open, closes the ones a user
 * satisfied some other way. A `dismissed_permanently` upsert is swallowed — that is the
 * reconciler's contract with a user who told it to stop asking (`docs/plans/task-system.md`,
 * "Nag policy").
 */
export async function reconcileTasks(input: ReconcileTasksInput): Promise<void> {
  const checks = evaluateTaskChecks(input.signals);

  for (const check of checks) {
    if (check.satisfied) {
      await input.taskStore.closeByDedupeKey(input.businessId, check.dedupeKey, input.now);
      continue;
    }

    const upsert: UpsertTaskInput = {
      businessId: input.businessId,
      assigneeKind: check.assigneeKind,
      assigneeId: check.assigneeId,
      dedupeKey: check.dedupeKey,
      title: check.title,
      action: check.action,
      blocking: check.blocking,
      ...(check.detail === undefined ? {} : { detail: check.detail }),
    };

    try {
      await input.taskStore.upsertOpen(upsert, input.now);
    } catch (error) {
      if (error instanceof TaskStoreError && error.code === "dismissed_permanently") continue;
      throw error;
    }
  }
}
