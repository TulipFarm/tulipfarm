import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { featureFlagNames } from '@tulipfarm/config/feature-flags';
import { featureFlagSnapshot } from '@tulipfarm/observability';
import type { registerAuth } from './auth.ts';

type Workspace = { id: string; name: string } | null;

const query = z.object({ workspace: z.string().trim().min(1).max(255).optional() });

// The web app reads its flags here instead of calling a flag vendor from the browser.
// A workspace is used for evaluation only when the caller is a member of it.
export function registerFeatureFlags(
  app: FastifyInstance,
  auth: { api: Pick<ReturnType<typeof registerAuth>['auth']['api'], 'getSession'> },
  workspaceFor?: (userId: string, slug: string) => Promise<Workspace>,
) {
  const error = { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] };
  const snapshot = {
    type: 'object',
    properties: Object.fromEntries(featureFlagNames.map(flag => [flag, { type: 'boolean' }])),
    required: featureFlagNames,
    additionalProperties: false,
  };
  app.get(
    '/feature-flags',
    {
      schema: {
        operationId: 'getFeatureFlagsV1',
        summary: 'Read every feature flag for the signed-in user, optionally in one of their workspaces',
        tags: ['Account'],
        querystring: {
          type: 'object',
          properties: { workspace: { type: 'string', minLength: 1, maxLength: 255, description: 'Workspace slug' } },
        },
        response: { 200: snapshot, 400: error, 401: error },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session) return reply.code(401).send({ error: 'sign-in-required' });
      const parsed = query.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid-request' });
      const user = { id: session.user.id, ...(session.user.email ? { email: session.user.email } : {}) };
      const workspace =
        parsed.data.workspace && workspaceFor ? await workspaceFor(user.id, parsed.data.workspace) : null;
      return featureFlagSnapshot(user, workspace ? { id: workspace.id, name: workspace.name } : undefined);
    },
  );
}
