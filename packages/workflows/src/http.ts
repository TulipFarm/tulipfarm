import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

export const httpRequestLimit = { timeoutMilliseconds: 10_000, responseBytes: 1_048_576 } as const;

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(network, prefix, 'ipv6');

const hextets = (address: string) => {
  let text = address.toLowerCase().replace(/%.*$/, '');
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head ? head.split(':') : [],
    right = tail ? tail.split(':') : [];
  return [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right].map(part =>
    parseInt(part, 16),
  );
};

const ipv4 = (high: number, low: number) => [high >> 8, high & 255, low >> 8, low & 255].join('.');

// IPv6 forms that carry an IPv4 destination: mapped, translated, compatible, NAT64, and 6to4.
const embeddedIpv4 = (parts: number[]) => {
  const zero = (from: number, to: number) => parts.slice(from, to).every(part => part === 0);
  if ((zero(0, 5) && parts[5] === 0xffff) || (zero(0, 4) && parts[4] === 0xffff && parts[5] === 0) || zero(0, 6))
    return ipv4(parts[6]!, parts[7]!);
  if (parts[0] === 0x64 && parts[1] === 0xff9b && zero(2, 6)) return ipv4(parts[6]!, parts[7]!);
  if (parts[0] === 0x2002) return ipv4(parts[1]!, parts[2]!);
  return undefined;
};

const privateAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family !== 6) return true;
  const embedded = embeddedIpv4(hextets(address));
  return embedded ? blocked.check(embedded, 'ipv4') : blocked.check(address.replace(/%.*$/, ''), 'ipv6');
};

export class HttpStepError extends Error {
  readonly code: 'egress-denied' | 'request-timeout' | 'response-too-large' | 'request-failed';
  constructor(code: HttpStepError['code']) {
    super(code);
    this.code = code;
  }
}

export async function requestHttp(input: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | undefined;
}) {
  const url = new URL(input.url);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    throw new HttpStepError('egress-denied');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true }).catch(() => {
        throw new HttpStepError('request-failed');
      });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address)))
    throw new HttpStepError('egress-denied');
  const address = addresses[0]!;
  return new Promise<{ status: number; headers: Record<string, string>; body: string }>((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout;
    const fail = (error: HttpStepError) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    };
    const req = request(
      url,
      {
        method: input.method,
        headers: input.headers,
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      },
      response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > httpRequestLimit.responseBytes) {
            response.destroy();
            fail(new HttpStepError('response-too-large'));
          } else chunks.push(chunk);
        });
        response.on('error', () => fail(new HttpStepError('request-failed')));
        response.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          const headers = Object.fromEntries(
            Object.entries(response.headers).flatMap(([name, value]) =>
              typeof value === 'string' ? [[name, value]] : [],
            ),
          );
          resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    timeout = setTimeout(() => {
      req.destroy();
      fail(new HttpStepError('request-timeout'));
    }, httpRequestLimit.timeoutMilliseconds);
    req.on('error', () => fail(new HttpStepError('request-failed')));
    req.end(input.body);
  });
}
