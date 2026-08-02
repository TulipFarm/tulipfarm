import type { PersistedRun } from "@tulipfarm/storage";
import type { RunOutcome } from "./run-dispatcher";

/** Executes one claimed Run to a terminal outcome. Registered per Run source at composition. */
export type RunExecutor = (run: PersistedRun) => Promise<RunOutcome>;

export class UnregisteredRunSourceError extends Error {
  readonly name = "UnregisteredRunSourceError";

  constructor(
    readonly source: string,
    readonly runId: string
  ) {
    super(`no executor registered for Run source "${source}" (run ${runId})`);
  }
}

/**
 * Maps a claimed Run to the executor that owns its source.
 *
 * Deliberately empty at composition today: no Run source has a worker-side executor until PR 3
 * moves Chat/Agent execution here. An unmatched Run therefore throws, which `RunDispatcher`
 * turns into `needs_reconciliation` — a Run parked for an operator with a named cause, never a
 * silent success and never a Run quietly marked failed for a reason nobody recorded.
 */
export class RunExecutorRegistry {
  private readonly executors = new Map<string, RunExecutor>();

  register(source: string, executor: RunExecutor): void {
    if (this.executors.has(source)) {
      throw new Error(`duplicate executor registered for Run source "${source}"`);
    }
    this.executors.set(source, executor);
  }

  get size(): number {
    return this.executors.size;
  }

  /** The Run's persisted source, independent of its pinned Routine identity. */
  static sourceOf(run: PersistedRun): string {
    return run.source;
  }

  async execute(run: PersistedRun): Promise<RunOutcome> {
    const source = RunExecutorRegistry.sourceOf(run);
    const executor = this.executors.get(source);
    if (!executor) throw new UnregisteredRunSourceError(source, run.id);
    return executor(run);
  }
}
