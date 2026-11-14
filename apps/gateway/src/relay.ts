import { STATUS_CODES, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';
import { AppHostUnavailableError } from '@tulipfarm/extensions';
import {
  clientHeaders,
  openUpstream,
  refusalOf,
  staleEndpointCodes,
  upstreamHeaders,
  wakingCodes,
  type Client,
  type Endpoint,
  type Refusal,
  type Upstream,
} from './forward.ts';

/** Where a request goes: `key` names the endpoint for its cache, warm window and wake gate. */
export type Destination = {
  readonly key: string;
  readonly connect: (signal: AbortSignal) => Promise<Endpoint>;
};

type Outcome =
  | { readonly kind: 'answered'; readonly upstream: Upstream }
  | { readonly kind: 'refused'; readonly refusal: Refusal }
  | { readonly kind: 'unreachable' };

export type Answer =
  | 'not-found'
  | 'unavailable'
  | 'starting'
  | 'asleep'
  | 'not-responding'
  | 'timed-out'
  | 'rate-limited';

const answers: Record<Answer, { readonly status: number; readonly title: string }> = {
  'not-found': { status: 404, title: 'There is nothing here' },
  unavailable: { status: 503, title: 'This app is unavailable' },
  starting: { status: 503, title: 'This app is starting. This page will refresh in a few seconds.' },
  asleep: { status: 503, title: 'This app is asleep' },
  'not-responding': { status: 502, title: 'This app is not responding' },
  'timed-out': { status: 504, title: 'This app is not responding' },
  'rate-limited': { status: 429, title: 'Too many requests. Try again in a minute.' },
};
const jsonErrors: Record<Answer, string> = {
  'not-found': 'not-found',
  unavailable: 'app-unavailable',
  starting: 'app-starting',
  asleep: 'app-asleep',
  'not-responding': 'app-not-responding',
  'timed-out': 'app-not-responding',
  'rate-limited': 'rate-limit-exceeded',
};

const endpointMs = 30_000;
const warmMs = 60_000;
const gateWaitMs = 1_000;
const connectTimeoutMs = 10_000;
const retrySeconds = 5;
const upgradesPerMinute = 120;
export const cacheEntries = 10_000;
// Link previews, crawlers and monitors must not keep a stopped app awake.
const bots = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|uptime|monitor/i;

/** A single-flight cache: one load per key at a time, kept for `ttlMs`, dropped when the load fails. */
export function cached<V>(ttlMs: number) {
  const entries = new Map<string, { readonly value: Promise<V>; readonly until: number }>();
  return {
    get(key: string, load: () => Promise<V>) {
      const now = Date.now();
      const hit = entries.get(key);
      if (hit && hit.until > now) return hit.value;
      entries.delete(key);
      if (entries.size >= cacheEntries) entries.delete(entries.keys().next().value!);
      const value = load();
      entries.set(key, { value, until: now + ttlMs });
      value.catch(() => {
        if (entries.get(key)?.value === value) entries.delete(key);
      });
      return value;
    },
    forget(key: string) {
      entries.delete(key);
    },
  };
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms).unref());

const hasBody = (headers: IncomingMessage['headers']) =>
  headers['transfer-encoding'] !== undefined || Number(headers['content-length'] ?? 0) > 0;

const wakes = (method: string, headers: IncomingMessage['headers']) =>
  method !== 'HEAD' && !bots.test(headers['user-agent'] ?? '');

/** Ends a raw socket with a bodiless status, for upgrade requests that never reach an app. */
export function rawStatus(socket: Duplex, status: number, retryAfterSeconds?: number) {
  const retry = retryAfterSeconds === undefined ? '' : `Retry-After: ${retryAfterSeconds}\r\n`;
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n${retry}Content-Length: 0\r\nConnection: close\r\n\r\n`);
}

export function rawAnswer(socket: Duplex, answer: Answer) {
  rawStatus(socket, answers[answer].status, answer === 'starting' || answer === 'asleep' ? retrySeconds : undefined);
}

function rawHead(status: number, message: string, headers: OutgoingHttpHeaders) {
  const lines = Object.entries(headers).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map(item => `${name}: ${String(item)}\r\n`),
  );
  return `HTTP/1.1 ${status} ${message}\r\n${lines.join('')}\r\n`;
}

/**
 * Answers a request the gateway cannot forward: a page for browsers and JSON for other clients, never cached.
 * `frameAncestors` is the CSP source list that may frame the page.
 */
export function answer(
  request: FastifyRequest,
  reply: FastifyReply,
  answer: Answer,
  options: { readonly retryAfterSeconds?: number | null; readonly frameAncestors: string },
) {
  const { status, title } = answers[answer];
  reply.code(status).header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
  const retry = answer === 'starting' || answer === 'asleep' ? (options.retryAfterSeconds ?? retrySeconds) : null;
  if (retry !== null) reply.header('Retry-After', retry);
  if (!/text\/html/.test(request.headers.accept ?? '')) return reply.send({ error: jsonErrors[answer] });
  reply
    .type('text/html; charset=utf-8')
    .header(
      'Content-Security-Policy',
      `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${options.frameAncestors}`,
    );
  const refresh = answer === 'starting' ? `<meta http-equiv="refresh" content="${retry}">` : '';
  return reply.send(`<!doctype html><meta charset="utf-8">${refresh}<title>${title}</title><p>${title}</p>`);
}

/**
 * Forwards requests and WebSocket handshakes to app endpoints with their bodies streamed both ways. A request that may
 * wake a stopped app waits for it; while one request wakes an endpoint, the others for it briefly wait for that one,
 * so a burst wakes it once.
 */
export function createRelay(options: { readonly wakeBudgetMs: number; readonly log: (error: unknown) => void }) {
  const { wakeBudgetMs } = options;
  const endpoints = cached<Endpoint>(endpointMs);
  const warmUntil = new Map<string, number>();
  const waking = new Map<string, Promise<void>>();
  const isWarm = (key: string) => (warmUntil.get(key) ?? 0) > Date.now();
  function warm(key: string) {
    warmUntil.delete(key);
    if (warmUntil.size >= cacheEntries) warmUntil.delete(warmUntil.keys().next().value!);
    warmUntil.set(key, Date.now() + warmMs);
  }

  async function attempt(destination: Destination, send: (endpoint: Endpoint) => Promise<Upstream>): Promise<Outcome> {
    const { key } = destination;
    const endpoint = await endpoints.get(key, () => destination.connect(AbortSignal.timeout(connectTimeoutMs)));
    let upstream: Upstream;
    try {
      upstream = await send(endpoint);
    } catch {
      return { kind: 'unreachable' };
    }
    const refusal = refusalOf(upstream.response);
    if (!refusal) {
      warm(key);
      return { kind: 'answered', upstream };
    }
    upstream.response.resume();
    if (staleEndpointCodes.has(refusal.code)) endpoints.forget(key);
    if (wakingCodes.has(refusal.code)) warmUntil.delete(key);
    return { kind: 'refused', refusal };
  }

  /** Sends until the app answers or the budget runs out. Only a request without a body can be sent again. */
  async function exchange(
    destination: Destination,
    send: (endpoint: Endpoint) => Promise<Upstream>,
    options: { readonly wake: boolean; readonly replayable: boolean; readonly deadline: number },
  ): Promise<Outcome> {
    let renewed = false;
    for (;;) {
      const outcome = await attempt(destination, send);
      if (outcome.kind !== 'refused' || !options.replayable) return outcome;
      const { code, retryAfterSeconds } = outcome.refusal;
      if (staleEndpointCodes.has(code) && !renewed) {
        renewed = true;
        continue;
      }
      const waitMs = Math.max(retryAfterSeconds ?? 1, 1) * 1_000;
      if (!options.wake || !wakingCodes.has(code) || Date.now() + waitMs >= options.deadline) return outcome;
      await sleep(waitMs);
    }
  }

  /**
   * Lets one request at a time wake a cold endpoint, so a burst wakes it once. The others wait for it only briefly and
   * then go anyway: the holder may be a slow request to an app that already runs, and the forwarding layer joins
   * concurrent wakes of one sandbox itself.
   */
  async function deliver(
    destination: Destination,
    send: (endpoint: Endpoint) => Promise<Upstream>,
    options: { readonly wake: boolean; readonly replayable: boolean },
  ): Promise<Outcome> {
    const { key } = destination;
    const deadline = Date.now() + wakeBudgetMs;
    const go = () => exchange(destination, send, { ...options, deadline });
    if (!options.wake || isWarm(key)) return go();
    const gate = waking.get(key);
    if (gate) {
      await Promise.race([gate, sleep(Math.min(gateWaitMs, deadline - Date.now()))]);
      return go();
    }
    // A request with a body cannot be sent again, so it would hold the others while its client trickles the body.
    if (!options.replayable) return go();
    let open!: () => void;
    waking.set(key, new Promise<void>(resolve => (open = resolve)));
    try {
      return await go();
    } finally {
      waking.delete(key);
      open();
    }
  }

  function refusalAnswer(refusal: Refusal, wake: boolean): Answer {
    if (wakingCodes.has(refusal.code)) return wake ? 'starting' : 'asleep';
    if (refusal.code === 'upstream_timeout') return 'timed-out';
    if (refusal.code === 'upstream_unreachable' || refusal.code === 'internal') return 'not-responding';
    return 'unavailable';
  }

  const upgrades = new Map<string, { count: number; resetAt: number }>();
  function allowUpgrade(address: string) {
    const now = Date.now();
    const window = upgrades.get(address);
    if (!window || window.resetAt <= now) {
      if (upgrades.size >= cacheEntries) upgrades.delete(upgrades.keys().next().value!);
      upgrades.set(address, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    window.count += 1;
    return window.count <= upgradesPerMinute;
  }

  return {
    /** Forwards an HTTP request and resolves with the app's response, or with what to answer instead. */
    async request(
      request: FastifyRequest,
      reply: FastifyReply,
      destination: Destination,
    ): Promise<
      | { readonly kind: 'response'; readonly response: IncomingMessage }
      | { readonly kind: 'answer'; readonly answer: Answer; readonly retryAfterSeconds: number | null }
    > {
      const wake = wakes(request.method, request.headers);
      const replayable = !hasBody(request.headers);
      const client: Client = { address: request.ip, protocol: request.protocol, host: request.host };
      const sender = new AbortController();
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) sender.abort();
      });
      const outcome = await deliver(
        destination,
        endpoint =>
          openUpstream(
            endpoint,
            {
              method: request.method,
              path: request.url,
              headers: upstreamHeaders(request.headers, { client, endpoint, wake, upgrade: false }),
            },
            replayable ? undefined : request.raw,
            sender.signal,
          ),
        { wake, replayable },
      );
      if (outcome.kind === 'unreachable') return { kind: 'answer', answer: 'not-responding', retryAfterSeconds: null };
      if (outcome.kind === 'refused')
        return {
          kind: 'answer',
          answer: refusalAnswer(outcome.refusal, wake),
          retryAfterSeconds: outcome.refusal.retryAfterSeconds,
        };
      return { kind: 'response', response: outcome.upstream.response };
    },

    /** Whether a client may open another WebSocket this minute. */
    allowUpgrade,

    /**
     * Forwards a WebSocket handshake and, once the app switches protocols, pipes both sockets until either closes.
     * Resolves with the app's socket while the two are piped, or null once the client has been answered instead.
     */
    async upgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      client: Client,
      destination: Destination,
    ): Promise<Duplex | null> {
      let outcome: Outcome;
      try {
        const sender = new AbortController();
        socket.once('close', () => sender.abort());
        outcome = await deliver(
          destination,
          endpoint =>
            openUpstream(
              endpoint,
              {
                method: request.method ?? 'GET',
                path: request.url ?? '/',
                headers: upstreamHeaders(request.headers, { client, endpoint, wake: true, upgrade: true }),
              },
              undefined,
              sender.signal,
            ),
          { wake: true, replayable: true },
        );
      } catch (error) {
        if (!(error instanceof AppHostUnavailableError)) options.log(error);
        rawAnswer(socket, 'unavailable');
        return null;
      }
      if (outcome.kind === 'unreachable') {
        rawAnswer(socket, 'not-responding');
        return null;
      }
      if (outcome.kind === 'refused') {
        rawAnswer(socket, refusalAnswer(outcome.refusal, true));
        return null;
      }
      const { upstream } = outcome;
      if (upstream.kind === 'response') {
        const { response } = upstream;
        socket.write(
          rawHead(response.statusCode ?? 502, response.statusMessage ?? '', {
            ...clientHeaders(response.headers, { upgrade: false }),
            connection: 'close',
          }),
        );
        response.pipe(socket);
        return null;
      }
      const { response, socket: app } = upstream;
      app.on('error', () => socket.destroy());
      socket.on('close', () => app.destroy());
      app.on('close', () => socket.destroy());
      // The server keeps half-open sockets; a WebSocket is over once either side stops sending.
      socket.once('end', () => socket.end());
      socket.write(rawHead(101, 'Switching Protocols', clientHeaders(response.headers, { upgrade: true })));
      if (upstream.head.length) socket.write(upstream.head);
      if (head.length) app.write(head);
      app.pipe(socket);
      socket.pipe(app);
      return app;
    },
  };
}

/** The client of a raw upgrade request, trusting forwarded hops the same way the server options do. */
export function upgradeClient(request: IncomingMessage, trustProxy: FastifyServerOptions['trustProxy']): Client {
  const trusted = typeof trustProxy === 'function' ? trustProxy : () => trustProxy === true;
  const forwardedFor = String(request.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map(hop => hop.trim())
    .filter(Boolean);
  const hops = [request.socket.remoteAddress ?? '', ...forwardedFor.reverse()];
  let hop = 0;
  while (hop < hops.length - 1 && trusted(hops[hop]!, hop)) hop += 1;
  const forwardedProto = String(request.headers['x-forwarded-proto'] ?? '')
    .split(',')
    .at(-1)
    ?.trim();
  const encrypted = (request.socket as { encrypted?: boolean }).encrypted === true;
  return {
    address: hops[hop]!,
    protocol: hop > 0 && forwardedProto ? forwardedProto : encrypted ? 'https' : 'http',
    host: request.headers.host ?? '',
  };
}
