import { createPublicHttpsFetch } from './public-https.ts';
import { McpNetworkError, normalizeEndpoint } from './policy.ts';

export function createPublicDownload(
  fetcher: typeof fetch = createPublicHttpsFetch(undefined, undefined, {
    maximumBytes: 32 * 1024 * 1024,
    redirects: 'manual',
  }),
) {
  return async (source: string, maximumBytes: number, signal: AbortSignal) => {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 32 * 1024 * 1024)
      throw new McpNetworkError('response-limit');
    let url = normalizeEndpoint(source);
    for (let redirects = 0; redirects <= 5; redirects++) {
      signal.throwIfAborted();
      const response = await fetcher(url, {
        signal,
        redirect: 'manual',
        headers: { accept: '*/*', 'user-agent': 'TulipFarm-Skill-Importer' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects === 5) throw new McpNetworkError('redirect-denied');
        url = normalizeEndpoint(new URL(location, url).href);
        continue;
      }
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximumBytes)) {
        await response.body?.cancel();
        throw new McpNetworkError('response-limit');
      }
      const reader = response.body?.getReader();
      const parts: Uint8Array[] = [];
      let bytes = 0;
      try {
        if (reader)
          for (;;) {
            signal.throwIfAborted();
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > maximumBytes) throw new McpNetworkError('response-limit');
            parts.push(next.value);
          }
      } finally {
        if (reader) {
          await reader.cancel();
          reader.releaseLock();
        }
      }
      return {
        url,
        status: response.status,
        mediaType: response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '',
        bytes: Buffer.concat(parts, bytes),
      };
    }
    throw new McpNetworkError('redirect-denied');
  };
}
