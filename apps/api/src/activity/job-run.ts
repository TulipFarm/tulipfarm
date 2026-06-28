import type { ActivityService } from "./service";

export interface JobRunSummary {
  summary?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Wrap a pg-boss job handler so each run is recorded in the activity feed (category 'job') with its
 * wall-clock duration and ok/error status. `summarize` derives a human summary + metadata from the
 * result on success. The activity write is best-effort (`ActivityService.record` never throws); a
 * job failure is recorded and then re-thrown so pg-boss still sees the failure and retries.
 */
export async function recordJobRun<T>(
  activity: ActivityService | undefined,
  queue: string,
  fn: () => Promise<T>,
  summarize?: (result: T) => JobRunSummary
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const extra = summarize?.(result) ?? {};
    await activity?.record({
      category: "job",
      action: "job.run",
      targetType: "job",
      targetId: queue,
      status: "ok",
      summary: extra.summary ?? `Job ${queue} ran`,
      metadata: { durationMs: Date.now() - startedAt, ...(extra.metadata ?? {}) },
    });
    return result;
  } catch (err) {
    // Fire-and-forget: the audit write must never suppress or precede the job's own error — pg-boss
    // must see the original failure (and retry on it), not anything from the activity write.
    void activity?.record({
      category: "job",
      action: "job.run",
      targetType: "job",
      targetId: queue,
      status: "error",
      summary: `Job ${queue} failed`,
      metadata: {
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}
