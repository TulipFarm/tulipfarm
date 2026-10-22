import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { registerAuth } from './auth.ts';

export function authenticateRoutes(
  routes: FastifyInstance,
  auth: { api: Pick<ReturnType<typeof registerAuth>['auth']['api'], 'getSession'> },
  options: {
    origin?: string | (() => string);
    publicOperation?: string;
    userSchema?: z.ZodType<string>;
  } = {},
) {
  const users = new WeakMap<FastifyRequest, string>();
  routes.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (options.publicOperation && request.routeOptions.schema?.operationId === options.publicOperation) return;
    if (options.origin && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = typeof options.origin === 'function' ? options.origin() : options.origin;
      if (request.headers.origin !== origin) return reply.code(403).send({ error: 'untrusted-origin' });
    }
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) return reply.code(401).send({ error: 'sign-in-required' });
    const expectedSession = request.headers['x-tulipfarm-expected-session'];
    if (typeof expectedSession === 'string' && expectedSession !== session.session.id)
      return reply.code(401).send({ error: 'session-changed' });
    users.set(request, session.user.id);
  });
  return (request: FastifyRequest) => (options.userSchema ?? z.string()).parse(users.get(request));
}
