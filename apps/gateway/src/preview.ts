import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeader } from 'node:http';
import type { Duplex, Readable } from 'node:stream';
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import {
  previewKeyPattern,
  previewSessionSeconds,
  type AppResult,
  type PreviewBuild,
  type PreviewSession,
  type PreviewTarget,
} from '@tulipfarm/apps/store';
import { AppHostUnavailableError, type AppHost } from '@tulipfarm/extensions';
import { clientHeaders, type Client } from './forward.ts';
import { registerObservability, requestBoundaryError } from './http.ts';
import { answer, createRelay, rawAnswer, rawStatus, type Destination } from './relay.ts';

/* oxlint-disable tulipfarm/product-copy -- The paths and message types are a protocol shared with the web shell. */
export const previewCookie = '__Host-tf_preview';
export const previewEnterPath = '/__tulipfarm/preview/enter';
const previewCheckPath = '/__tulipfarm/preview/check';
const blockedMessage = 'preview-blocked';
const expiredMessage = 'preview-expired';
/* oxlint-enable tulipfarm/product-copy */

/** What the gateway reads. Every call is made per request, so a revoked grant blocks the next one. */
export type PreviewGatewayDependencies = {
  /** Parent domain of preview hosts: `<previewKey>.<domain>`. */
  readonly domain: string;
  /** The only origin allowed to frame a preview and to receive its messages. */
  readonly shellOrigin: string;
  readonly redeem: (previewKey: string, ticket: string) => Promise<{ readonly token: string } | null>;
  readonly session: (previewKey: string, token: string) => Promise<PreviewSession | null>;
  readonly enabled: (workspaceId: string) => Promise<boolean>;
  readonly target: (session: PreviewSession) => Promise<AppResult<{ readonly target: PreviewTarget }>>;
  /** Reads an object from the apps bucket, or null when it is missing. */
  readonly object: (key: string) => Promise<Readable | null>;
  /** Reaches the host that runs a draft's server. */
  readonly connectHost: NonNullable<AppHost['connectHost']>;
  /** How long a request that may wake a draft's server waits for it before the client is told it is starting. */
  readonly wakeBudgetMs?: number;
  /**
   * How often an open WebSocket or streamed response checks that its session may still reach the draft's host. 15
   * seconds by default; with checks that time out after 5 seconds, a connection outlives a revocation by at most 25.
   */
  readonly recheckMs?: number;
};

/**
 * Returns the preview key of a preview host, null for any other name under the preview domain, and undefined for a
 * host the gateway does not own.
 */
export function previewKeyOf(host: string | undefined, domain: string): string | null | undefined {
  const name = host?.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!name?.endsWith(`.${domain}`)) return undefined;
  const key = name.slice(0, -domain.length - 1);
  return previewKeyPattern.test(key) ? key : null;
}

const manifestSchema = z.array(
  z.object({
    path: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative(),
    contentType: z.string().min(1),
  }),
);
type PreviewFile = z.infer<typeof manifestSchema>[number];

/** Maps a request path to a file the way the public edge does: a directory path serves its `index.html`. */
export function previewFilePath(pathname: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!path.startsWith('/') || path.includes('\0')) return null;
  if (path.endsWith('/')) path += 'index.html';
  const segments = path.slice(1).split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

function cookieValue(header: string | undefined, name: string) {
  for (const part of header?.split(';') ?? []) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

/** A gateway page. Its only script posts one message to the shell, or confirms the cookie first. */
function page(reply: FastifyReply, shellOrigin: string, status: number, title: string, script?: string) {
  const nonce = randomBytes(16).toString('base64');
  reply
    .code(status)
    .type('text/html; charset=utf-8')
    .header(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${shellOrigin}`,
    );
  return reply.send(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><p>${escapeHtml(title)}</p>` +
      (script ? `<script nonce="${nonce}">${script}</script>` : ''),
  );
}

const notify = (shellOrigin: string, type: string) =>
  `if (window.parent !== window) window.parent.postMessage({ type: ${JSON.stringify(type)} }, ${JSON.stringify(shellOrigin)});`;

/** What a request on a preview host may reach right now. */
type Access =
  | { readonly kind: 'denied'; readonly status: number; readonly title: string }
  | { readonly kind: 'files'; readonly build: PreviewBuild | null }
  | { readonly kind: 'server'; readonly appId: string; readonly hostRef: string | null };

const ended: Access = {
  kind: 'denied',
  status: 401,
  title: 'This session has ended. Open the draft again from TulipFarm.',
};
const notEditor: Access = { kind: 'denied', status: 403, title: 'You can no longer edit this app' };
const nothing: Access = { kind: 'denied', status: 404, title: 'There is nothing here' };
const notRunning = 'The server for this draft is not running. Publish the app to run it.';
// A WebSocket close frame with status 1008, policy violation.
const policyClose = Buffer.from([0x88, 0x02, 0x03, 0xf0]);
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const reservedCookie = /^__Host-tf_/i;

/** Drops cookies a draft may not set: TulipFarm's own, and any scoped to a parent domain shared with other drafts. */
function draftCookie(cookie: string) {
  const [pair = '', ...attributes] = cookie.split(';');
  return !reservedCookie.test(pair.split('=', 1)[0]!.trim()) && !attributes.some(item => /^\s*domain\s*=/i.test(item));
}

function timeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Access check timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The gateway that serves draft previews on their own hosts. It is a separate server from the API, so no API route,
 * cookie or CORS rule ever answers on a preview host. The host process supplies the server options, which decide
 * whether the client address comes from a trusted proxy. A draft that builds files is served from the apps bucket; a
 * draft that runs a server is forwarded to the host that runs it.
 */
export function buildPreviewGateway(dependencies: PreviewGatewayDependencies, serverOptions: FastifyServerOptions) {
  const { domain, shellOrigin } = dependencies;
  const recheckMs = dependencies.recheckMs ?? 15_000;
  const checkTimeoutMs = Math.min(recheckMs, 5_000);
  const gateway = Fastify({
    ...serverOptions,
    logger: { serializers: { err: () => ({ type: 'Error', message: 'request_failed', stack: '' }), req: () => ({}) } },
    logController: new LogController({ disableRequestLogging: true }),
  });
  registerObservability(gateway);
  gateway.register(rateLimit, { global: true, max: 1_200, timeWindow: 60_000, cache: 10_000 });

  const manifests = new Map<string, Map<string, PreviewFile>>();
  async function manifest(build: PreviewBuild) {
    const cached = manifests.get(build.buildId);
    if (cached) return cached;
    const body = await dependencies.object(build.manifestKey);
    if (!body) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    const files = new Map(
      manifestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))).map(file => [file.path, file]),
    );
    if (manifests.size >= 64) manifests.delete(manifests.keys().next().value!);
    manifests.set(build.buildId, files);
    return files;
  }

  const keyOf = (request: FastifyRequest) => previewKeyOf(request.headers.host, domain)!;
  async function sessionOf(headers: IncomingHttpHeaders) {
    const key = previewKeyOf(headers.host, domain);
    const token = cookieValue(headers.cookie, previewCookie);
    return key && token ? dependencies.session(key, token) : null;
  }

  async function access(headers: IncomingHttpHeaders): Promise<Access> {
    const session = await sessionOf(headers);
    if (!session) return ended;
    if (!(await dependencies.enabled(session.workspaceId))) return nothing;
    const found = await dependencies.target(session);
    if (!found.ok) return found.failure.code === 'forbidden' ? notEditor : nothing;
    return found.target.kind === 'server' ? { ...found.target, appId: session.appId } : found.target;
  }

  /**
   * Calls `end` once the session that opened a connection may no longer reach `hostRef`. A check that fails or hangs
   * counts as lost access, so a connection outlives a revocation by at most `recheckMs` plus two check timeouts.
   */
  function watch(headers: IncomingHttpHeaders, hostRef: string, end: () => void) {
    let stopped = false;
    let timer: NodeJS.Timeout;
    const check = async () => {
      let still = false;
      try {
        const now = await timeout(access(headers), checkTimeoutMs);
        still = now.kind === 'server' && now.hostRef === hostRef;
      } catch {
        // A failed check counts as lost access.
      }
      if (stopped) return;
      if (!still) {
        stopped = true;
        end();
        return;
      }
      timer = setTimeout(check, recheckMs);
    };
    timer = setTimeout(check, recheckMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }

  const relay = createRelay({
    wakeBudgetMs: dependencies.wakeBudgetMs ?? 30_000,
    log: error => gateway.log.error({ err: error }, 'Draft upgrade failed'),
  });
  const destination = (appId: string, hostRef: string): Destination => ({
    key: `${appId}/${hostRef}`,
    connect: signal => dependencies.connectHost({ appId, hostRef }, signal),
  });

  /** The draft's response headers, kept inside its own host and frame. */
  function draftHeaders(headers: IncomingHttpHeaders): Record<string, OutgoingHttpHeader | undefined> {
    const kept: Record<string, OutgoingHttpHeader | undefined> = clientHeaders(headers, { upgrade: false });
    const cookies = [kept['set-cookie'] ?? []].flat().map(String).filter(draftCookie);
    delete kept['set-cookie'];
    if (cookies.length) kept['set-cookie'] = cookies;
    const policies = [kept['content-security-policy'] ?? []].flat().map(String);
    return {
      ...kept,
      'content-security-policy': [...policies, `frame-ancestors ${shellOrigin}`],
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    };
  }

  gateway.addHook('onRequest', async (request, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', `frame-ancestors ${shellOrigin}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer');
    if (!previewKeyOf(request.headers.host, domain)) return page(reply, shellOrigin, 404, 'There is nothing here');
    if (request.headers['service-worker'] === 'script')
      return page(reply, shellOrigin, 403, 'Drafts cannot install service workers');
  });

  // Routes go in plugins after the rate limit so its global hook reaches them.
  gateway.register(async routes => {
    routes.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 4_096 },
      (_request, body, done) => done(null, new URLSearchParams(body as string)),
    );

    routes.post(previewEnterPath, async (request, reply) => {
      const ticket = request.body instanceof URLSearchParams ? request.body.get('ticket') : null;
      const redeemed = ticket ? await dependencies.redeem(keyOf(request), ticket) : null;
      if (!redeemed)
        return page(
          reply,
          shellOrigin,
          403,
          'This link has expired. Open the draft again from TulipFarm.',
          notify(shellOrigin, expiredMessage),
        );
      reply.header(
        'Set-Cookie',
        `${previewCookie}=${redeemed.token}; Path=/; Max-Age=${previewSessionSeconds}; Secure; HttpOnly; SameSite=None; Partitioned`,
      );
      return page(
        reply,
        shellOrigin,
        200,
        'Opening draft',
        `fetch(${JSON.stringify(previewCheckPath)}, { credentials: 'same-origin' })
    .then(response => { if (!response.ok) throw new Error('blocked'); window.location.replace('/'); })
    .catch(() => { ${notify(shellOrigin, blockedMessage)} });`,
      );
    });

    routes.get(previewCheckPath, async (request, reply) => {
      const session = await sessionOf(request.headers);
      return reply.code(session && (await dependencies.enabled(session.workspaceId)) ? 204 : 401).send();
    });
  });

  gateway.register(async routes => {
    // Bodies stream to a draft's server untouched.
    routes.removeAllContentTypeParsers();
    routes.addContentTypeParser('*', (_request, _payload, done) => done(null));

    routes.route({
      method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      url: '/*',
      exposeHeadRoute: false,
      async handler(request, reply) {
        // A page on another site cannot make a draft act for its editor.
        if (!safeMethods.has(request.method) && request.headers.origin !== `${request.protocol}://${request.host}`)
          return page(reply, shellOrigin, 403, 'This request came from another site');
        const found = await access(request.headers);
        if (found.kind === 'denied') return page(reply, shellOrigin, found.status, found.title);
        if (found.kind === 'server') {
          const { appId, hostRef } = found;
          if (hostRef === null) return page(reply, shellOrigin, 503, notRunning);
          const forwarded = await relay.request(request, reply, destination(appId, hostRef));
          if (forwarded.kind === 'answer')
            return answer(request, reply, forwarded.answer, {
              retryAfterSeconds: forwarded.retryAfterSeconds,
              frameAncestors: shellOrigin,
            });
          const { response } = forwarded;
          const stop = watch(request.headers, hostRef, () => {
            response.destroy();
            reply.raw.destroy();
          });
          reply.raw.once('close', stop);
          reply.code(response.statusCode ?? 502).headers(draftHeaders(response.headers));
          return reply.send(response);
        }
        if (request.method !== 'GET' && request.method !== 'HEAD')
          return page(reply, shellOrigin, 404, 'There is nothing here');
        if (!found.build) return page(reply, shellOrigin, 404, 'Nothing has been built yet');
        const files = await manifest(found.build);
        const path = previewFilePath(new URL(request.url, 'http://draft').pathname);
        const file = path === null ? undefined : files?.get(path);
        if (!file) return page(reply, shellOrigin, 404, 'This file is not in the draft');
        const body = await dependencies.object(`blobs/${file.sha256}`);
        if (!body) return page(reply, shellOrigin, 404, 'This file is not in the draft');
        reply.type(file.contentType).header('Content-Length', file.bytes);
        if (request.method === 'HEAD') {
          body.destroy();
          return reply.send();
        }
        return reply.send(body);
      },
    });
  });

  gateway.setNotFoundHandler((_request, reply) => page(reply, shellOrigin, 404, 'There is nothing here'));
  // Anything that fails, such as an unreachable database, denies the request rather than serving it.
  gateway.setErrorHandler((error, request, reply) => {
    if (requestBoundaryError(error, reply)) return;
    if (!(error instanceof AppHostUnavailableError)) request.log.error({ err: error }, 'Draft request failed');
    return page(reply, shellOrigin, 503, 'The draft could not be loaded');
  });

  /** Forwards a WebSocket handshake to a draft's server, and closes it once the session loses access. */
  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, client: Client) {
    socket.on('error', () => socket.destroy());
    if (!relay.allowUpgrade(client.address)) return rawAnswer(socket, 'rate-limited');
    if (request.headers.origin !== `${client.protocol}://${client.host}`) return rawStatus(socket, 403);
    let found: Access;
    try {
      found = await access(request.headers);
    } catch (error) {
      gateway.log.error({ err: error }, 'Draft upgrade failed');
      return rawStatus(socket, 503);
    }
    if (found.kind === 'denied') return rawStatus(socket, found.status);
    if (found.kind !== 'server') return rawStatus(socket, 404);
    const { appId, hostRef } = found;
    if (hostRef === null) return rawStatus(socket, 503);
    const app = await relay.upgrade(request, socket, head, client, destination(appId, hostRef));
    if (!app) return;
    const stop = watch(request.headers, hostRef, () => {
      app.unpipe(socket);
      socket.unpipe(app);
      socket.end(policyClose);
      setTimeout(() => socket.destroy(), 1_000).unref();
    });
    socket.once('close', stop);
  }

  return { http: gateway, upgrade };
}

export type PreviewGateway = ReturnType<typeof buildPreviewGateway>;

/**
 * Hands every request for a preview host to the gateway before the host server's routes see it. Requests for other
 * hosts reach the host server unchanged.
 */
export function routePreviewHosts(app: FastifyInstance, gateway: FastifyInstance, domain: string) {
  app.addHook('onRequest', async (request, reply) => {
    if (previewKeyOf(request.headers.host, domain) === undefined) return;
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
