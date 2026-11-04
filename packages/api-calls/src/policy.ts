import { headerNameSchema } from '@tulipfarm/secrets';
import { McpNetworkError, normalizeDestination } from '@tulipfarm/workspace-mcp-transport';
import { API_CALL_LIMITS, ApiCallError, type ApiRequestBody, type ApiRequestCall } from './contracts.ts';

export const API_CALL_USER_AGENT = 'TulipFarm-ApiCall/1';
const defaultAccept = 'application/json, text/*;q=0.9, */*;q=0.8';
const credentialParts = ['key', 'token', 'secret', 'password', 'passwd', 'auth', 'session', 'signature', 'credential'];

/** True for a header or query name that can only be filled by a secret placement, such as `X-Api-Key`. */
export function isCredentialName(name: string): boolean {
  const folded = name.toLowerCase().replace(/[-_.]/g, '');
  return credentialParts.some(part => folded.includes(part));
}

const credentialMessage = (name: string) =>
  `"${name}" carries a credential. Remove it and send the credential through a secret instead; use secrets.request if the chat holds none.`;

/** The URL with the agent's query pairs added, checked as secrets and workspace MCP check destinations. */
export function normalizeApiUrl(input: string, query: ApiRequestCall['query'] = []): URL {
  if (!URL.canParse(input)) throw new ApiCallError('invalid-request', 'url is not a valid absolute URL.');
  let url: URL;
  try {
    url = normalizeDestination(input, 'public');
  } catch (error) {
    if (!(error instanceof McpNetworkError)) throw error;
    throw new ApiCallError(
      'address-denied',
      'url must be https on a public host name and the default port, without user name, fragment or IP address.',
    );
  }
  if (/[{}]|%7b|%7d/i.test(url.href))
    throw new ApiCallError('invalid-request', 'url contains a template brace. Fill in every path parameter.');
  for (const name of url.searchParams.keys())
    if (isCredentialName(name)) throw new ApiCallError('credential-in-request', credentialMessage(name));
  for (const { name, value } of query) {
    if (isCredentialName(name)) throw new ApiCallError('credential-in-request', credentialMessage(name));
    url.searchParams.append(name, value);
  }
  if ([...url.searchParams.keys()].length > API_CALL_LIMITS.queryPairs)
    throw new ApiCallError('invalid-request', `query has more than ${API_CALL_LIMITS.queryPairs} parameters.`);
  if (url.href.length > API_CALL_LIMITS.urlCharacters)
    throw new ApiCallError('invalid-request', `url is longer than ${API_CALL_LIMITS.urlCharacters} characters.`);
  return url;
}

/** Lower-cased headers the agent may send, with TulipFarm's user agent and a default `accept`. */
export function requestHeaders(input: ApiRequestCall['headers'] = {}): Record<string, string> {
  const entries = Object.entries(input);
  if (entries.length > API_CALL_LIMITS.headers)
    throw new ApiCallError('invalid-request', `headers has more than ${API_CALL_LIMITS.headers} entries.`);
  let bytes = 0;
  const headers: Record<string, string> = {};
  for (const [raw, value] of entries) {
    if (isCredentialName(raw)) throw new ApiCallError('credential-in-request', credentialMessage(raw));
    const name = raw.toLowerCase();
    if (name !== 'accept' && (!headerNameSchema.safeParse(name).success || /method-override/.test(name)))
      throw new ApiCallError('invalid-request', `Header "${raw}" cannot be set by the agent.`);
    if (name in headers) throw new ApiCallError('invalid-request', `Header "${raw}" is set twice.`);
    if (value.length > API_CALL_LIMITS.headerValueCharacters || !/^[\x20-\x7e]*$/.test(value))
      throw new ApiCallError('invalid-request', `Header "${raw}" must be printable ASCII of at most 8192 characters.`);
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    headers[name] = value;
  }
  if (bytes > API_CALL_LIMITS.headerBytes)
    throw new ApiCallError('invalid-request', 'headers are larger than 16 KiB together.');
  headers.accept ??= defaultAccept;
  headers['user-agent'] = API_CALL_USER_AGENT;
  return headers;
}

const textTypes = /^(?:text\/[a-z0-9.+-]+|application\/(?:json|xml|[a-z0-9.-]+\+(?:json|xml)))$/;

/** The request body and its content type. */
export function encodeBody(body: ApiRequestBody): { body: string; contentType: string } {
  let encoded: { body: string; contentType: string };
  switch (body.kind) {
    case 'json':
      encoded = { body: JSON.stringify(body.value), contentType: 'application/json' };
      break;
    case 'form':
      encoded = {
        body: new URLSearchParams(body.fields.map(({ name, value }) => [name, value])).toString(),
        contentType: 'application/x-www-form-urlencoded',
      };
      break;
    case 'text': {
      const contentType = body.contentType.trim();
      const media = contentType.split(';')[0]!.trim().toLowerCase();
      if (!textTypes.test(media) || !/^[\x20-\x7e]*$/.test(contentType))
        throw new ApiCallError(
          'invalid-request',
          'body.contentType must be text/*, application/json, application/xml or a +json or +xml type.',
        );
      encoded = { body: body.text, contentType };
      break;
    }
  }
  if (Buffer.byteLength(encoded.body) > API_CALL_LIMITS.bodyBytes)
    throw new ApiCallError('too-large', 'The request body is over 1 MiB. Nothing was sent.');
  return encoded;
}
