import { AccessDenied } from '@tulipfarm/access';
import { errorAttributes, log } from '@tulipfarm/observability';
import { StorageUnavailableError, transientStorageError } from '@tulipfarm/workspace-storage/runtime';

/**
 * Keeps a reply's lease while its model calls run. Only a denial while the lease still holds, which is how a renewal
 * reports that the turn's lease is no longer this attempt's, loses it as a denial. A transient storage failure retries
 * with a short backoff. Every renewal must finish by a deadline shortly before the lease would expire; past it, the
 * lease ends with a storage timeout, so the reply can still record a retryable failure. Any other failure ends the
 * reply with that error, never as a denial. Losing the lease aborts `signal` with the error.
 */
export function keepReplyLease(input: {
  /** Renews the lease in one transaction, which must give up by `deadlineAt`. */
  renew: (deadlineAt: number) => Promise<void>;
  leaseMilliseconds: number;
  intervalMilliseconds: number;
  /** When the transaction that last renewed the lease started. Defaults to now. */
  renewedAt?: number;
  /** First retry delay after a transient failure; each retry doubles it up to `maxRetryMilliseconds`. */
  retryMilliseconds?: number;
  maxRetryMilliseconds?: number;
  /** Time before expiry by which renewal gives up, left for the reply to record its failure. */
  marginMilliseconds?: number;
  now?: () => number;
}) {
  const {
    renew,
    leaseMilliseconds,
    intervalMilliseconds,
    retryMilliseconds = 1_000,
    maxRetryMilliseconds = 5_000,
    marginMilliseconds = 5_000,
    now = Date.now,
  } = input;
  // A renewal sets the expiry from a time inside its transaction, so the transaction's start bounds it from below.
  let renewedAt = input.renewedAt ?? now();
  const controller = new AbortController();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = () => renewedAt + leaseMilliseconds - marginMilliseconds;

  const report = (error: unknown, outcome: 'retry' | 'lost', attempt: number) =>
    log('warn', 'activity', 'call_failed', {
      ...errorAttributes(error),
      operation: 'chat.lease-renewal',
      outcome,
      attempt,
    });
  const lose = (error: unknown) => {
    if (closed || controller.signal.aborted) return;
    clearTimeout(timer);
    clearTimeout(deadlineTimer);
    controller.abort(error);
  };
  let attempt = 1;
  let running = false;
  const schedule = (delay: number) => {
    if (closed || controller.signal.aborted) return;
    clearTimeout(timer);
    timer = setTimeout(() => void run(), Math.max(0, delay));
    timer.unref?.();
  };
  const timedOut = () => {
    const error = new StorageUnavailableError('wait_timeout');
    report(error, 'lost', attempt);
    lose(error);
  };
  /**
   * Stays armed from construction until the lease ends, so the lease is lost at its deadline whether a renewal is
   * running, waiting to retry, or not yet due. A renewal that moved the deadline re-arms it.
   */
  const watch = () => {
    if (closed || controller.signal.aborted) return;
    clearTimeout(deadlineTimer);
    deadlineTimer = setTimeout(
      () => {
        if (closed || controller.signal.aborted) return;
        if (now() < deadline()) return watch();
        timedOut();
      },
      Math.max(0, deadline() - now()),
    );
    deadlineTimer.unref?.();
  };

  async function run() {
    if (closed || controller.signal.aborted) return;
    const started = now();
    if (started >= deadline()) return timedOut();
    running = true;
    try {
      await renew(Math.floor(deadline()));
      running = false;
      if (closed || controller.signal.aborted) return;
      renewedAt = Math.max(renewedAt, started);
      attempt = 1;
      watch();
      schedule(renewedAt + intervalMilliseconds - now());
    } catch (error) {
      running = false;
      if (closed || controller.signal.aborted) return;
      // A denial once the lease may already have run out says only that it expired while storage was slow.
      const expired = error instanceof AccessDenied && now() >= renewedAt + leaseMilliseconds;
      const transient = expired || (!(error instanceof AccessDenied) && transientStorageError(error));
      const delay = Math.min(retryMilliseconds * 2 ** (attempt - 1), maxRetryMilliseconds);
      const retry = transient && now() + delay < deadline();
      const failure = expired ? new StorageUnavailableError('wait_timeout') : error;
      report(failure, retry ? 'retry' : 'lost', attempt);
      if (!retry) return lose(failure);
      attempt++;
      schedule(delay);
    }
  }

  // The lease may have aged before this keeper started: renew at once when it is already due, and never start the
  // reply's model work on a lease already past its deadline.
  if (now() >= deadline()) timedOut();
  else {
    watch();
    schedule(renewedAt + intervalMilliseconds - now());
  }
  return {
    /** The failure that ended the lease, or undefined while it holds. */
    get lost(): unknown {
      return controller.signal.aborted ? controller.signal.reason : undefined;
    },
    /** Aborted, with the failure as its reason, once the lease is lost. */
    signal: controller.signal,
    /** Another transaction of this reply, started at `startedAt`, renewed the lease. */
    renewed(startedAt: number) {
      if (startedAt <= renewedAt) return;
      renewedAt = startedAt;
      watch();
      if (running) return;
      attempt = 1;
      schedule(renewedAt + intervalMilliseconds - now());
    },
    /** Settles like `work`, or rejects with the lease's failure as soon as the lease is lost. */
    async guard<T>(work: Promise<T>): Promise<T> {
      const { signal } = controller;
      if (signal.aborted) {
        work.catch(() => undefined);
        throw signal.reason;
      }
      let onAbort: (() => void) | undefined;
      const lost = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      });
      // Whichever loses the race still settles later; neither may become an unhandled rejection.
      work.catch(() => undefined);
      lost.catch(() => undefined);
      try {
        return await Promise.race([work, lost]);
      } finally {
        signal.removeEventListener('abort', onAbort!);
      }
    },
    close() {
      closed = true;
      clearTimeout(timer);
      clearTimeout(deadlineTimer);
    },
  };
}
