import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { buildPreviewGateway, routePreviewHosts, type PreviewGatewayDependencies } from './preview.ts';

export type GatewayOptions = {
  readonly preview: PreviewGatewayDependencies;
  readonly serverOptions: FastifyServerOptions;
  readonly identity: { readonly version: string; readonly commit: string };
};

/**
 * The gateway process. Preview hosts go to the preview gateway; any other host, such as a load balancer health check
 * that addresses the task by IP, sees only the liveness route.
 */
export function buildGateway({ preview, serverOptions, identity }: GatewayOptions): FastifyInstance {
  const server = Fastify({
    ...serverOptions,
    logger: { serializers: { err: () => ({ type: 'Error', message: 'request_failed', stack: '' }), req: () => ({}) } },
    logController: new LogController({ disableRequestLogging: true }),
  });
  routePreviewHosts(server, buildPreviewGateway(preview, serverOptions), preview.domain);
  server.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
  });
  server.get('/health/live', async () => ({ status: 'ok', ...identity }));
  server.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not-found' }));
  return server;
}
