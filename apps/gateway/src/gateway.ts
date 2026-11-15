import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { buildPreviewGateway, previewKeyOf, routePreviewHosts, type PreviewGatewayDependencies } from './preview.ts';
import { appNameOf, buildPublicAppsGateway, routePublicAppHosts, type PublicAppsDependencies } from './public-apps.ts';
import { rawAnswer, upgradeClient } from './relay.ts';

export type GatewayOptions = {
  readonly preview: PreviewGatewayDependencies;
  /** Null leaves public app hosts unanswered. */
  readonly apps: PublicAppsDependencies | null;
  readonly serverOptions: FastifyServerOptions;
  readonly identity: { readonly version: string; readonly commit: string };
};

/**
 * The gateway process. Preview hosts go to the preview gateway and public app hosts to the public apps gateway; any
 * other host, such as a load balancer health check that addresses the task by IP, sees only the liveness route.
 */
export function buildGateway({ preview, apps, serverOptions, identity }: GatewayOptions): FastifyInstance {
  const server = Fastify({
    ...serverOptions,
    logger: { serializers: { err: () => ({ type: 'Error', message: 'request_failed', stack: '' }), req: () => ({}) } },
    logController: new LogController({ disableRequestLogging: true }),
  });
  const drafts = buildPreviewGateway(preview, serverOptions);
  routePreviewHosts(server, drafts.http, preview.domain);
  const publicApps = apps ? buildPublicAppsGateway(apps, serverOptions) : null;
  if (apps && publicApps) routePublicAppHosts(server, publicApps.http, apps.domain);
  server.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const client = upgradeClient(request, serverOptions.trustProxy);
    if (previewKeyOf(request.headers.host, preview.domain)) return void drafts.upgrade(request, socket, head, client);
    if (apps && publicApps && appNameOf(request.headers.host, apps.domain) !== undefined)
      return void publicApps.upgrade(request, socket, head, client);
    rawAnswer(socket, 'not-found');
  });
  server.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
  });
  server.get('/health/live', async () => ({ status: 'ok', ...identity }));
  server.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not-found' }));
  return server;
}
