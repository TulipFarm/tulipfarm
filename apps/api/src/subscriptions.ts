import type { FastifyError, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied, uuidSchema } from '@tulipfarm/access';
import {
  SubscriptionError,
  subscriptionGrantSchema,
  subscriptionProviders,
  type Subscriptions,
} from '@tulipfarm/integrations/subscriptions';
import { authenticateRoutes } from './authenticated-routes.ts';
import { authConfig, type registerAuth } from './auth.ts';
import { routeValidation } from './route-validation.ts';

const errorSchema = z.object({ error: z.string() });
const workspaceParams = z.strictObject({ workspaceId: uuidSchema });
const connectionParams = workspaceParams.extend({ connectionId: uuidSchema });
const subscriptionSchema = z.object({
  connectionId: z.uuid(),
  provider: z.enum(subscriptionProviders),
  ownerMembershipId: z.uuid(),
  account: z.string().nullable(),
  state: z.enum(['connected', 'plan-disabled', 'reconnect-required', 'signed-out']),
  canShare: z.boolean(),
  grants: z.array(subscriptionGrantSchema).nullable(),
});
const listSchema = z.object({ subscriptions: z.array(subscriptionSchema) });
const grantsBody = z.strictObject({ grants: z.array(subscriptionGrantSchema).max(200) });
const validation = routeValidation({
  target: 'openapi-3.0',
  missing: 'Missing subscription validator',
  invalid: () => new Error('invalid-request'),
});
const { json } = validation;
const statuses: Record<SubscriptionError['code'], number> = {
  'not-found': 404,
  'not-connected': 409,
  'invalid-grant': 400,
};
function schema(operationId: string, response: z.ZodType) {
  const error = json(errorSchema);
  return {
    operationId,
    tags: ['Subscriptions'],
    response: { 200: json(response), 400: error, 401: error, 403: error, 404: error, 409: error, 503: error },
  };
}

/** Routes for listing the AI plans a member can see and sharing them with members, teams or the workspace. */
export function registerSubscriptions(
  app: FastifyInstance,
  auth: { api: Pick<ReturnType<typeof registerAuth>['auth']['api'], 'getSession'> },
  subscriptions: Subscriptions | null,
) {
  if (!subscriptions) return;
  app.register(async routes => {
    validation.install(routes, true);
    const user = authenticateRoutes(routes, auth, { origin: () => authConfig().webOrigin });
    routes.setErrorHandler<FastifyError>((error, _request, reply) => {
      if (error instanceof AccessDenied) return reply.code(403).send({ error: 'subscription-access-denied' });
      if (error instanceof SubscriptionError)
        return reply.code(statuses[error.code]).send({ error: `subscription-${error.code}` });
      if (error.statusCode === 400 || error.validation || error instanceof z.ZodError)
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(503).send({ error: 'unavailable' });
    });
    routes.get(
      '/workspaces/:workspaceId/subscriptions',
      { schema: { ...schema('listSubscriptionsV1', listSchema), params: json(workspaceParams) } },
      async request => ({
        subscriptions: await subscriptions.list(workspaceParams.parse(request.params).workspaceId, user(request)),
      }),
    );
    routes.put(
      '/workspaces/:workspaceId/subscriptions/:connectionId/grants',
      {
        schema: {
          ...schema('shareSubscriptionV1', grantsBody),
          params: json(connectionParams),
          body: json(grantsBody),
        },
      },
      async request => {
        const { workspaceId, connectionId } = connectionParams.parse(request.params);
        const { grants } = grantsBody.parse(request.body);
        return { grants: await subscriptions.share(workspaceId, user(request), connectionId, grants) };
      },
    );
  });
}
