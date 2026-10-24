import { z } from 'zod';

export const publicWebUrlSchema = z
  .url()
  .max(2048)
  .refine(value => {
    const url = new URL(value);
    const hostname = url.hostname.replace(/\.+$/, '');
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !hostname.startsWith('[') &&
      !/^\d+(\.\d+){3}$/.test(hostname) &&
      hostname.includes('.') &&
      !/(^|\.)(internal|localhost|local|azurecontainerapps\.io)$/i.test(hostname)
    );
  });

export const webSourceSchema = z.object({
  url: publicWebUrlSchema,
  title: z.string().max(500),
  description: z.string().max(2000),
  publishedAt: z.string().max(100).nullable(),
});
export const webPageSchema = z.discriminatedUnion('status', [
  webSourceSchema.extend({ status: z.literal('read'), text: z.string().max(20000) }),
  z.object({
    status: z.literal('failed'),
    url: publicWebUrlSchema,
    error: z.literal('Page unavailable. Retry or paste the text.'),
  }),
]);
export const publicWebResultSchema = z.object({
  kind: z.literal('public-web'),
  status: z.enum(['success', 'partial', 'empty', 'failed']),
  sources: z.array(webSourceSchema).max(10),
  pages: z.array(webPageSchema).max(5),
  window: z.enum(['day', 'week', 'any']),
  widened: z.boolean(),
  retrievedAt: z.iso.datetime(),
  untrusted: z.literal(true),
  instruction: z.string().max(500).optional(),
});
export const publicWebReceiptSchema = z.object({
  status: z.enum(['running', 'success', 'partial', 'empty', 'failed']),
  urls: z.array(publicWebUrlSchema).max(15),
  failedUrls: z.array(publicWebUrlSchema).max(5),
  widened: z.boolean(),
  query: z.string().max(2000).optional(),
  sources: z
    .array(webSourceSchema.pick({ url: true, title: true }))
    .max(15)
    .optional(),
});

export function publicWebReceipt(
  tool: string,
  call: unknown,
  output: unknown,
  status = 'running',
): z.infer<typeof publicWebReceiptSchema> | null {
  if (tool !== 'web.fetch' && tool !== 'web.search') return null;
  const requested = z.object({ url: publicWebUrlSchema }).safeParse(call);
  const search = z.object({ query: publicWebReceiptSchema.shape.query.unwrap() }).safeParse(call);
  const query = tool === 'web.search' && search.success ? { query: search.data.query } : {};
  const parsed = z.object({ result: publicWebResultSchema }).safeParse(output);
  if (!parsed.success)
    return {
      status: output == null && status === 'running' ? 'running' : 'failed',
      urls: requested.success ? [requested.data.url] : [],
      failedUrls: requested.success && (output != null || status !== 'running') ? [requested.data.url] : [],
      widened: false,
      ...query,
    };
  const result = parsed.data.result;
  const titles = new Map(result.sources.map(source => [source.url, source.title.trim()]));
  for (const page of result.pages) {
    if (
      page.status === 'read' &&
      page.title.trim() &&
      (titles.has(page.url) || (requested.success && requested.data.url === page.url))
    )
      titles.set(page.url, page.title.trim());
  }
  return {
    status: result.status,
    urls: [...new Set([...(requested.success ? [requested.data.url] : []), ...titles.keys()])],
    failedUrls: result.pages.filter(page => page.status === 'failed').map(page => page.url),
    widened: result.widened,
    ...query,
    sources: [...titles].map(([url, title]) => ({ url, title })),
  };
}

/** Why a shared link was not read as a file. */
export const publicFileFailures = [
  'sign-in-required',
  'too-large',
  'unavailable',
  'timed-out',
  'not-public',
  'storage-full',
  'web-off',
] as const;
export type PublicFileFailure = (typeof publicFileFailures)[number];

/**
 * What fetching a public link produced: the bytes of a file, a web page left for `web.fetch`, or why it failed.
 * `mediaType` comes from the bytes when they are recognisable and from the declared type otherwise.
 */
export type PublicFile =
  | { kind: 'file'; url: string; bytes: Uint8Array; sha256: string; mediaType: string; filename: string }
  | { kind: 'page'; url: string }
  | { kind: 'failed'; url: string; reason: PublicFileFailure };

/** Fetches one public link; the agents package implements it and conversations receives it injected. */
export type FetchPublicFile = (url: string, signal: AbortSignal) => Promise<PublicFile>;
