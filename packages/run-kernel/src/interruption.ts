/** Control-flow signal: this worker no longer owns the Run and must leave durable state untouched. */
export class RunInterruptedError extends Error {
  constructor(readonly reason?: unknown) {
    super("Run execution was interrupted", { cause: reason });
    this.name = "RunInterruptedError";
  }
}

/** Storage fencing uses a lower-layer error type; its stable name keeps the dependency one-way. */
export function isRunInterruption(error: unknown): boolean {
  return (
    error instanceof RunInterruptedError ||
    (error instanceof Error && error.name === "StaleLoopCheckpointWriterError")
  );
}

export function assertRunActive(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new RunInterruptedError(signal.reason);
}
