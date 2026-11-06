import { retryDelay } from './query/policy';

// How long admission keeps retrying a busy or unreachable API before it shows an error.
const retryBudget = 60_000;

/**
 * A failure that says nothing about the session or workspace access, such as a rate limit or a
 * dropped connection. Request errors carry the HTTP status; a session check that never got one has none.
 */
export function temporaryAdmissionError(error: unknown) {
  if (error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')) return true;
  if (!(error instanceof Error) || !('status' in error)) return false;
  const { status } = error;
  if (status === undefined) return true;
  return typeof status === 'number' && (status === 408 || status === 429 || status >= 500);
}

function pause(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', stop, { once: true });
  });
}

/** Runs an admission again after temporary failures, waiting as long as the API's Retry-After asks. */
export async function retryAdmission<T>(
  attempt: (fresh: boolean) => Promise<T>,
  signal: AbortSignal,
  budget = retryBudget,
) {
  const deadline = Date.now() + budget;
  for (let failures = 0; ; failures++) {
    try {
      return await attempt(failures === 0);
    } catch (error) {
      const delay = retryDelay(failures, error);
      if (signal.aborted || !temporaryAdmissionError(error) || Date.now() + delay > deadline) throw error;
      await pause(delay, signal);
    }
  }
}
