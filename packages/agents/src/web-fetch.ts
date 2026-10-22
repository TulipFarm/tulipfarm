import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { denyMcpEgress } from '@tulipfarm/access';
import { publicWebConfiguration } from '@tulipfarm/config/public-web';
import { publicWebResultSchema, publicWebUrlSchema, webPageSchema } from '@tulipfarm/conversations/contracts';
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

async function requirePublicUrl(input: string, signal: AbortSignal) {
  const value = publicWebUrlSchema.parse(input);
  signal.throwIfAborted();
  const addresses = await new Promise<Awaited<ReturnType<typeof resolveAddresses>>>((resolve, reject) => {
    const abort = () => reject(new Error('web-timeout'));
    signal.addEventListener('abort', abort, { once: true });
    resolveAddresses(value)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
  if (!addresses.length || !addresses.every(item => publicIPv4(item.address))) throw new Error('web-address-denied');
  return value;
}

function resolveAddresses(url: string) {
  return lookup(new URL(url).hostname, { all: true, family: 4 });
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
