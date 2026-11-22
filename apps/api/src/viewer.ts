import type { FastifyInstance } from 'fastify';
import type { getLastWorkspace } from '@tulipfarm/workspaces/store';
import { authConfig, type registerAuth } from './auth.ts';
import { requestSession } from './request-session.ts';

export function registerViewer(
  app: FastifyInstance,
  auth: { api: Pick<ReturnType<typeof registerAuth>['auth']['api'], 'getSession'> },
  lastWorkspaceFor: (userId: string) => ReturnType<typeof getLastWorkspace>,
) {
  const { webOrigin, websiteOrigin } = authConfig();
  const origins = [webOrigin, websiteOrigin];
  app.route({
    method: ['GET', 'HEAD', 'OPTIONS'],
    url: '/viewer',
    config: { cors: { origin: origins, credentials: true, methods: ['GET', 'HEAD', 'OPTIONS'], allowedHeaders: [] } },
    schema: { hide: true },
    async handler(request, reply) {
      reply.header('Cache-Control', 'no-store');
      if (request.headers.origin && !origins.includes(request.headers.origin)) {
        return reply.code(403).send({ error: 'untrusted-origin' });
      }
      if (request.method === 'OPTIONS') return reply.code(204).send();
      const session = await requestSession(request, auth);
      const user = session
        ? { name: session.user.name, email: session.user.email, image: session.user.image ?? null }
        : null;
      const workspace = session ? await lastWorkspaceFor(session.user.id) : null;
      return {
        authenticated: user !== null,
        user,
        lastWorkspace: workspace ? { id: workspace.id, name: workspace.name } : null,
        appUrl: workspace ? `${webOrigin}/${encodeURIComponent(workspace.slug)}` : `${webOrigin}/`,
      };
    },
  });
}
