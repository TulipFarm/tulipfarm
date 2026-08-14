import type { DueWaitDecision, PersistedWait, ResolvedDueWait } from "@tulipfarm/storage";
import type { RunResumeGateway } from "./resume";

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
  readonly resumed: boolean;
}

export interface SweepInput {
  readonly businessId: string;
  readonly now: Date;
  readonly limit: number;
}

/** Due waits fire timers, close bounded windows, or time out without over-counting aggregation. */
export function resolveDueWait(
  wait: PersistedWait,
  signalCount: number
): "satisfied" | "timed_out" {
  if (wait.kind === "timer") return "satisfied";
  if (wait.aggregation === "window" && signalCount > 0) return "satisfied";
  return "timed_out";
}

/**
 * Timer sweeps atomically resolve pending waits, consume one-use tokens, and requeue Runs exactly
 * once with fired-or-timed-out status.
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
