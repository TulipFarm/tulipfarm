export function requestSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// Gateway failures and dropped connections are usually momentary, e.g. a load balancer reusing a
// connection the API just closed. Reads are idempotent, so one quick retry hides them from people.
const transientStatuses = new Set([502, 503, 504]);
const readRetryDelayMs = 300;

function waitForRetry(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, readRetryDelayMs);
    signal.addEventListener('abort', abort, { once: true });
  });
}

let writeHold: Promise<void> | null = null;

/**
 * While a workspace shown from disk waits for its session and membership to be confirmed, requests
 * that change data wait too, and fail if the confirmation does. Reads never wait.
 */
export function holdWrites(confirmation: Promise<void>) {
  const hold = confirmation.finally(() => {
    if (writeHold === hold) writeHold = null;
  });
  hold.catch(() => {});
  writeHold = hold;
}

export async function writesAllowed() {
  const hold = writeHold;
  if (!hold) return;
  try {
    await hold;
  } catch {
    throw new Error('Could not confirm your workspace access. Reload the page and try again.');
  }
}

export async function jsonResponse(
  url: string,
  options: { method?: string; body?: unknown; signal: AbortSignal; cache?: RequestCache },
) {
  const method = options.method ?? 'GET';
  const send = () =>
    fetch(url, {
      method,
      credentials: 'include',
      signal: options.signal,
      ...(options.cache === undefined ? {} : { cache: options.cache }),
      ...(options.body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) }),
    });
  if (method !== 'GET') {
    await writesAllowed();
    options.signal.throwIfAborted();
    return send();
  }
  try {
    const response = await send();
    if (!transientStatuses.has(response.status)) return response;
    await response.body?.cancel().catch(() => {});
  } catch (error) {
    if (!(error instanceof TypeError) || options.signal.aborted) throw error;
  }
  await waitForRetry(options.signal);
  return send();
}

export async function readJson(response: Response, tolerateInvalid = false): Promise<unknown> {
  return tolerateInvalid ? response.json().catch(() => null) : response.json();
}

export function responseError(value: unknown, fallback: string) {
  return typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
    ? value.error
    : fallback;
}
