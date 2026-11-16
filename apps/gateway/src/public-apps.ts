import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import rateLimit from '@fastify/rate-limit';
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { appNameSchema } from '@tulipfarm/apps';
import type { CurrentAppRoute } from '@tulipfarm/apps/store';
import { AppHostUnavailableError, type AppHost } from '@tulipfarm/extensions';
import { clientHeaders, type Client } from './forward.ts';
import { registerObservability, requestBoundaryError } from './http.ts';
import { openLiveRequest, type LiveRequestStore, type ServedApp } from './live-requests.ts';
import { answer, cached, clientOf, createRelay, rawAnswer, type Destination } from './relay.ts';

export type PublicAppsDependencies = {
  /** Parent domain of public app hosts: `<app name>.<domain>`. */
  readonly domain: string;
  /** The app that holds a public name now and its route. */
  readonly route: (name: string) => Promise<CurrentAppRoute | null>;
  readonly enabled: (workspaceId: string) => Promise<boolean>;
  readonly host: Pick<AppHost, 'connect'>;
  /** How long a request that may wake an app waits for it before the client is told it is starting. */
  readonly wakeBudgetMs?: number;
  /** How long a WebSocket may carry nothing from the app before the gateway sends the client a keepalive frame. */
  readonly keepaliveMs?: number | undefined;
  /** Gives visitor requests to apps with approved data views a handle. Without it, no request gets one. */
  readonly liveRequests?:
    | {
        readonly store: LiveRequestStore;
        /** How often an open request is kept live; well inside the store's expiry. */
        readonly renewMs?: number;
        /** How often expired requests are deleted. */
        readonly sweepMs?: number;
      }
    | undefined;
};

/** What a public name leads to. Static apps are served by the edge, so the gateway has nothing for them. */
type PublicApp =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'server'; readonly app: ServedApp; readonly dataViews: boolean };

const lookupMs = 15_000;
const renewMs = 20_000;
const sweepMs = 60_000;
const unframed = "'none'";

export function appNameOf(host: string | undefined, domain: string): string | null | undefined {
  const name = host?.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!name?.endsWith(`.${domain}`)) return undefined;
  const parsed = appNameSchema.safeParse(name.slice(0, -domain.length - 1));
  return parsed.success ? parsed.data : null;
}

/**
 * The gateway for public server apps. Each request for `<name>.<domain>` goes to the app's endpoint from
 * `AppHost.connect` through the relay.
 */
export function buildPublicAppsGateway(dependencies: PublicAppsDependencies, serverOptions: FastifyServerOptions) {
  const { domain } = dependencies;
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

  const live = dependencies.liveRequests;
  const logLiveRequest = (error: unknown) => gateway.log.error({ err: error }, 'App request handle failed');
  const hasDataViews = async (app: ServedApp) => {
    if (!live) return false;
    try {
      return (await live.store.dataRelease(app)) !== null;
    } catch (error) {
      logLiveRequest(error);
      return false;
    }
  };
  const lookups = cached<PublicApp>(lookupMs);
  const findApp = async (name: string): Promise<PublicApp> => {
    const found = await dependencies.route(name);
    if (found?.route?.kind !== 'server' || !(await dependencies.enabled(found.workspaceId))) return { kind: 'missing' };
    if (found.route.status !== 'active') return { kind: 'unavailable' };
    const app = { workspaceId: found.workspaceId, appId: found.appId };
    return { kind: 'server', app, dataViews: await hasDataViews(app) };
  };
  const resolve = (host: string | undefined): Promise<PublicApp> => {
    const name = appNameOf(host, domain);
    return name ? lookups.get(name, () => findApp(name)) : Promise.resolve({ kind: 'missing' });
  };
  const destination = (appId: string): Destination => ({
    key: appId,
    connect: signal => dependencies.host.connect({ appId }, signal),
  });
  /** A handle for one visitor request to an app with data views, closed by `close` once the client is done. */
  const liveRequest = (app: Extract<PublicApp, { kind: 'server' }>) =>
    live && app.dataViews
      ? openLiveRequest(live.store, app.app, { renewMs: live.renewMs ?? renewMs, log: logLiveRequest })
      : null;
  if (live) {
    const sweeping = setInterval(() => {
      live.store.sweep().catch(logLiveRequest);
    }, live.sweepMs ?? sweepMs).unref();
    gateway.addHook('onClose', async () => clearInterval(sweeping));
  }
  const relay = createRelay({
    wakeBudgetMs: dependencies.wakeBudgetMs ?? 30_000,
    keepaliveMs: dependencies.keepaliveMs,
    log: error => gateway.log.error({ err: error }, 'App upgrade failed'),
  });

  // Routes go in a plugin after the rate limit so its global hook reaches them.
  gateway.register(async routes => {
    routes.route({
      method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      url: '/*',
      exposeHeadRoute: false,
      async handler(request, reply) {
        const app = await resolve(request.headers.host);
        if (app.kind !== 'server')
          return answer(request, reply, app.kind === 'missing' ? 'not-found' : 'unavailable', {
            frameAncestors: unframed,
          });
        const opened = liveRequest(app);
        if (opened) reply.raw.once('close', opened.close);
        const forwarded = await relay.request(
          request,
          reply,
          clientOf(request.raw, serverOptions.trustProxy),
          destination(app.app.appId),
          (await opened?.handle) ?? null,
        );
        if (forwarded.kind === 'answer')
          return answer(request, reply, forwarded.answer, {
            retryAfterSeconds: forwarded.retryAfterSeconds,
            frameAncestors: unframed,
          });
        const { response } = forwarded;
        reply.code(response.statusCode ?? 502).headers(clientHeaders(response.headers, { upgrade: false }));
        return reply.send(response);
      },
    });
  });

  gateway.setNotFoundHandler((request, reply) => answer(request, reply, 'not-found', { frameAncestors: unframed }));
  gateway.setErrorHandler((error, request, reply) => {
    if (requestBoundaryError(error, reply)) return;
    if (!(error instanceof AppHostUnavailableError)) request.log.error({ err: error }, 'App request failed');
    return answer(request, reply, 'unavailable', { frameAncestors: unframed });
  });

  /** Forwards a WebSocket handshake for a public app. */
  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, client: Client) {
    socket.on('error', () => socket.destroy());
    if (!relay.allowUpgrade(client.address)) return rawAnswer(socket, 'rate-limited');
    let app: PublicApp;
    try {
      app = await resolve(request.headers.host);
    } catch (error) {
      gateway.log.error({ err: error }, 'App upgrade failed');
      return rawAnswer(socket, 'unavailable');
    }
    if (app.kind !== 'server') return rawAnswer(socket, app.kind === 'missing' ? 'not-found' : 'unavailable');
    const opened = liveRequest(app);
    if (opened) socket.once('close', opened.close);
    await relay.upgrade(request, socket, head, client, destination(app.app.appId), (await opened?.handle) ?? null);
  }

  return { http: gateway, upgrade };
}

export type PublicAppsGateway = ReturnType<typeof buildPublicAppsGateway>;

/** Hands every request for a public app host to the public apps gateway before the host server's routes see it. */
export function routePublicAppHosts(app: FastifyInstance, gateway: FastifyInstance, domain: string) {
  app.addHook('onRequest', async (request, reply) => {
    if (appNameOf(request.headers.host, domain) === undefined) return;
    reply.hijack();
    gateway.routing(request.raw, reply.raw);
    return reply;
  });
  app.addHook('onReady', async () => {
    await gateway.ready();
  });
  app.addHook('onClose', async () => {
    await gateway.close();
  });
}
