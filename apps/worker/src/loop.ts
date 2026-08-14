/** Cap on the backoff a failing loop reaches, so a recovered dependency is picked up promptly. */
export const MAX_BACKOFF_MS = 30_000;

export interface LoopLogger {
  error(message: string, error: unknown): void;
}

export interface RunLoopOptions {
  /** Identifies the loop in logs; also what the drain reports when a tick is still in flight. */
  readonly name: string;
  readonly intervalMs: number;
  /** One unit of work. Must return promptly after `signal` aborts. */
  readonly tick: (signal: AbortSignal) => Promise<void>;
  readonly signal: AbortSignal;
  readonly logger: LoopLogger;
  /** Injected in tests so backoff is asserted without real time passing. */
  readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly maxBackoffMs?: number;
}

export function defaultWait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/** Exponential backoff with jitter, so restarted fleets do not retry in lockstep. */
export function backoffDelay(
  attempt: number,
  intervalMs: number,
  maxBackoffMs: number,
  random: () => number = Math.random
): number {
  const exponential = Math.min(intervalMs * 2 ** attempt, maxBackoffMs);
  return Math.round(exponential * (0.5 + random() * 0.5));
}

/** Retry failed ticks with backoff; resolve only after the in-flight tick drains. */
export async function runLoop(options: RunLoopOptions): Promise<void> {
  const wait = options.wait ?? defaultWait;
  const maxBackoffMs = options.maxBackoffMs ?? MAX_BACKOFF_MS;
  let failures = 0;

  while (!options.signal.aborted) {
    try {
      await options.tick(options.signal);
      failures = 0;
    } catch (error) {
      options.logger.error(`worker loop "${options.name}" tick failed`, error);
      failures += 1;
    }
    if (options.signal.aborted) return;
    const delay =
      failures === 0
        ? options.intervalMs
        : backoffDelay(failures - 1, options.intervalMs, maxBackoffMs);
    await wait(delay, options.signal);
  }
}
