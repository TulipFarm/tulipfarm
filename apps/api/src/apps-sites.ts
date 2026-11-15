import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { HostHeaderPublisher } from '@tulipfarm/apps/host-header-publisher';
import { errorAttributes } from '@tulipfarm/observability';

/**
 * Answers `<name>.<domain>` from the built-in publisher before any shell route, header or session hook runs, so
 * app pages never carry the shell's cookies or policies. Hosts under `excluded` belong to the preview gateway.
 */
export function routeAppSites(
  app: FastifyInstance,
  options: { readonly publisher: HostHeaderPublisher; readonly domain: string; readonly excluded?: string | undefined },
) {
  const suffix = `.${options.domain.toLowerCase()}`;
  const excluded = options.excluded ? `.${options.excluded.toLowerCase()}` : null;
  app.addHook('onRequest', async (request, reply) => {
    const host = (request.headers.host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    if (!host.endsWith(suffix) || (excluded && (host.endsWith(excluded) || `.${host}` === excluded))) return;
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return reply.code(405).header('Allow', 'GET, HEAD').header('Cache-Control', 'no-store').send();
    const path = request.url.split('?')[0]!;
    const controller = new AbortController();
    request.raw.once('close', () => controller.abort());
    try {
      const found = await options.publisher.serve({ host, path }, controller.signal);
      if (found.kind === 'unavailable')
        return reply.code(503).header('Cache-Control', 'no-store').type('text/plain').send('This app is unavailable');
      if (found.kind === 'not-found')
        return reply.code(404).header('Cache-Control', 'no-store').type('text/plain').send('Not found');
      reply
        .code(200)
        .header('Content-Type', found.object.contentType)
        .header('Content-Length', String(found.object.bytes))
        .header('Cache-Control', 'public, max-age=60')
        .header('X-Content-Type-Options', 'nosniff');
      const { body } = found.object;
      if (request.method !== 'HEAD') return reply.send(Readable.from(body));
      if (body instanceof Readable) body.destroy();
      return reply.send();
    } catch (error) {
      request.log.error(errorAttributes(error), 'app_site_failed');
      return reply.code(503).header('Cache-Control', 'no-store').send();
    }
  });
}
