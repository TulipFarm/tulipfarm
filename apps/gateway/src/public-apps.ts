import { STATUS_CODES, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';
import rateLimit from '@fastify/rate-limit';
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { appNameSchema } from '@tulipfarm/apps';
import type { CurrentAppRoute } from '@tulipfarm/apps/store';
import { AppHostUnavailableError, type AppHost } from '@tulipfarm/extensions';
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
import { registerObservability, requestBoundaryError } from './http.ts';

export type PublicAppsDependencies = {
  /** Parent domain of public app hosts: `<app name>.<domain>`. */
  readonly domain: string;
  /** The app that holds a public name now and its route. */
  readonly route: (name: string) => Promise<CurrentAppRoute | null>;
  readonly enabled: (workspaceId: string) => Promise<boolean>;
  readonly host: Pick<AppHost, 'connect'>;
  /** How long a request that may wake an app waits for it before the client is told it is starting. */
  readonly wakeBudgetMs?: number;
};

/** What a public name leads to. Static apps are served by the edge, so the gateway has nothing for them. */
type PublicApp =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'server'; readonly appId: string };

type Outcome =
  | { readonly kind: 'answered'; readonly upstream: Upstream }
  | { readonly kind: 'refused'; readonly refusal: Refusal }
  | { readonly kind: 'unreachable' };

type Answer = 'not-found' | 'unavailable' | 'starting' | 'asleep' | 'not-responding' | 'timed-out' | 'rate-limited';

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

const lookupMs = 15_000;
const endpointMs = 30_000;
const warmMs = 60_000;
const gateWaitMs = 1_000;
const connectTimeoutMs = 10_000;
const retrySeconds = 5;
const upgradesPerMinute = 120;
const cacheEntries = 10_000;
// Link previews, crawlers and monitors must not keep a stopped app awake.
const bots = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|uptime|monitor/i;

export function appNameOf(host: string | undefined, domain: string): string | null | undefined {
  const name = host?.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!name?.endsWith(`.${domain}`)) return undefined;
  const parsed = appNameSchema.safeParse(name.slice(0, -domain.length - 1));
  return parsed.success ? parsed.data : null;
}

/** A single-flight cache: one load per key at a time, kept for `ttlMs`, dropped when the load fails. */
function cached<V>(ttlMs: number, load: (key: string) => Promise<V>) {
  const entries = new Map<string, { readonly value: Promise<V>; readonly until: number }>();
  return {
    get(key: string) {
      const now = Date.now();
      const hit = entries.get(key);
      if (hit && hit.until > now) return hit.value;
      entries.delete(key);
      if (entries.size >= cacheEntries) entries.delete(entries.keys().next().value!);
      const value = load(key);
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

function rawAnswer(socket: Duplex, answer: Answer) {
  const { status } = answers[answer];
  const retry = answer === 'starting' || answer === 'asleep' ? `Retry-After: ${retrySeconds}\r\n` : '';
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n${retry}Content-Length: 0\r\nConnection: close\r\n\r\n`);
}

function rawHead(status: number, message: string, headers: OutgoingHttpHeaders) {
  const lines = Object.entries(headers).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map(item => `${name}: ${String(item)}\r\n`),
  );
  return `HTTP/1.1 ${status} ${message}\r\n${lines.join('')}\r\n`;
}

/**
 * The gateway for public server apps. Each request for `<name>.<domain>` goes to the app's endpoint from
 * `AppHost.connect` with its body streamed both ways. A request that may wake a stopped app waits for it; while one
 * request wakes an app, the others for it briefly wait for that one, so a burst wakes it once.
 */
export function buildPublicAppsGateway(dependencies: PublicAppsDependencies, serverOptions: FastifyServerOptions) {
  const { domain } = dependencies;
  const wakeBudgetMs = dependencies.wakeBudgetMs ?? 30_000;
  const gateway = Fastify({
    ...serverOptions,
    logger: { serializers: { err: () => ({ type: 'Error', message: 'request_failed', stack: '' }), req: () => ({}) } },
    logController: new LogController({ disableRequestLogging: true }),
  });
  registerObservability(gateway);
  gateway.register(rateLimit, { global: true, max: 1_200, timeWindow: 60_000, cache: 10_000 });
  // Bodies stream to the app untouched.
  gateway.removeAllContentTypeParsers();
  gateway.addContentTypeParser('*', (_request, _payload, done) => done(null));

  const lookups = cached<PublicApp>(lookupMs, async name => {
    const found = await dependencies.route(name);
    if (found?.route?.kind !== 'server' || !(await dependencies.enabled(found.workspaceId))) return { kind: 'missing' };
    return found.route.status === 'active' ? { kind: 'server', appId: found.appId } : { kind: 'unavailable' };
  });
  const endpoints = cached<Endpoint>(endpointMs, appId =>
    dependencies.host.connect({ appId }, AbortSignal.timeout(connectTimeoutMs)),
  );
  const warmUntil = new Map<string, number>();
  const waking = new Map<string, Promise<void>>();
  const isWarm = (appId: string) => (warmUntil.get(appId) ?? 0) > Date.now();
  function warm(appId: string) {
    warmUntil.delete(appId);
    if (warmUntil.size >= cacheEntries) warmUntil.delete(warmUntil.keys().next().value!);
    warmUntil.set(appId, Date.now() + warmMs);
  }

  const resolve = (host: string | undefined): Promise<PublicApp> => {
    const name = appNameOf(host, domain);
    return name ? lookups.get(name) : Promise.resolve({ kind: 'missing' });
  };

  async function attempt(appId: string, send: (endpoint: Endpoint) => Promise<Upstream>): Promise<Outcome> {
    const endpoint = await endpoints.get(appId);
    let upstream: Upstream;
    try {
      upstream = await send(endpoint);
    } catch {
      return { kind: 'unreachable' };
    }
    const refusal = refusalOf(upstream.response);
    if (!refusal) {
      warm(appId);
      return { kind: 'answered', upstream };
    }
    upstream.response.resume();
    if (staleEndpointCodes.has(refusal.code)) endpoints.forget(appId);
    if (wakingCodes.has(refusal.code)) warmUntil.delete(appId);
    return { kind: 'refused', refusal };
  }

  /** Sends until the app answers or the budget runs out. Only a request without a body can be sent again. */
  async function exchange(
    appId: string,
    send: (endpoint: Endpoint) => Promise<Upstream>,
    options: { readonly wake: boolean; readonly replayable: boolean; readonly deadline: number },
  ): Promise<Outcome> {
    let renewed = false;
    for (;;) {
      const outcome = await attempt(appId, send);
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
   * Lets one request at a time wake a cold app, so a burst wakes it once. The others wait for it only briefly and then
   * go anyway: the holder may be a slow request to an app that already runs, and the forwarding layer joins concurrent
   * wakes of one sandbox itself.
   */
  async function deliver(
    appId: string,
    send: (endpoint: Endpoint) => Promise<Upstream>,
    options: { readonly wake: boolean; readonly replayable: boolean },
  ): Promise<Outcome> {
    const deadline = Date.now() + wakeBudgetMs;
    const go = () => exchange(appId, send, { ...options, deadline });
    if (!options.wake || isWarm(appId)) return go();
    const gate = waking.get(appId);
    if (gate) {
      await Promise.race([gate, sleep(Math.min(gateWaitMs, deadline - Date.now()))]);
      return go();
    }
    // A request with a body cannot be sent again, so it would hold the others while its client trickles the body.
    if (!options.replayable) return go();
    let open!: () => void;
    waking.set(appId, new Promise<void>(resolve => (open = resolve)));
    try {
      return await go();
    } finally {
      waking.delete(appId);
      open();
    }
  }

  function refusalAnswer(refusal: Refusal, wake: boolean): Answer {
    if (wakingCodes.has(refusal.code)) return wake ? 'starting' : 'asleep';
    if (refusal.code === 'upstream_timeout') return 'timed-out';
    if (refusal.code === 'upstream_unreachable' || refusal.code === 'internal') return 'not-responding';
    return 'unavailable';
  }

  function answer(request: FastifyRequest, reply: FastifyReply, answer: Answer, retryAfterSeconds?: number | null) {
    const { status, title } = answers[answer];
    reply.code(status).header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    const retry = answer === 'starting' || answer === 'asleep' ? (retryAfterSeconds ?? retrySeconds) : null;
    if (retry !== null) reply.header('Retry-After', retry);
    if (!/text\/html/.test(request.headers.accept ?? '')) return reply.send({ error: jsonErrors[answer] });
    reply
      .type('text/html; charset=utf-8')
      .header(
        'Content-Security-Policy',
        "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
    const refresh = answer === 'starting' ? `<meta http-equiv="refresh" content="${retry}">` : '';
    return reply.send(`<!doctype html><meta charset="utf-8">${refresh}<title>${title}</title><p>${title}</p>`);
  }

  // Routes go in a plugin after the rate limit so its global hook reaches them.
  gateway.register(async routes => {
    routes.route({
      method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      url: '/*',
      exposeHeadRoute: false,
      async handler(request, reply) {
        const app = await resolve(request.headers.host);
        if (app.kind !== 'server') return answer(request, reply, app.kind === 'missing' ? 'not-found' : 'unavailable');
        const wake = wakes(request.method, request.headers);
        const replayable = !hasBody(request.headers);
        const client: Client = { address: request.ip, protocol: request.protocol, host: request.host };
        const sender = new AbortController();
        reply.raw.once('close', () => {
          if (!reply.raw.writableFinished) sender.abort();
        });
        const outcome = await deliver(
          app.appId,
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
        if (outcome.kind === 'unreachable') return answer(request, reply, 'not-responding');
        if (outcome.kind === 'refused')
          return answer(request, reply, refusalAnswer(outcome.refusal, wake), outcome.refusal.retryAfterSeconds);
        const { response } = outcome.upstream;
        reply.code(response.statusCode ?? 502).headers(clientHeaders(response.headers, { upgrade: false }));
        return reply.send(response);
      },
    });
  });

  gateway.setNotFoundHandler((request, reply) => answer(request, reply, 'not-found'));
  gateway.setErrorHandler((error, request, reply) => {
    if (requestBoundaryError(error, reply)) return;
    if (!(error instanceof AppHostUnavailableError)) request.log.error({ err: error }, 'App request failed');
    return answer(request, reply, 'unavailable');
  });

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

  /** Forwards a WebSocket handshake and, once the app switches protocols, pipes both sockets until either closes. */
  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, client: Client) {
    socket.on('error', () => socket.destroy());
    if (!allowUpgrade(client.address)) return rawAnswer(socket, 'rate-limited');
    let outcome: Outcome;
    try {
      const app = await resolve(request.headers.host);
      if (app.kind !== 'server') return rawAnswer(socket, app.kind === 'missing' ? 'not-found' : 'unavailable');
      const sender = new AbortController();
      socket.once('close', () => sender.abort());
      outcome = await deliver(
        app.appId,
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
      if (!(error instanceof AppHostUnavailableError)) gateway.log.error({ err: error }, 'App upgrade failed');
      return rawAnswer(socket, 'unavailable');
    }
    if (outcome.kind === 'unreachable') return rawAnswer(socket, 'not-responding');
    if (outcome.kind === 'refused') return rawAnswer(socket, refusalAnswer(outcome.refusal, true));
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
      return;
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
  }

  return { http: gateway, upgrade };
}

export type PublicAppsGateway = ReturnType<typeof buildPublicAppsGateway>;

/** The client of a raw upgrade request, trusting forwarded hops the same way the server options do. */
function upgradeClient(request: IncomingMessage, trustProxy: FastifyServerOptions['trustProxy']): Client {
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

/**
 * Hands every request and WebSocket handshake for a public app host to the public apps gateway before the host
 * server's routes see it. Handshakes for other hosts are refused.
 */
export function routePublicAppHosts(
  app: FastifyInstance,
  gateway: PublicAppsGateway,
  domain: string,
  serverOptions: FastifyServerOptions,
) {
  app.addHook('onRequest', async (request, reply) => {
    if (appNameOf(request.headers.host, domain) === undefined) return;
    reply.hijack();
    gateway.http.routing(request.raw, reply.raw);
    return reply;
  });
  app.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (appNameOf(request.headers.host, domain) === undefined) return rawAnswer(socket, 'not-found');
    void gateway.upgrade(request, socket, head, upgradeClient(request, serverOptions.trustProxy));
  });
  app.addHook('onReady', async () => {
    await gateway.http.ready();
  });
  app.addHook('onClose', async () => {
    await gateway.http.close();
  });
}
