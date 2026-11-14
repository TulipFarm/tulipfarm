import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex, Readable } from 'node:stream';

/** Where an app's endpoint answers, as `AppHost.connect` returns it. */
export type Endpoint = { readonly url: string; readonly headers: Readonly<Record<string, string>> };

/** The client as the gateway sees it, for the `X-Forwarded-*` headers. */
export type Client = { readonly address: string; readonly protocol: string; readonly host: string };

/** What came back from upstream. An upgrade carries the upstream socket once it switched protocols. */
export type Upstream =
  | { readonly kind: 'response'; readonly response: IncomingMessage }
  | { readonly kind: 'upgraded'; readonly response: IncomingMessage; readonly socket: Duplex; readonly head: Buffer };

/**
 * A refusal from the forwarding layer itself rather than from the app. Spawnbox marks its own answers with
 * `X-Spawnbox-Error`; any response without it came from the app.
 */
export type Refusal = { readonly code: string; readonly retryAfterSeconds: number | null };

/** Refusals that clear on their own while a sandbox wakes, drains or finds capacity. */
export const wakingCodes: ReadonlySet<string> = new Set([
  'wake_busy',
  'not_ready',
  'sandbox_cold',
  'sandbox_paused',
  'too_many_requests',
  'draining',
  'stale_route',
  'rebuilding',
  'no_capacity',
]);

/** Refusals that mean the endpoint's credentials went stale; a fresh `connect` fixes them. */
export const staleEndpointCodes: ReadonlySet<string> = new Set(['unauthorized', 'forbidden']);

const hopByHop = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
// Headers the client may not set: they would steer the forwarding layer or lie about who is asking.
const clientForged = (name: string) =>
  name === 'host' ||
  name === 'forwarded' ||
  name === 'x-real-ip' ||
  name.startsWith('x-forwarded-') ||
  name.startsWith('x-spawnbox-');
const tulipfarmCookie = /^__Host-tf_/;

function connectionTokens(headers: IncomingHttpHeaders) {
  return new Set(
    String(headers.connection ?? '')
      .split(',')
      .map(token => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Cookies without TulipFarm's own, which never belong to an app; undefined when none are left. */
export function appCookies(cookie: string | undefined): string | undefined {
  const kept = (cookie ?? '')
    .split(';')
    .map(pair => pair.trim())
    .filter(pair => pair && !tulipfarmCookie.test(pair.split('=', 1)[0]!.trim()));
  return kept.length ? kept.join('; ') : undefined;
}

/**
 * The headers sent upstream: the client's own, less hop-by-hop, forged and TulipFarm headers, plus who asked and the
 * endpoint's credentials. `upgrade` keeps the WebSocket handshake headers.
 */
export function upstreamHeaders(
  headers: IncomingHttpHeaders,
  options: { readonly client: Client; readonly endpoint: Endpoint; readonly wake: boolean; readonly upgrade: boolean },
): OutgoingHttpHeaders {
  const named = connectionTokens(headers);
  const forwarded: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || hopByHop.has(name) || named.has(name) || clientForged(name) || name === 'cookie')
      continue;
    forwarded[name] = value;
  }
  const cookie = appCookies(headers.cookie);
  if (cookie) forwarded.cookie = cookie;
  if (options.upgrade) {
    forwarded.connection = 'Upgrade';
    if (headers.upgrade) forwarded.upgrade = headers.upgrade;
  }
  forwarded['x-forwarded-for'] = options.client.address;
  forwarded['x-forwarded-proto'] = options.client.protocol;
  forwarded['x-forwarded-host'] = options.client.host;
  if (!options.wake) forwarded['x-spawnbox-wake'] = 'never';
  return { ...forwarded, ...options.endpoint.headers };
}

/** The app's response headers for the client, less hop-by-hop and forwarding-layer headers. */
export function clientHeaders(
  headers: IncomingHttpHeaders,
  options: { readonly upgrade: boolean },
): OutgoingHttpHeaders {
  const named = connectionTokens(headers);
  const kept: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name.startsWith('x-spawnbox-')) continue;
    // A switched connection keeps the headers that confirm the switch.
    const switching = options.upgrade && (name === 'upgrade' || name === 'connection');
    if (!switching && (hopByHop.has(name) || named.has(name))) continue;
    kept[name] = value;
  }
  return kept;
}

export function refusalOf(response: IncomingMessage): Refusal | null {
  const code = response.headers['x-spawnbox-error'];
  if (typeof code !== 'string') return null;
  const seconds = Number(response.headers['retry-after']);
  return { code, retryAfterSeconds: Number.isInteger(seconds) && seconds >= 0 ? seconds : null };
}

/** Sends one request to the endpoint and resolves with its response, or with the switched socket for an upgrade. */
export function openUpstream(
  endpoint: Endpoint,
  request: { readonly method: string; readonly path: string; readonly headers: OutgoingHttpHeaders },
  body: Readable | undefined,
  signal: AbortSignal,
): Promise<Upstream> {
  const target = new URL(endpoint.url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = send(target, {
      method: request.method,
      path: `${target.pathname.replace(/\/$/, '')}${request.path}`,
      headers: { ...request.headers, host: target.host },
      signal,
    });
    outgoing.once('response', response => resolve({ kind: 'response', response }));
    outgoing.once('upgrade', (response, socket, head) => resolve({ kind: 'upgraded', response, socket, head }));
    outgoing.once('error', reject);
    if (body) body.pipe(outgoing);
    else outgoing.end();
  });
}
