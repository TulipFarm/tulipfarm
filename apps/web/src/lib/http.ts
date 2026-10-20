export function requestSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function jsonResponse(
  url: string,
  options: { method?: string; body?: unknown; signal: AbortSignal; cache?: RequestCache },
) {
  return fetch(url, {
    method: options.method ?? 'GET',
    credentials: 'include',
    signal: options.signal,
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) }),
  });
}

export async function readJson(response: Response, tolerateInvalid = false): Promise<unknown> {
  return tolerateInvalid ? response.json().catch(() => null) : response.json();
}

export function responseError(value: unknown, fallback: string) {
  return typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
    ? value.error
    : fallback;
}
