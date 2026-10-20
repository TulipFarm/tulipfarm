import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { McpNetworkError, normalizeEndpoint, publicAddress } from './policy.ts';

export function createPublicHttpsFetch(
  dependencies = { lookup, request },
  deadline?: number,
  policy: { maximumBytes: number; redirects: 'deny' | 'manual' } = { maximumBytes: 2097152, redirects: 'deny' },
): typeof fetch {
  if (!Number.isSafeInteger(policy.maximumBytes) || policy.maximumBytes < 1 || policy.maximumBytes > 32 * 1024 * 1024)
    throw new McpNetworkError('response-limit');
  return async (input, init) => {
    const url = new URL(normalizeEndpoint(input instanceof Request ? input.url : String(input)));
    const signal = AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(60000)]);
    function beforeSend() {
      signal.throwIfAborted();
      if (deadline !== undefined && (!Number.isFinite(deadline) || Date.now() >= deadline))
        throw new McpNetworkError('network-failed');
    }
    try {
      beforeSend();
      const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
        const abort = () => reject(new McpNetworkError('network-failed'));
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
        dependencies
          .lookup(url.hostname, { all: true, verbatim: true })
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', abort));
      });
      if (
        !Array.isArray(addresses) ||
        !addresses.length ||
        addresses.length > 32 ||
        !addresses.every(item => publicAddress(item.address))
      )
        throw new McpNetworkError('address-denied');
      const selected = addresses[0];
      if (!selected) throw new McpNetworkError('address-denied');
      const headers = new Headers(init?.headers);
      headers.set('accept-encoding', 'identity');
      if (init?.body !== undefined && init.body !== null && typeof init.body !== 'string')
        throw new McpNetworkError('network-failed');
      return await new Promise<Response>((resolve, reject) => {
        beforeSend();
        const req = dependencies.request(
          url,
          {
            method: init?.method ?? 'GET',
            agent: false,
            signal,
            headers: Object.fromEntries(headers),
            maxHeaderSize: 16384,
            lookup: (_hostname, _options, callback) =>
              callback(null, [{ address: selected.address, family: selected.family }]),
          },
          response => {
            const status = response.statusCode ?? 500;
            if (status >= 300 && status < 400) {
              response.destroy();
              if (policy.redirects === 'manual')
                resolve(
                  new Response(null, {
                    status,
                    headers: response.headers.location ? { location: response.headers.location } : {},
                  }),
                );
              else reject(new McpNetworkError('redirect-denied'));
              return;
            }
            if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
              response.destroy();
              reject(new McpNetworkError('network-failed'));
              return;
            }
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(response.headers)) {
              if (value !== undefined && key !== 'set-cookie')
                responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
            }
            let bytes = 0;
            let settled = false;
            if ([204, 205, 304].includes(status)) {
              response.on('error', () => undefined);
              response.resume();
              resolve(new Response(null, { status, headers: responseHeaders }));
              return;
            }
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                response.on('data', (chunk: Buffer) => {
                  if (settled) return;
                  bytes += chunk.length;
                  if (bytes > policy.maximumBytes) {
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
                    controller.error(
                      new McpNetworkError(bytes > policy.maximumBytes ? 'response-limit' : 'network-failed'),
                    );
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
            resolve(new Response(body, { status, headers: responseHeaders }));
          },
        );
        req.on('error', () => reject(new McpNetworkError('network-failed')));
        req.end(init?.body ?? undefined);
      });
    } catch (failure) {
      throw failure instanceof McpNetworkError ? failure : new McpNetworkError('network-failed');
    }
  };
}

export const publicHttpsFetch: typeof fetch = createPublicHttpsFetch();
