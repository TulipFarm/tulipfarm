import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import { WorkspaceMembershipDenied } from '@tulipfarm/access';
import { commonCompatibility, qualified, type createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workflowWebhookOperations } from './abuse.ts';
import { authConfig } from './auth.ts';
import type { authenticateRoutes } from './authenticated-routes.ts';
import { requestBoundaryError } from './security.ts';

const workspaceParams = z.object({ workspaceId: z.uuid() });

export function protectWorkspaceRequests(
  app: FastifyInstance,
  auth: Parameters<typeof authenticateRoutes>[1],
  runtime: Pick<ReturnType<typeof createWorkspaceRuntime>, 'hasCurrentMember' | 'transaction'>,
) {
  const protectedRequest = (request: FastifyRequest) =>
    request.routeOptions.url?.includes('/workspaces/:workspaceId') &&
    !workflowWebhookOperations.has(request.routeOptions.schema?.operationId ?? '');
  const revoked = new WeakSet<FastifyRequest>();
  const admitted = new WeakMap<FastifyRequest, string>();
  app.addHook('onError', async (request, _reply, error) => {
    if (!protectedRequest(request)) return;
    let cause: unknown = error;
    while (cause instanceof Error) {
      if (cause instanceof WorkspaceMembershipDenied && cause.userId === admitted.get(request)) {
        revoked.add(request);
        break;
      }
      cause = cause.cause;
    }
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (!revoked.has(request)) return payload;
    reply.code(404).type('application/json; charset=utf-8');
    return JSON.stringify({ error: 'not-found' });
  });
  app.addHook('onRequest', async (request, reply) => {
    if (!protectedRequest(request)) return;
    reply.header('Cache-Control', 'no-store');
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) return reply.code(401).send({ error: 'sign-in-required' });
    const expectedSession = request.headers['x-tulipfarm-expected-session'];
    if (typeof expectedSession === 'string' && expectedSession !== session.session.id)
      return reply.code(401).send({ error: 'session-changed' });
    const params = workspaceParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not-found' });
    try {
      const workspaceId = params.data.workspaceId.toLowerCase();
      const member = await runtime
        .hasCurrentMember(workspaceId, session.user.id)
        .catch(() =>
          runtime.transaction(
            workspaceId,
            commonCompatibility,
            async transaction =>
              (
                await transaction.client.query(
                  `SELECT 1 FROM ${qualified(transaction.schema, 'tf_memberships')} WHERE user_id = $1 AND removed_at IS NULL LIMIT 1`,
                  [session.user.id],
                )
              ).rowCount === 1,
          ),
        );
      if (!member) return reply.code(404).send({ error: 'not-found' });
      admitted.set(request, session.user.id);
    } catch (error) {
      if (requestBoundaryError(error, reply)) return reply;
      throw error;
    }
  });
}

export function protectBusinessRequests(app: FastifyInstance) {
  const origin = authConfig().webOrigin;
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (workflowWebhookOperations.has(request.routeOptions.schema?.operationId ?? '')) return;
    if (request.routeOptions.schema?.operationId === 'receiveSlackEventV1') return;
    if (request.routeOptions.schema?.operationId === 'receiveGitHubKnowledgeEventV1') return;
    if (request.routeOptions.schema?.operationId === 'receiveGitHubEventV1') return;
    if (request.routeOptions.schema?.operationId === 'receiveSlackActionV1') return;
    if (request.routeOptions.schema?.operationId === 'proveSlackMemberIdentityV1') return;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== origin) {
      return reply.code(403).send({ error: 'Untrusted request origin' });
    }
  });
}
