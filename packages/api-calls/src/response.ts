import { authHint, containsSecret, redactUrl, type AuthHint, type Placement } from '@tulipfarm/secrets';
import { McpNetworkError, type PinnedResponse } from '@tulipfarm/workspace-mcp-transport';
import { API_CALL_LIMITS, ApiCallError, type ResponseBody } from './contracts.ts';

const safeHeaders = new Set([
  'content-type',
  'content-length',
  'content-language',
  'content-disposition',
  'etag',
  'last-modified',
  'cache-control',
  'retry-after',
  'link',
  'request-id',
  'x-request-id',
  'x-correlation-id',
  'x-amzn-requestid',
  'x-amz-request-id',
  'x-github-request-id',
  'cf-ray',
]);
const rateLimitHeader = /^(?:x-)?rate-?limit-/;

/** The headers an agent may see (P30). `location` is kept on a redirect, resolved and without query secrets. */
export function keptHeaders(response: Pick<PinnedResponse, 'status' | 'headers'>, url: URL, placements: Placement[]) {
  const kept: Record<string, string> = {};
  for (const [name, value] of response.headers) {
    if (safeHeaders.has(name) || rateLimitHeader.test(name)) kept[name] = value;
    else if (name === 'location' && response.status >= 300 && response.status < 400 && URL.canParse(value, url))
      kept[name] = redactUrl(new URL(value, url).href, placements);
  }
  return kept;
}

type Media = { kind: 'json' | 'text' | 'binary' | 'unknown'; charset: string | null };
function media(contentType: string | null): Media {
  if (!contentType) return { kind: 'unknown', charset: null };
  const [type = '', ...parameters] = contentType.split(';').map(part => part.trim());
  const charset =
    parameters
      .find(parameter => parameter.toLowerCase().startsWith('charset='))
      ?.slice(8)
      .replace(/^"|"$/g, '') ?? null;
  const essence = type.toLowerCase();
  if (essence === 'application/json' || essence.endsWith('+json')) return { kind: 'json', charset };
  if (
    essence.startsWith('text/') ||
    essence.endsWith('+xml') ||
    ['application/xml', 'application/javascript', 'application/x-ndjson', 'application/x-www-form-urlencoded'].includes(
      essence,
    )
  )
    return { kind: 'text', charset };
  return { kind: 'binary', charset };
}

function decode(bytes: Uint8Array, charset: string | null): string | null {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset ?? 'utf-8', { fatal: true });
  } catch {
    decoder = new TextDecoder('utf-8', { fatal: true });
  }
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

async function readInline(body: ReadableStream<Uint8Array>): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > API_CALL_LIMITS.inlineBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function declaredLength(headers: Headers) {
  const value = headers.get('content-length');
  return value && /^\d{1,15}$/.test(value) ? Number(value) : null;
}

export type ReadResponse = {
  status: number;
  headers: Record<string, string>;
  body: ResponseBody;
  authentication?: AuthHint;
};

/**
 * Reads at most 64 KiB of a JSON or text body into the result. Larger and binary bodies are omitted, since response
 * files are not kept yet. Anything that echoes a value sent with the call fails with `secret-reflected` (P33).
 */
export async function readResponse(
  response: PinnedResponse,
  request: { url: URL; placements: Placement[]; sent: readonly string[] },
): Promise<ReadResponse> {
  const headers = keptHeaders(response, request.url, request.placements);
  const type = media(response.headers.get('content-type'));
  const contentType = response.headers.get('content-type');
  let body: ResponseBody = { kind: 'none' };
  let text: string | undefined;
  if (response.body) {
    const encoding = response.headers.get('content-encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') {
      await response.body.cancel().catch(() => undefined);
      throw new McpNetworkError('network-failed', { detail: 'encoded-response', requestSent: true });
    }
    if (type.kind === 'binary') {
      await response.body.cancel().catch(() => undefined);
      body = { kind: 'omitted', reason: 'binary', bytes: declaredLength(response.headers), contentType };
    } else {
      const bytes = await readInline(response.body);
      if (!bytes) body = { kind: 'omitted', reason: 'too-large', bytes: declaredLength(response.headers), contentType };
      else if (bytes.length) {
        const decoded = decode(bytes, type.charset);
        if (decoded === null || (type.kind === 'unknown' && decoded.includes('\0')))
          body = { kind: 'omitted', reason: 'binary', bytes: bytes.length, contentType };
        else {
          text = decoded;
          body = { kind: 'text', text: decoded };
          if (type.kind !== 'text')
            try {
              body = { kind: 'json', value: JSON.parse(decoded) };
            } catch {
              // An invalid JSON body is returned as text.
            }
        }
      }
    }
  }
  const all = Object.fromEntries(response.headers);
  const authentication =
    authHint({ status: response.status, headers: all, ...(text === undefined ? {} : { body: text }) }, request.sent) ??
    undefined;
  if (containsSecret([headers, text ?? '', authentication ?? null], request.sent))
    throw new ApiCallError(
      'secret-reflected',
      'The response contained a secret sent with the call, so it was withheld. The request was sent.',
      { httpStatus: response.status },
    );
  return { status: response.status, headers, body, ...(authentication ? { authentication } : {}) };
}
