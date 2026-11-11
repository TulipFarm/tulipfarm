import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { registerAuth } from './auth.ts';

export const sessionIndependentOperations: ReadonlySet<string> = new Set([
  'getApiIndex',
  'getWorkspaceMcpClientMetadata',
  'getLivenessV1',
  'getHealthV1',
  'publicGuideOptionsV1',
  'publicGuideSessionV1',
  'publicGuideMessageV1',
  'publicGuideSignupV1',
  'publicGuideGoogleV1',
  'checkOnboardingUrlV1',
  'saveOnboardingV1',
  'completeSlackOAuthV1',
  'completeAtlassianAccountV1',
  'completeSocialAccountV1',
  'completeGitHubAccountV1',
  'completeGoogleWorkspaceOAuthV1',
  'completeWorkspaceMcpOAuthV1',
  'proveSlackMemberIdentityQueryV1',
  'proveSlackMemberIdentityV1',
  'receiveSlackEventV1',
  'receiveSlackActionV1',
  'receiveGitHubKnowledgeEventV1',
  'receiveGitHubEventV1',
  'receiveWorkflowWebhookV1',
  'receiveWorkflowTriggerWebhookV1',
]);

const sessionIndependentRoutes = new Set([
  '/v1/auth/*',
  '/v1/auth/options',
  '/v1/dev/sign-in-link',
  '/v1/dev/session',
  '/v1/viewer',
]);

export function rejectChangedSession(
  request: FastifyRequest,
  reply: FastifyReply,
  session: { session: { id: string } },
) {
  const expectedSession = request.headers['x-tulipfarm-expected-session'];
  if (typeof expectedSession === 'string' && expectedSession !== session.session.id)
    return reply.code(401).send({ error: 'session-changed' });
}

export function protectExpectedSession(routes: FastifyInstance, auth: Parameters<typeof authenticateRoutes>[1]) {
  routes.addHook('onRequest', async (request, reply) => {
    if (typeof request.headers['x-tulipfarm-expected-session'] !== 'string') return;
    const url = request.routeOptions.url;
    if (
      !url ||
      sessionIndependentRoutes.has(url) ||
      sessionIndependentOperations.has(request.routeOptions.schema?.operationId ?? '')
    )
      return;
    reply.header('Cache-Control', 'no-store');
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) return reply.code(401).send({ error: 'sign-in-required' });
    return rejectChangedSession(request, reply, session);
  });
}

export function authenticateRoutes(
  routes: FastifyInstance,
  auth: { api: Pick<ReturnType<typeof registerAuth>['auth']['api'], 'getSession'> },
  options: {
    origin?: string | (() => string);
    publicOperation?: ReadonlySet<string>;
    userSchema?: z.ZodType<string>;
  } = {},
) {
  const users = new WeakMap<FastifyRequest, string>();
  routes.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (options.publicOperation?.has(request.routeOptions.schema?.operationId ?? '')) return;
    if (options.origin && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = typeof options.origin === 'function' ? options.origin() : options.origin;
      if (request.headers.origin !== origin) return reply.code(403).send({ error: 'untrusted-origin' });
    }
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) return reply.code(401).send({ error: 'sign-in-required' });
    if (rejectChangedSession(request, reply, session)) return reply;
    users.set(request, session.user.id);
  });
  return (request: FastifyRequest) => (options.userSchema ?? z.string()).parse(users.get(request));
}
