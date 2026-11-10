import { isIP } from 'node:net';

export type McpNetworkErrorCode =
  | 'endpoint-denied'
  | 'address-denied'
  | 'headers-denied'
  | 'network-failed'
  | 'response-limit'
  | 'redirect-denied'
  | 'oauth-discovery-failed'
  | 'oauth-binding-denied'
  | 'oauth-registration-required'
  | 'oauth-registration-failed'
  | 'oauth-token-failed'
  | 'catalog-failed'
  | 'catalog-timeout'
  | 'catalog-http'
  | 'catalog-response'
  | 'catalog-page-limit'
  | 'catalog-byte-limit'
  | 'catalog-entry-limit'
  | 'catalog-invalid-json'
  | 'catalog-invalid-schema'
  | 'catalog-invalid-timestamp'
  | 'catalog-cursor-loop';
export type McpNetworkErrorDetail = 'dns-failed' | 'timeout' | 'aborted' | 'encoded-response';
export class McpNetworkError extends Error {
  readonly code: McpNetworkErrorCode;
  readonly detail: McpNetworkErrorDetail | undefined;
  /** True once a connection to the destination was established, so the request may have reached it. */
  readonly requestSent: boolean;
  constructor(code: McpNetworkErrorCode, options: { detail?: McpNetworkErrorDetail; requestSent?: boolean } = {}) {
    super(`mcp-${code}`);
    this.name = 'McpNetworkError';
    this.code = code;
    this.detail = options.detail;
    this.requestSent = options.requestSent ?? false;
  }
}
export type McpAuthentication =
  | { kind: 'none' }
  | { kind: 'bearer'; token: string }
  | { kind: 'headers'; headers: Readonly<Record<string, string>>; cookie?: string };

export type PrivateHost = { host: string; port: number | null; http: boolean };
export type DestinationAddresses = 'public' | { privateHosts: readonly PrivateHost[] };

const publicHostname = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const privateHostname = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function parsePrivateHosts(input: string): PrivateHost[] {
  const hosts: PrivateHost[] = [];
  for (const entry of input.split(',').map(item => item.trim())) {
    if (!entry) continue;
    const match = /^([^:;]+)(?::(\d{1,5}))?(;http)?$/.exec(entry);
    const host = match?.[1] ?? '';
    const port = match?.[2] === undefined ? null : Number(match[2]);
    if (
      !match ||
      host.length > 253 ||
      !privateHostname.test(host) ||
      /^\d+$/.test(host.split('.').at(-1) ?? '') ||
      (port !== null && (port < 1 || port > 65535))
    )
      throw new Error(`invalid private host entry: ${entry}`);
    hosts.push({ host, port, http: match[3] !== undefined });
  }
  return hosts;
}

export function listedPrivateHost(url: URL, addresses: DestinationAddresses): boolean {
  return (
    addresses !== 'public' &&
    addresses.privateHosts.some(
      entry =>
        entry.host === url.hostname &&
        (url.protocol === 'https:' || (url.protocol === 'http:' && entry.http)) &&
        (entry.port === null ? !url.port : Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === entry.port),
    )
  );
}

export function normalizeDestination(input: string, addresses: DestinationAddresses = 'public'): URL {
  try {
    if (
      input.length > 4096 ||
      /[\s\\]/.test(input) ||
      [...input].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      throw new Error();
    const url = new URL(input);
    if (
      url.username ||
      url.password ||
      url.hash ||
      input.includes('#') ||
      isIP(url.hostname) ||
      url.hostname.startsWith('[') ||
      url.hostname.endsWith('.')
    )
      throw new Error();
    if (
      !listedPrivateHost(url, addresses) &&
      (url.protocol !== 'https:' || url.port || !publicHostname.test(url.hostname))
    )
      throw new Error();
    return url;
  } catch {
    throw new McpNetworkError('endpoint-denied');
  }
}

export function normalizeEndpoint(input: string, addresses: DestinationAddresses = 'public'): string {
  const url = normalizeDestination(input, addresses);
  for (const key of url.searchParams.keys()) {
    if (/(?:token|secret|password|passwd|credential|authorization|api.?key|signature|^key$|^code$|^sig$)/i.test(key))
      throw new McpNetworkError('endpoint-denied');
  }
  if (/\{[^}]*\}|%7b|%7d/i.test(url.href)) throw new McpNetworkError('endpoint-denied');
  return url.href;
}

const deniedHeaders = new Set([
  'host',
  'cookie',
  'cookie2',
  'set-cookie',
  'connection',
  'content-length',
  'content-type',
  'accept',
  'accept-encoding',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'origin',
  'referer',
  'user-agent',
  'expect',
  'forwarded',
  'via',
  'range',
  'traceparent',
  'tracestate',
]);
export function authenticationHeaders(auth: McpAuthentication): Record<string, string> {
  if (auth.kind === 'none') return {};
  if (auth.kind === 'bearer') {
    if (!/^[A-Za-z0-9\-._~+/]+=*$/.test(auth.token) || auth.token.length > 8192)
      throw new McpNetworkError('headers-denied');
    return { authorization: `Bearer ${auth.token}` };
  }
  const result: Record<string, string> = {};
  const entries = Object.entries(auth.headers);
  if ((!entries.length && !auth.cookie) || entries.length > 16) throw new McpNetworkError('headers-denied');
  for (const [raw, value] of entries) {
    const name = raw.toLowerCase();
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(name) ||
      deniedHeaders.has(name) ||
      /^(?:proxy-|sec-|mcp-|x-forwarded-|x-http-method)/.test(name) ||
      Object.hasOwn(result, name) ||
      !value ||
      value.length > 8192 ||
      /[^\x20-\x7e]/.test(value)
    )
      throw new McpNetworkError('headers-denied');
    result[name] = value;
  }
  // Only a cookie built from saved secrets may be sent; a free-form `cookie` header stays denied above.
  if (auth.cookie !== undefined) {
    if (
      !/^[!#-+\--:<-~]+=[!#-+\--:<-~]*(?:; [!#-+\--:<-~]+=[!#-+\--:<-~]*)*$/.test(auth.cookie) ||
      auth.cookie.length > 8192
    )
      throw new McpNetworkError('headers-denied');
    result.cookie = auth.cookie;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 16384) throw new McpNetworkError('headers-denied');
  return result;
}

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    return (
      address !== '168.63.129.16' &&
      !(
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
      )
    );
  }
  if (isIP(address) !== 6 || address.includes('%') || address.includes('.')) return false;
  const halves = address.toLowerCase().split('::');
  const left = halves[0]?.split(':').filter(Boolean) ?? [];
  const right = halves[1]?.split(':').filter(Boolean) ?? [];
  const words = [...left, ...Array.from({ length: 8 - left.length - right.length }, () => '0'), ...right].map(word =>
    parseInt(word, 16),
  );
  const a = words[0] ?? 0,
    b = words[1] ?? 0;
  return (
    (a & 0xe000) === 0x2000 &&
    !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) &&
    a !== 0x2002 &&
    !(a === 0x3fff && (b & 0xf000) === 0)
  );
}
