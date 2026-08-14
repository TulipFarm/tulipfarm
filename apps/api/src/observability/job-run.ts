import type { ObservabilityService } from "./service";

/** Records best-effort job obs events; always rethrows job errors so pg-boss retries. */
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
