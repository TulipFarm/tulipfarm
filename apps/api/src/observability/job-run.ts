import type { ObservabilityService } from "./service";

/**
 * Wrap a pg-boss job handler so each run is recorded as a `job` obs_event with its wall-clock
 * duration and ok/error status (queue name in attributes). Best-effort + decoupled from the
 * activity feed's `recordJobRun` (a job can be wrapped by both). The obs write is fire-and-forget;
 * the job's own error is always re-thrown so pg-boss still sees the failure and retries.
 */
export async function recordObsJobRun<T>(
  obs: ObservabilityService | undefined,
  queue: string,
  fn: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    void obs?.record({
      type: "job",
      status: "ok",
      durationMs: Date.now() - startedAt,
      attributes: { queue },
    });
    return result;
  } catch (err) {
    void obs?.record({
      type: "job",
      status: "error",
      durationMs: Date.now() - startedAt,
      attributes: { queue, error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}
