import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request } from 'node:https';
import {
  McpNetworkError,
  listedPrivateHost,
  normalizeDestination,
  normalizeEndpoint,
  publicAddress,
  type DestinationAddresses,
  type McpNetworkErrorDetail,
} from './policy.ts';

export type PinnedRequestDependencies = {
  lookup: typeof lookup;
  request: typeof request;
  httpRequest?: typeof httpRequest;
};
export type PinnedRequestInit = {
  method?: string;
  headers?: HeadersInit;
  body?: string | Uint8Array | null;
  signal?: AbortSignal | null;
};
export type PinnedRequestPolicy = {
  /** Response body limit in bytes, 1 byte to 32 MiB. Defaults to 2 MiB. */
  maximumBytes?: number;
  /** `deny` rejects every 3xx response; `manual` returns it with a null body. Defaults to `deny`. */
  redirects?: 'deny' | 'manual';
  /** Covers DNS, connection, response head and body. 1 ms to 10 minutes, 60 seconds by default. */
  timeoutMs?: number;
  /** Listed private hosts may use their listed port, `http:` and non-public addresses. Defaults to `public`. */
  addresses?: DestinationAddresses;
  /** Epoch milliseconds after which no lookup or connection is started. */
  deadline?: number;
  dependencies?: PinnedRequestDependencies;
};
/**
 * The response head, available before any body byte is read. `body` is null for HEAD requests,
 * 204, 205 and 304 responses and manual redirects. Reading past `maximumBytes` destroys the socket and
 * errors the body with `response-limit`; an encoded body errors with detail `encoded-response`.
 */
export type PinnedResponse = {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
};

const maximumResponseBytes = 32 * 1024 * 1024;

export function identityEncoded(headers: Headers): boolean {
  const encoding = headers.get('content-encoding');
  return !encoding || encoding === 'identity';
}

export async function pinnedRequest(
  input: string | URL,
  init: PinnedRequestInit = {},
  policy: PinnedRequestPolicy = {},
): Promise<PinnedResponse> {
  const maximumBytes = policy.maximumBytes ?? 2097152;
  const timeoutMs = policy.timeoutMs ?? 60000;
  const redirects = policy.redirects ?? 'deny';
  const addresses = policy.addresses ?? 'public';
  const dependencies = policy.dependencies ?? { lookup, request, httpRequest };
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > maximumResponseBytes)
    throw new McpNetworkError('response-limit');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
    throw new McpNetworkError('network-failed');
  const url = normalizeDestination(String(input), addresses);
  const privateHost = listedPrivateHost(url, addresses);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), timeout]);
  let requestSent = false;
  function failure(code: 'network-failed' | 'response-limit', detail?: McpNetworkErrorDetail) {
    return new McpNetworkError(code, {
      requestSent,
      ...(detail ? { detail } : signal.aborted ? { detail: timeout.aborted ? 'timeout' : 'aborted' } : {}),
    });
  }
  function beforeSend() {
    if (signal.aborted) throw failure('network-failed');
    if (policy.deadline !== undefined && (!Number.isFinite(policy.deadline) || Date.now() >= policy.deadline))
      throw new McpNetworkError('network-failed');
  }
  try {
    beforeSend();
    const resolved = await new Promise<LookupAddress[]>((resolve, reject) => {
      const abort = () => reject(failure('network-failed'));
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      dependencies
        .lookup(url.hostname, { all: true, verbatim: true })
        .then(resolve, () => reject(failure('network-failed', 'dns-failed')))
        .finally(() => signal.removeEventListener('abort', abort));
    });
    if (
      !Array.isArray(resolved) ||
      !resolved.length ||
      resolved.length > 32 ||
      !resolved.every(item => privateHost || publicAddress(item.address))
    )
      throw new McpNetworkError('address-denied');
    const selected = resolved[0];
    if (!selected) throw new McpNetworkError('address-denied');
    const headers = new Headers(init.headers);
    headers.set('accept-encoding', 'identity');
    const method = init.method ?? 'GET';
    const send = url.protocol === 'http:' ? (dependencies.httpRequest ?? httpRequest) : dependencies.request;
    return await new Promise<PinnedResponse>((resolve, reject) => {
      beforeSend();
      const req = send(
        url,
        {
          method,
          agent: false,
          signal,
          headers: Object.fromEntries(headers),
          maxHeaderSize: 16384,
          lookup: (_hostname, _options, callback) =>
            callback(null, [{ address: selected.address, family: selected.family }]),
        },
        response => {
          requestSent = true;
          const status = response.statusCode ?? 500;
          const responseHeaders = new Headers();
          try {
            for (const [key, value] of Object.entries(response.headers)) {
              if (value !== undefined && key !== 'set-cookie')
                responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
            }
          } catch {
            response.destroy();
            reject(failure('network-failed'));
            return;
          }
          if (status >= 300 && status < 400) {
            response.destroy();
            if (redirects === 'manual') resolve({ status, headers: responseHeaders, body: null });
            else reject(new McpNetworkError('redirect-denied', { requestSent }));
            return;
          }
          if (method.toUpperCase() === 'HEAD' || [204, 205].includes(status)) {
            response.on('error', () => undefined);
            response.resume();
            resolve({ status, headers: responseHeaders, body: null });
            return;
          }
          if (!identityEncoded(responseHeaders)) {
            response.destroy();
            const refused = failure('network-failed', 'encoded-response');
            resolve({
              status,
              headers: responseHeaders,
              body: new ReadableStream({ start: controller => controller.error(refused) }),
            });
            return;
          }
          let bytes = 0;
          let settled = false;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              response.on('data', (chunk: Buffer) => {
                if (settled) return;
                bytes += chunk.length;
                if (bytes > maximumBytes) {
                  response.destroy(new McpNetworkError('response-limit'));
                  return;
                }
                controller.enqueue(new Uint8Array(chunk));
                if ((controller.desiredSize ?? 0) <= 0) response.pause();
              });
              response.on('end', () => {
                if (!settled) {
                  settled = true;
                  controller.close();
                }
              });
              response.on('error', () => {
                if (!settled) {
                  settled = true;
                  controller.error(failure(bytes > maximumBytes ? 'response-limit' : 'network-failed'));
                }
              });
            },
            pull() {
              if (!settled) response.resume();
            },
            cancel() {
              settled = true;
              response.destroy();
              req.destroy();
            },
          });
          resolve({ status, headers: responseHeaders, body });
        },
      );
      req.on('socket', socket => {
        socket.once('encrypted' in socket ? 'secureConnect' : 'connect', () => {
          requestSent = true;
        });
      });
      req.on('error', () => reject(failure('network-failed')));
      req.end(init.body ?? undefined);
    });
  } catch (error) {
    throw error instanceof McpNetworkError ? error : failure('network-failed');
  }
}

export function createPublicHttpsFetch(
  dependencies: PinnedRequestDependencies = { lookup, request },
  deadline?: number,
  policy: { maximumBytes: number; redirects: 'deny' | 'manual'; timeoutMs?: number } = {
    maximumBytes: 2097152,
    redirects: 'deny',
  },
): typeof fetch {
  if (
    !Number.isSafeInteger(policy.maximumBytes) ||
    policy.maximumBytes < 1 ||
    policy.maximumBytes > maximumResponseBytes
  )
    throw new McpNetworkError('response-limit');
  return async (input, init) => {
    const url = normalizeEndpoint(input instanceof Request ? input.url : String(input));
    try {
      const body = init?.body;
      if (body !== undefined && body !== null && typeof body !== 'string') throw new McpNetworkError('network-failed');
      const response = await pinnedRequest(
        url,
        {
          ...(init?.method ? { method: init.method } : {}),
          ...(init?.headers ? { headers: init.headers } : {}),
          ...(body ? { body } : {}),
          ...(init?.signal ? { signal: init.signal } : {}),
        },
        {
          maximumBytes: policy.maximumBytes,
          redirects: policy.redirects,
          ...(policy.timeoutMs === undefined ? {} : { timeoutMs: policy.timeoutMs }),
          dependencies,
          ...(deadline === undefined ? {} : { deadline }),
        },
      );
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        return new Response(null, { status: response.status, headers: location ? { location } : {} });
      }
      if (!identityEncoded(response.headers)) {
        await response.body?.cancel().catch(() => undefined);
        throw new McpNetworkError('network-failed');
      }
      return new Response([204, 205, 304].includes(response.status) ? null : response.body, {
        status: response.status,
        headers: response.headers,
      });
    } catch (failure) {
      throw failure instanceof McpNetworkError ? failure : new McpNetworkError('network-failed');
    }
  };
}

export const publicHttpsFetch: typeof fetch = createPublicHttpsFetch();
