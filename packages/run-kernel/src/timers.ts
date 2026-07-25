import type { DueWaitDecision, PersistedWait, ResolvedDueWait } from "@tulipfarm/storage";
import type { RunResumeGateway } from "./resume";

/** Narrow surface `WaitTimerSweeper` needs; `@tulipfarm/storage`'s `WaitStore` satisfies it. */
export interface WaitTimerStore {
  resolveDue(
    businessId: string,
    now: string,
    limit: number,
    decide: DueWaitDecision
  ): Promise<readonly ResolvedDueWait[]>;
}

export interface SweptWait {
  readonly wait: PersistedWait;
  readonly signalCount: number;
  /** False when the wait resolved but its Run had already left `waiting` — needs reconciliation. */
  readonly resumed: boolean;
}

export interface SweepInput {
  readonly businessId: string;
  readonly now: Date;
  readonly limit: number;
}

/**
 * Deadline resolution for a due wait. A timer fires; a bounded window closes with whatever it
 * collected; every other unsatisfied wait times out. Aggregation that could still be satisfied by
 * a signal has already been resolved by the delivery path, so a due wait here never over-counts.
 */
export function resolveDueWait(
  wait: PersistedWait,
  signalCount: number
): "satisfied" | "timed_out" {
  if (wait.kind === "timer") return "satisfied";
  if (wait.aggregation === "window" && signalCount > 0) return "satisfied";
  return "timed_out";
}

/**
 * Durable timer sweep. Resolves every wait past its deadline, consuming its one-use resume token
 * in the same transaction, then requeues the waiting Run. Resolution is guarded on `pending`, so
 * a concurrent sweeper, a duplicate delivery, or a restarted worker resumes each Run exactly once
 * — the resolved status tells the Run whether it fired or timed out.
 */
export class WaitTimerSweeper {
  constructor(
    private readonly store: WaitTimerStore,
    private readonly resume: RunResumeGateway
  ) {}

  async sweep(input: SweepInput): Promise<readonly SweptWait[]> {
    const resolved = await this.store.resolveDue(
      input.businessId,
      input.now.toISOString(),
      input.limit,
      resolveDueWait
    );

    const swept: SweptWait[] = [];
    for (const entry of resolved) {
      swept.push({
        wait: entry.wait,
        signalCount: entry.signalCount,
        resumed: await this.resume.resume(input.businessId, entry.wait.runId),
      });
    }
    return swept;
  }
}
