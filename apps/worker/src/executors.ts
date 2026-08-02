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
 * Composition registers each source the process owns. An unmatched Run throws, which
 * `RunDispatcher` turns into `needs_reconciliation` — a Run parked for an operator, never a silent
 * success and never a Run quietly marked failed for work this process does not understand.
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
