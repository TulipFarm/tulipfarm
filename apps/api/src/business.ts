import type { FastifyInstance } from 'fastify';
import { authConfig } from './auth.ts';

export function protectBusinessRequests(app: FastifyInstance) {
  const origin = authConfig().webOrigin;
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.routeOptions.schema?.operationId === 'receiveWorkflowWebhookV1') return;
    if (request.routeOptions.schema?.operationId === 'receiveSlackEventV1') return;
    if (request.routeOptions.schema?.operationId === 'receiveSlackActionV1') return;
    if (request.routeOptions.schema?.operationId === 'proveSlackMemberIdentityV1') return;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== origin) {
      return reply.code(403).send({ error: 'Untrusted request origin' });
    }
  });
}
