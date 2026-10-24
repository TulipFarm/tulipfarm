import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Agent, request as undiciRequest, type Dispatcher } from 'undici';
import { denyMcpEgress } from '@tulipfarm/access';
import { publicWebConfiguration } from '@tulipfarm/config/public-web';
import { publicWebResultSchema, publicWebUrlSchema, webPageSchema } from '@tulipfarm/conversations/contracts';
import type { PublicFile, PublicFileFailure } from '@tulipfarm/conversations/public-web';
import { sniffMediaType } from '@tulipfarm/media';
import { z } from 'zod';

export function publicIPv4(address: string) {
  if (isIP(address) !== 4 || address === '168.63.129.16') return false;
  const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/**
 * How public links reach the network. Production resolves IPv4 with the system resolver and connects each checked hop
 * through an agent whose lookup can only return the addresses that were checked. Tests replace these two functions to
 * reach a local server; nothing in configuration can.
 */
export const publicNetwork = {
  resolve: async (hostname: string): Promise<string[]> =>
    (await lookup(hostname, { all: true, family: 4 })).map(item => item.address),
  dispatcher: (pinned: LookupFunction): Dispatcher =>
    new Agent({ allowH2: false, connect: { lookup: pinned, timeout: 10_000 } }),
};

/** Resolves a public URL's host, or throws when it has no address or any address is not public. */
async function publicAddresses(url: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const addresses = await new Promise<string[]>((resolve, reject) => {
    const abort = () => reject(new Error('web-timeout'));
    signal.addEventListener('abort', abort, { once: true });
    publicNetwork
      .resolve(new URL(url).hostname)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
  if (!addresses.length || !addresses.every(publicIPv4)) throw new Error('web-address-denied');
  return addresses;
}

async function requirePublicUrl(input: string, signal: AbortSignal) {
  const value = publicWebUrlSchema.parse(input);
  await publicAddresses(value, signal);
  return value;
}

/**
 * A DNS lookup that answers only `hostname` and only with `addresses`, so the connection goes to an address that was
 * checked even when the name would resolve differently a moment later.
 */
export function pinnedLookup(hostname: string, addresses: readonly string[]): LookupFunction {
  return (name, options, callback) => {
    if (name !== hostname) {
      callback(Object.assign(new Error('web-address-denied'), { code: 'ENOTFOUND' }), '', 4);
      return;
    }
    if (options.all)
      (callback as unknown as (error: null, value: { address: string; family: 4 }[]) => void)(
        null,
        addresses.map(address => ({ address, family: 4 })),
      );
    else callback(null, addresses[0] ?? '', 4);
  };
}

/** Bounds on one link fetch. The deadline is a property only so tests can shorten it. */
export const publicFileLimits = { maxBytes: 10 * 1024 * 1024, maxRedirects: 5, deadlineMs: 25_000 };

const pageTypes = new Set(['text/html', 'application/xhtml+xml']);
const mediaTypePattern = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

function looksLikeHtml(bytes: Uint8Array) {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 1024)).replace(/^\uFEFF/, '');
  return /^\s*(<!--[\s\S]*?-->\s*)*<(!doctype\s+html|html|head|body)\b/i.test(head);
}

/** The last path segment of a link as a safe attachment name, or `linked-file`. */
function linkFilename(url: string) {
  let segment = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
  try {
    segment = decodeURIComponent(segment);
  } catch {
    /* A malformed escape keeps the raw segment. */
  }
  const safe = [...segment]
    .filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127 && char !== '/' && char !== '\\')
    .join('')
    .trim()
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, '');
  let name = '';
  for (const char of safe) {
    if (name.length + char.length > 200) break;
    name += char;
  }
  return name || 'linked-file';
}

function declaredType(headers: Dispatcher.ResponseData['headers']) {
  const value = headers['content-type'];
  const type = (Array.isArray(value) ? value[0] : value)?.split(';')[0]?.trim().toLowerCase() ?? '';
  return mediaTypePattern.test(type) && type.length <= 127 ? type : null;
}

class LinkFailure extends Error {
  readonly reason: PublicFileFailure;
  constructor(reason: PublicFileFailure) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Fetches one public link for reading as a file. Every hop is checked as public, connected only to its checked IPv4
 * addresses and followed manually at most five times; no cookie, authorization or referrer is sent. The body is
 * streamed under a 10 MiB cap within 25 seconds and typed from its bytes: HTML is a `page` for `web.fetch`, anything
 * else is a `file`. Aborting `signal` rejects with its reason; every other failure is a named `failed` result.
 */
export async function fetchPublicFile(input: string, signal: AbortSignal): Promise<PublicFile> {
  denyMcpEgress();
  if (!publicWebConfiguration()) return { kind: 'failed', url: input, reason: 'web-off' };
  const deadline = AbortSignal.timeout(publicFileLimits.deadlineMs);
  const bounded = AbortSignal.any([signal, deadline]);
  let current = input;
  try {
    for (let hop = 0; ; hop++) {
      const parsed = publicWebUrlSchema.safeParse(current);
      if (!parsed.success) throw new LinkFailure('not-public');
      const url = parsed.data;
      const hostname = new URL(url).hostname;
      const addresses = await publicAddresses(url, bounded).catch(error => {
        if (bounded.aborted) throw error;
        throw new LinkFailure(
          error instanceof Error && error.message === 'web-address-denied' ? 'not-public' : 'unavailable',
        );
      });
      const dispatcher = publicNetwork.dispatcher(pinnedLookup(hostname, addresses));
      try {
        const response = await undiciRequest(url, {
          method: 'GET',
          dispatcher,
          signal: bounded,
          headers: { accept: '*/*', 'user-agent': 'TulipFarm-LinkReader/1' },
        });
        const location = response.headers.location;
        if (response.statusCode >= 300 && response.statusCode < 400 && location) {
          await response.body.dump().catch(() => {});
          if (hop >= publicFileLimits.maxRedirects) throw new LinkFailure('unavailable');
          current = new URL(Array.isArray(location) ? (location[0] ?? '') : location, url).href;
          continue;
        }
        if (response.statusCode === 401 || response.statusCode === 403) {
          await response.body.dump().catch(() => {});
          throw new LinkFailure('sign-in-required');
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          await response.body.dump().catch(() => {});
          throw new LinkFailure('unavailable');
        }
        const declared = declaredType(response.headers);
        const length = Number(response.headers['content-length']);
        if (Number.isFinite(length) && length > publicFileLimits.maxBytes) {
          response.body.destroy();
          throw new LinkFailure('too-large');
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let classified = false;
        for await (const chunk of response.body as AsyncIterable<Buffer>) {
          size += chunk.length;
          if (size > publicFileLimits.maxBytes) {
            response.body.destroy();
            throw new LinkFailure('too-large');
          }
          chunks.push(chunk);
          // A page is known from its first bytes; it is left for web.fetch without reading the rest.
          if (!classified && size >= 1024) {
            classified = true;
            const head = Buffer.concat(chunks);
            if (!sniffMediaType(head) && ((declared && pageTypes.has(declared)) || looksLikeHtml(head))) {
              response.body.destroy();
              return { kind: 'page', url: input };
            }
          }
        }
        const bytes = new Uint8Array(Buffer.concat(chunks));
        const sniffed = sniffMediaType(bytes);
        if (!sniffed && ((declared && pageTypes.has(declared)) || looksLikeHtml(bytes)))
          return { kind: 'page', url: input };
        if (!bytes.byteLength) throw new LinkFailure('unavailable');
        return {
          kind: 'file',
          url: input,
          bytes,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          mediaType: sniffed?.mediaType ?? declared ?? 'application/octet-stream',
          filename: linkFilename(url),
        };
      } finally {
        void dispatcher.destroy().catch(() => {});
      }
    }
  } catch (error) {
    if (error instanceof LinkFailure) return { kind: 'failed', url: input, reason: error.reason };
    if (signal.aborted) throw signal.reason;
    if (deadline.aborted) return { kind: 'failed', url: input, reason: 'timed-out' };
    return { kind: 'failed', url: input, reason: 'unavailable' };
  }
}

function boundedText(value: string, length: number) {
  const text = value
    .replaceAll('\0', '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, '\uFFFD');
  const truncated = text.slice(0, length);
  return /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated;
}

const metadata = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  publishedTime: z.string().optional(),
  publishedDate: z.string().optional(),
  statusCode: z.number().optional(),
});
const scrapeResponse = z.object({
  success: z.literal(true),
  data: z.object({ markdown: z.string().min(1), metadata }),
});
const searchResponse = z.object({
  success: z.literal(true),
  data: z.object({
    web: z
      .array(z.object({ url: z.string(), title: z.string().default(''), description: z.string().default('') }))
      .default([]),
  }),
});
type WebResult = z.infer<typeof publicWebResultSchema>;

async function request(path: string, body: object, signal: AbortSignal): Promise<unknown> {
  const config = publicWebConfiguration();
  if (!config) throw new Error('web-unavailable');
  const response = await fetch(new URL(path, config.endpoint), {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: { 'content-type': 'application/json', ...config.headers },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) throw new Error('web-unavailable');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) {
      await response.body.cancel().catch(() => {});
      throw new Error('web-response-too-large');
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readPage(url: string, signal: AbortSignal): Promise<z.infer<typeof webPageSchema>> {
  try {
    if (!process.env.FIRECRAWL_ENDPOINT) throw new Error('web-unavailable');
    await requirePublicUrl(url, signal);
    const response = scrapeResponse.parse(
      await request(
        '/v2/scrape',
        { url, formats: ['markdown'], onlyMainContent: true, parsers: [], timeout: 20000, maxAge: 0 },
        signal,
      ),
    );
    if ((response.data.metadata.statusCode ?? 200) >= 400) throw new Error('web-unavailable');
    return {
      status: 'read',
      url,
      text: boundedText(response.data.markdown, 20000),
      title: boundedText(response.data.metadata.title ?? '', 500),
      description: boundedText(response.data.metadata.description ?? '', 2000),
      publishedAt:
        boundedText(response.data.metadata.publishedTime ?? response.data.metadata.publishedDate ?? '', 100) || null,
    };
  } catch {
    return { status: 'failed', url, error: 'Page unavailable. Retry or paste the text.' };
  }
}

export async function fetchPublicText(input: string): Promise<WebResult> {
  denyMcpEgress();
  const parsed = publicWebUrlSchema.safeParse(input);
  if (!parsed.success) throw new Error('web-url-denied');
  const url = parsed.data;
  const page = await readPage(url, AbortSignal.timeout(25000));
  return {
    kind: 'public-web',
    status: page.status === 'read' ? 'success' : 'failed',
    sources:
      page.status === 'read'
        ? [{ url: page.url, title: page.title, description: page.description, publishedAt: page.publishedAt }]
        : [],
    pages: [page],
    window: 'any',
    widened: false,
    retrievedAt: new Date().toISOString(),
    untrusted: true,
    instruction:
      page.status === 'read'
        ? 'For news, include only items dated within the requested window. If sparse, search window week explicitly. Exclude older stories even if the page was updated today.'
        : 'No page content or HTTP status was obtained. Report only that the page was unavailable. Do not infer a status code or failure cause from its URL. Offer retry or pasted text.',
  };
}

export async function searchPublicWeb(input: {
  query: string;
  window: 'day' | 'week' | 'any';
  limit: number;
}): Promise<WebResult> {
  denyMcpEgress();
  const signal = AbortSignal.timeout(45000);
  let window = input.window;
  let widened = false;
  let sources: WebResult['sources'] = [];
  const search = async () => {
    const parsed = searchResponse.parse(
      await request(
        '/v2/search',
        { query: input.query, limit: input.limit, ...(window === 'any' ? {} : { tbs: window === 'day' ? 'd' : 'w' }) },
        signal,
      ),
    );
    const sources: WebResult['sources'] = [];
    for (const item of parsed.data.web.slice(0, input.limit)) {
      try {
        const url = await requirePublicUrl(item.url, signal);
        if (!sources.some(source => source.url === url))
          sources.push({
            url,
            title: boundedText(item.title, 500),
            description: boundedText(item.description, 2000),
            publishedAt: null,
          });
      } catch {
        /* Search results can contain unsupported destinations. */
      }
    }
    return sources;
  };
  try {
    sources = await search();
    if (sources.length < Math.min(3, input.limit) && window === 'day') {
      window = 'week';
      widened = true;
      const wider = await search();
      sources = [...sources, ...wider.filter(item => !sources.some(source => source.url === item.url))].slice(
        0,
        input.limit,
      );
    }
    return {
      kind: 'public-web',
      status: sources.length ? 'success' : 'empty',
      sources,
      pages: [],
      window,
      widened,
      retrievedAt: new Date().toISOString(),
      untrusted: true,
    };
  } catch {
    return {
      kind: 'public-web',
      status: sources.length ? 'partial' : 'failed',
      sources,
      pages: [],
      window,
      widened,
      retrievedAt: new Date().toISOString(),
      untrusted: true,
    };
  }
}
