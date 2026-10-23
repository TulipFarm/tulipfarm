import { observeDependency } from '@tulipfarm/observability';
import type { ErrorClass, Platform } from './contracts.ts';
import type { FailurePhase } from './adapter.ts';

/** Only reads, `await` polls, token refresh and resumable-upload range queries are ever retried. */
export type RequestPurpose = 'read' | 'await' | 'refresh' | 'range-query' | 'mutate' | 'upload-chunk';
const retryablePurposes: ReadonlySet<RequestPurpose> = new Set(['read', 'await', 'refresh', 'range-query']);
const mutatingPurposes: ReadonlySet<RequestPurpose> = new Set(['mutate', 'upload-chunk']);
export const isMutating = (purpose: RequestPurpose) => mutatingPurposes.has(purpose);

export const platformFetchTimeouts = { defaultMs: 15_000, uploadChunkMs: 120_000 } as const;

/** What is kept about each request: never a body, header value other than the request ID, query or token. */
export type PlatformRequestRecord = {
  platform: Platform;
  purpose: RequestPurpose;
  method: string;
  host: string;
  status: number | null;
  requestId: string | null;
  durationMs: number;
  failure: PlatformFetchError['code'] | null;
};

export type PlatformFetchOptions = {
  platform: Platform;
  hosts: readonly string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
  uploadTimeoutMs?: number;
  /** Response headers that carry the platform's request ID, in order of preference. */
  requestIdHeaders?: readonly string[];
  record?: (entry: PlatformRequestRecord) => void;
  /** Tests only: allows `http:` for loopback hosts that are also in `hosts`. */
  allowLoopbackHttp?: boolean;
};

export type PlatformRequestInit = Omit<RequestInit, 'redirect'> & { purpose: RequestPurpose; timeoutMs?: number };
export type PlatformFetch = (input: string | URL, init: PlatformRequestInit) => Promise<Response>;

export class PlatformFetchError extends Error {
  readonly code: 'host-not-allowed' | 'redirect-refused' | 'timeout' | 'aborted' | 'network';
  readonly phase: FailurePhase;
  constructor(code: PlatformFetchError['code'], phase: FailurePhase, options?: { cause?: unknown }) {
    super(code, options);
    this.name = 'PlatformFetchError';
    this.code = code;
    this.phase = phase;
  }
}

const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
const requestIdPattern = /^[\x21-\x7e]{1,256}$/;
// Connection failures that happen before any request byte can reach the platform.
const unsentCodes = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
]);

function allowedUrl(input: string | URL, options: PlatformFetchOptions): URL | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!options.hosts.some(allowed => allowed.toLowerCase() === host)) return null;
  if (url.protocol === 'https:') return url;
  return url.protocol === 'http:' && options.allowLoopbackHttp && loopback.has(host) ? url : null;
}

function requestId(response: Response, headers: readonly string[]) {
  for (const header of headers) {
    const value = response.headers.get(header)?.trim();
    if (value && requestIdPattern.test(value)) return value;
  }
  return null;
}

function causeCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

function fetchFailure(error: unknown, timedOut: boolean): PlatformFetchError {
  if (error instanceof PlatformFetchError) return error;
  const name = (error as { name?: unknown } | undefined)?.name;
  if (timedOut || name === 'TimeoutError') return new PlatformFetchError('timeout', 'after-send', { cause: error });
  if (name === 'AbortError') return new PlatformFetchError('aborted', 'after-send', { cause: error });
  const cause = (error as { cause?: { message?: unknown } } | undefined)?.cause;
  if (typeof cause?.message === 'string' && /redirect/i.test(cause.message))
    return new PlatformFetchError('redirect-refused', 'after-send', { cause: error });
  const code = causeCode(error);
  return new PlatformFetchError('network', code && unsentCodes.has(code) ? 'before-send' : 'after-send', {
    cause: error,
  });
}

/**
 * Wraps `fetch` for one adapter. A host outside the allow-list is refused before
 * anything is sent, redirects are refused, and each request has a timeout.
 */
export function createPlatformFetch(options: PlatformFetchOptions): PlatformFetch {
  const fetcher = options.fetch ?? globalThis.fetch;
  const requestIdHeaders = options.requestIdHeaders ?? ['x-request-id'];
  return async (input, init) => {
    const { purpose, timeoutMs, signal, ...rest } = init;
    const method = (rest.method ?? 'GET').toUpperCase();
    const started = performance.now();
    const record = (host: string, status: number | null, id: string | null, failure: PlatformFetchError | null) =>
      options.record?.({
        platform: options.platform,
        purpose,
        method,
        host,
        status,
        requestId: id,
        durationMs: Math.round(performance.now() - started),
        failure: failure?.code ?? null,
      });
    const url = allowedUrl(input, options);
    if (!url) {
      const refused = new PlatformFetchError('host-not-allowed', 'before-send');
      record('', null, null, refused);
      throw refused;
    }
    const limit =
      timeoutMs ??
      (purpose === 'upload-chunk'
        ? (options.uploadTimeoutMs ?? platformFetchTimeouts.uploadChunkMs)
        : (options.timeoutMs ?? platformFetchTimeouts.defaultMs));
    const timeout = AbortSignal.timeout(limit);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await observeDependency(
        'social',
        isMutating(purpose) ? 'send' : 'request',
        () => fetcher(url, { ...rest, method, signal: combined, redirect: 'error' }),
        result => result.status,
      );
    } catch (error) {
      const failure = fetchFailure(error, timeout.aborted);
      record(url.hostname, null, null, failure);
      throw failure;
    }
    const id = requestId(response, requestIdHeaders);
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      const refused = new PlatformFetchError('redirect-refused', 'after-send');
      record(url.hostname, response.status, id, refused);
      throw refused;
    }
    record(url.hostname, response.status, id, null);
    return response;
  };
}

/** Reads the response's own request ID header, for receipts. */
export function platformRequestId(response: Response, headers: readonly string[] = ['x-request-id']) {
  return requestId(response, headers);
}

export type Classification = {
  class: ErrorClass;
  /** When a rate limit lifts, from the response headers. */
  resetAt: Date | null;
  /** Whether the caller may retry the same request automatically. */
  retryable: boolean;
  /** A mutating request that may have been received with no confirmed result. */
  outcomeUnknown: boolean;
};

function parseReset(value: string | null, now: Date): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    // Larger values are Unix timestamps (X's x-rate-limit-reset); smaller ones are seconds to wait.
    return new Date(seconds > 1e9 ? seconds * 1000 : now.getTime() + seconds * 1000);
  }
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : new Date(date);
}

/** The reset time from `retry-after`, `x-rate-limit-reset`, `x-ratelimit-reset` or `ratelimit-reset`. */
export function rateLimitReset(response: Response, now = new Date()): Date | null {
  for (const header of ['retry-after', 'x-rate-limit-reset', 'x-ratelimit-reset', 'ratelimit-reset']) {
    const reset = parseReset(response.headers.get(header), now);
    if (reset) return reset;
  }
  return null;
}

function errorClass(failure: Response | Error, phase: FailurePhase, mutating: boolean): ErrorClass {
  const sent = phase === 'after-send';
  if (failure instanceof Response) {
    const status = failure.status;
    if (status === 401) return 'reconnect';
    if (status === 429) return 'rate-limited';
    if (status >= 300 && status < 400) return mutating && sent ? 'unknown' : 'rejected';
    if (status === 408 || status >= 500) return mutating && sent ? 'unknown' : 'retry';
    if (status >= 400) return 'rejected';
    return 'unknown';
  }
  if (failure instanceof PlatformFetchError) {
    if (failure.code === 'host-not-allowed') return 'rejected';
    if (failure.code === 'redirect-refused') return mutating && sent ? 'unknown' : 'rejected';
    return mutating && sent ? 'unknown' : 'retry';
  }
  return 'unknown';
}

/**
 * Classifies a failed platform request. `phase` says whether the request may
 * have reached the platform; only an `after-send` failure of a mutating
 * request can leave the outcome unknown.
 */
export function classifyFailure(
  failure: Response | Error,
  context: { phase: FailurePhase; purpose: RequestPurpose; now?: Date },
): Classification {
  const mutating = isMutating(context.purpose);
  const kind = errorClass(failure, context.phase, mutating);
  return {
    class: kind,
    resetAt: kind === 'rate-limited' && failure instanceof Response ? rateLimitReset(failure, context.now) : null,
    retryable: retryablePurposes.has(context.purpose) && (kind === 'retry' || kind === 'rate-limited'),
    outcomeUnknown: mutating && context.phase === 'after-send' && kind === 'unknown',
  };
}

/** The adapter-interface form: classifies as a mutating step unless told otherwise. */
export function classify(failure: Response | Error, phase: FailurePhase, purpose: RequestPurpose = 'mutate') {
  return classifyFailure(failure, { phase, purpose }).class;
}
