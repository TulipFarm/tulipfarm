import type { PersistedRun } from "@tulipfarm/storage";
import type { RunExecutor, RunOutcome } from "@tulipfarm/turn-executor";

export type { RunExecutor } from "@tulipfarm/turn-executor";

export class UnregisteredRunSourceError extends Error {
  readonly name = "UnregisteredRunSourceError";

  constructor(
    readonly source: string,
    readonly runId: string
  ) {
    super(`no executor registered for Run source "${source}" (run ${runId})`);
  }
}

/** Unmatched Run sources throw so dispatch parks them for reconciliation, never success. */
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

  async execute(run: PersistedRun, signal?: AbortSignal): Promise<RunOutcome> {
    const source = RunExecutorRegistry.sourceOf(run);
    const executor = this.executors.get(source);
    if (!executor) throw new UnregisteredRunSourceError(source, run.id);
    return executor(run, signal);
  }
}
