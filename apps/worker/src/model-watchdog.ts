/** Wall clock for one model call. Without it a hung provider holds a Run's lease indefinitely. */

/**
 * No output at all within this window means the provider accepted the connection and stopped
 * answering. It is reset by every chunk, so a long but productive answer is never cut short.
 */
export const DEFAULT_STALL_TIMEOUT_MS = 60_000;

/**
 * Absolute ceiling for one call, matching the CLI path's existing watchdog. A provider that
 * dribbles a byte at a time would otherwise defeat the stall timer forever.
 */
export const DEFAULT_CALL_TIMEOUT_MS = 600_000;

export type WatchdogExpiry = "stalled" | "deadline";

export interface ModelCallWatchdogOptions {
  readonly stallTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  /** Drain signal. Aborting the call is the caller's prerogative and is not an expiry. */
  readonly signal?: AbortSignal;
}

/**
 * Bounds one streaming model call in wall-clock time.
 *
 * The AI SDK sets no default fetch timeout, and both production port constructions omitted the
 * optional drain signal, so an API-keyed call had no time bound of any kind. Defaulting the
 * bounds here rather than at the construction sites is deliberate: a timeout that must be passed
 * in is a timeout that will be forgotten, which is exactly what happened.
 */
export class ModelCallWatchdog {
  private readonly controller = new AbortController();
  private readonly stallTimeoutMs: number;
  private stallTimer: NodeJS.Timeout | undefined;
  private deadlineTimer: NodeJS.Timeout | undefined;
  private expiry: WatchdogExpiry | undefined;
  private closed = false;

  constructor(options: ModelCallWatchdogOptions = {}) {
    this.stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

    this.deadlineTimer = setTimeout(() => this.expire("deadline"), callTimeoutMs);
    this.deadlineTimer.unref?.();
    this.resetStall();

    if (options.signal !== undefined) {
      if (options.signal.aborted) this.controller.abort(options.signal.reason);
      else
        options.signal.addEventListener(
          "abort",
          () => this.controller.abort(options.signal?.reason),
          {
            once: true,
          }
        );
    }
  }

  /** The signal to hand the provider: fires on stall, on deadline, or on drain. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Which bound fired, or `undefined` when the call was aborted for some other reason. */
  get expired(): WatchdogExpiry | undefined {
    return this.expiry;
  }

  /** Called for every chunk received; restarts the stall window. */
  progress(): void {
    if (this.closed || this.expiry !== undefined) return;
    this.resetStall();
  }

  /** Always call this: an un-cleared timer keeps a reference to a finished call alive. */
  close(): void {
    this.closed = true;
    if (this.stallTimer !== undefined) clearTimeout(this.stallTimer);
    if (this.deadlineTimer !== undefined) clearTimeout(this.deadlineTimer);
    this.stallTimer = undefined;
    this.deadlineTimer = undefined;
  }

  /** The message an operator should see, naming which bound was crossed and its value. */
  message(): string {
    return this.expiry === "stalled"
      ? `provider sent nothing for ${this.stallTimeoutMs}ms`
      : "model call exceeded its time limit";
  }

  private resetStall(): void {
    if (this.stallTimer !== undefined) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => this.expire("stalled"), this.stallTimeoutMs);
    this.stallTimer.unref?.();
  }

  private expire(reason: WatchdogExpiry): void {
    if (this.closed || this.expiry !== undefined) return;
    this.expiry = reason;
    this.controller.abort(new Error(this.message()));
  }
}

/**
 * Wraps a stream so an abort ends *our* iteration, whether or not the producer cooperates.
 *
 * Signalling the provider is not enough on its own: the bound has to hold even when a provider,
 * transport or SDK version ignores the signal, which is precisely the failure mode a wall clock
 * exists to survive.
 */
export async function* withAbort<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal
): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]();
  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  // Nothing awaits this promise once iteration finishes normally; without this the rejection
  // would surface as an unhandled rejection and take the worker down.
  aborted.catch(() => {});

  try {
    while (true) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done === true) return;
      yield next.value;
    }
  } finally {
    await iterator.return?.().catch(() => {});
  }
}
