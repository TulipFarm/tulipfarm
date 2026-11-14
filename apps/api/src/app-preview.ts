import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import {
  previewKeyPattern,
  previewSessionSeconds,
  type AppResult,
  type PreviewBuild,
  type PreviewSession,
} from '@tulipfarm/apps/store';
import { registerObservability } from './observability.ts';
import { requestBoundaryError, securityServerOptions } from './security.ts';

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
  readonly build: (session: PreviewSession) => Promise<AppResult<{ readonly build: PreviewBuild | null }>>;
  /** Reads an object from the apps bucket, or null when it is missing. */
  readonly object: (key: string) => Promise<Readable | null>;
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

/**
 * The gateway that serves draft previews on their own hosts. It is a separate server from the API, so no API route,
 * cookie or CORS rule ever answers on a preview host.
 */
export function buildPreviewGateway(dependencies: PreviewGatewayDependencies): FastifyInstance {
  const { domain, shellOrigin } = dependencies;
  const gateway = Fastify({
    ...securityServerOptions(),
    logger: { serializers: { err: () => ({ type: 'Error', message: 'request_failed', stack: '' }), req: () => ({}) } },
    logController: new LogController({ disableRequestLogging: true }),
  });
  registerObservability(gateway);
  gateway.register(rateLimit, { global: true, max: 1_200, timeWindow: 60_000, cache: 10_000 });
  gateway.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 4_096 },
    (_request, body, done) => done(null, new URLSearchParams(body as string)),
  );

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
  async function sessionOf(request: FastifyRequest) {
    const token = cookieValue(request.headers.cookie, previewCookie);
    return token ? dependencies.session(keyOf(request), token) : null;
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

  gateway.post(previewEnterPath, async (request, reply) => {
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

  gateway.get(previewCheckPath, async (request, reply) => {
    const session = await sessionOf(request);
    return reply.code(session && (await dependencies.enabled(session.workspaceId)) ? 204 : 401).send();
  });

  gateway.route({
    method: ['GET', 'HEAD'],
    url: '/*',
    async handler(request, reply) {
      const session = await sessionOf(request);
      if (!session)
        return page(reply, shellOrigin, 401, 'This session has ended. Open the draft again from TulipFarm.');
      if (!(await dependencies.enabled(session.workspaceId)))
        return page(reply, shellOrigin, 404, 'There is nothing here');
      const access = await dependencies.build(session);
      if (!access.ok)
        return access.failure.code === 'forbidden'
          ? page(reply, shellOrigin, 403, 'You can no longer edit this app')
          : page(reply, shellOrigin, 404, 'There is nothing here');
      if (!access.build) return page(reply, shellOrigin, 404, 'Nothing has been built yet');
      const files = await manifest(access.build);
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

  gateway.setNotFoundHandler((_request, reply) => page(reply, shellOrigin, 404, 'There is nothing here'));
  gateway.setErrorHandler((error, request, reply) => {
    if (requestBoundaryError(error, reply)) return;
    request.log.error({ err: error }, 'Draft request failed');
    return page(reply, shellOrigin, 500, 'The draft could not be loaded');
  });
  return gateway;
}

/**
 * Hands every request for a preview host to the gateway before the API sees it. Requests for other hosts reach the
 * API unchanged.
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
