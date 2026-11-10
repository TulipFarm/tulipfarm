export function requestSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// Gateway failures and dropped connections are usually momentary, e.g. a load balancer reusing a
// connection the API just closed. Reads are idempotent, so one quick retry hides them from people.
const transientStatuses = new Set([502, 503, 504]);
const readRetryDelayMs = 300;
// The API answers `temporarily-unavailable` when storage was briefly contended and the request changed nothing,
// so reads and writes alike are sent again a few times after the delay it asks for.
const contentionRetries = 3;

function waitForRetry(signal: AbortSignal, delayMs: number) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function contended(response: Response) {
  if (response.status !== 503) return false;
  return (
    responseError(
      await response
        .clone()
        .json()
        .catch(() => null),
      '',
    ) === 'temporarily-unavailable'
  );
}

function contentionDelayMs(response: Response) {
  const seconds = Number(response.headers.get('Retry-After'));
  const base = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 5) * 1000 : 1000;
  return base * (0.75 + Math.random() * 0.5);
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
  }
  let gatewayRetried = method !== 'GET';
  for (let contention = 0; ;) {
    let response: Response;
    try {
      response = await send();
    } catch (error) {
      if (gatewayRetried || !(error instanceof TypeError) || options.signal.aborted) throw error;
      gatewayRetried = true;
      await waitForRetry(options.signal, readRetryDelayMs);
      continue;
    }
    if (contention < contentionRetries && (await contended(response))) {
      contention++;
      await response.body?.cancel().catch(() => {});
      await waitForRetry(options.signal, contentionDelayMs(response));
      continue;
    }
    if (gatewayRetried || !transientStatuses.has(response.status)) return response;
    gatewayRetried = true;
    await response.body?.cancel().catch(() => {});
    await waitForRetry(options.signal, readRetryDelayMs);
  }
}

export async function readJson(response: Response, tolerateInvalid = false): Promise<unknown> {
  return tolerateInvalid ? response.json().catch(() => null) : response.json();
}

export function responseError(value: unknown, fallback: string) {
  return typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
    ? value.error
    : fallback;
}
