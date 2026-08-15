/**
 * The one method job recording needs. Narrowed to a port so packages can record job activity
 * without depending on the control plane's activity service.
 */
export interface ActivityRecorderPort {
  record(input: {
    category: string;
    action: string;
    actorId?: string | null;
    targetType?: string | null;
    targetId?: string | null;
    summary: string;
    status?: "ok" | "error";
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export interface JobRunSummary {
  summary?: string;
  metadata?: Record<string, unknown>;
}

/** Records pg-boss job activity best-effort; failures are rethrown for retry. */
export async function recordJobRun<T>(
  activity: ActivityRecorderPort | undefined,
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
