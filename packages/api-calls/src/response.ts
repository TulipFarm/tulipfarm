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

/** Reads the whole body, or returns null once it passes `limit` bytes. */
async function readBody(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof McpNetworkError && error.code === 'response-limit') return null;
    throw error;
  }
  return Buffer.concat(chunks);
}

const mediaTypePattern = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
/** The type a saved body is read as: JSON, XML and text keep a type the file reader decodes as text. */
function savedType(contentType: string | null, type: Media, text: boolean) {
  const essence = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type.kind === 'json') return 'application/json';
  if (type.kind === 'text')
    return essence.startsWith('text/') && mediaTypePattern.test(essence) && essence.length <= 127
      ? essence
      : essence.endsWith('xml')
        ? 'application/xml'
        : 'text/plain';
  if (type.kind === 'unknown') return text ? 'text/plain' : 'application/octet-stream';
  return mediaTypePattern.test(essence) && essence.length <= 127 ? essence : 'application/octet-stream';
}

const unsafeCharacters =
  // oxlint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f/\\]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;
/** The `content-disposition` file name, else the last path segment, else `response`, made safe for a file name. */
export function responseFilename(url: URL, contentDisposition: string | null) {
  const declared = contentDisposition?.match(/filename\s*=\s*(?:"([^"]*)"|([^;]*))/i);
  let name = (declared?.[1] ?? declared?.[2] ?? '').trim();
  if (!name) {
    name = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
    try {
      name = decodeURIComponent(name);
    } catch {
      // A malformed escape keeps the raw segment.
    }
  }
  name = name.replace(unsafeCharacters, '').trim();
  let safe = '';
  for (const char of name) {
    if (safe.length + char.length > 200) break;
    safe += char;
  }
  return safe || 'response';
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
  /** A body to save as a file, when `files` was set; `body` is then `omitted` until it is saved. */
  file?: { name: string; mediaType: string; bytes: Uint8Array };
};

/**
 * Reads at most 64 KiB of a JSON or text body into the result. With `files`, a larger body up to 10 MiB, or a binary
 * one, is returned as `file` to be saved; without it, those are omitted. Anything that echoes a value sent with the
 * call, in the result or the saved bytes, fails with `secret-reflected` (P33).
 */
export async function readResponse(
  response: PinnedResponse,
  request: { url: URL; placements: Placement[]; sent: readonly string[]; files?: boolean },
): Promise<ReadResponse> {
  const headers = keptHeaders(response, request.url, request.placements);
  const type = media(response.headers.get('content-type'));
  const contentType = response.headers.get('content-type');
  let body: ResponseBody = { kind: 'none' };
  let text: string | undefined;
  let file: Uint8Array | undefined;
  if (response.body) {
    const encoding = response.headers.get('content-encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') {
      await response.body.cancel().catch(() => undefined);
      throw new McpNetworkError('network-failed', { detail: 'encoded-response', requestSent: true });
    }
    if (type.kind === 'binary' && !request.files) {
      await response.body.cancel().catch(() => undefined);
      body = { kind: 'omitted', reason: 'binary', bytes: declaredLength(response.headers), contentType };
    } else {
      const bytes = await readBody(
        response.body,
        request.files ? API_CALL_LIMITS.fileBytes : API_CALL_LIMITS.inlineBytes,
      );
      if (!bytes) body = { kind: 'omitted', reason: 'too-large', bytes: declaredLength(response.headers), contentType };
      else if (bytes.length) {
        const inline = bytes.length <= API_CALL_LIMITS.inlineBytes;
        const decoded = inline && type.kind !== 'binary' ? decode(bytes, type.charset) : null;
        if (decoded === null || (type.kind === 'unknown' && decoded.includes('\0'))) {
          body = { kind: 'omitted', reason: inline ? 'binary' : 'too-large', bytes: bytes.length, contentType };
          if (request.files) file = bytes;
        } else {
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
  const saved = file && request.sent.length ? Buffer.from(file) : undefined;
  if (
    containsSecret(
      [headers, text ?? '', authentication ?? null, saved?.toString('utf8') ?? '', saved?.toString('latin1') ?? ''],
      request.sent,
    )
  )
    throw new ApiCallError(
      'secret-reflected',
      'The response contained a secret sent with the call, so it was withheld. The request was sent.',
      { httpStatus: response.status },
    );
  return {
    status: response.status,
    headers,
    body,
    ...(authentication ? { authentication } : {}),
    ...(file
      ? {
          file: {
            name: responseFilename(request.url, response.headers.get('content-disposition')),
            mediaType: savedType(
              contentType,
              type,
              type.kind === 'unknown' && decode(file, null) !== null && !Buffer.from(file).includes(0),
            ),
            bytes: file,
          },
        }
      : {}),
  };
}
