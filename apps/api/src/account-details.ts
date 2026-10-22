import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { accountSignInMethodsSchema } from '@tulipfarm/workspaces/contracts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';
import type { registerAuth } from './auth.ts';

export function registerAccountDetails(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    identity: Pick<Pool, 'query'>;
    googleEnabled: boolean;
  },
) {
  const validation = routeValidation({
    missing: 'Missing account details validator',
    invalid: () => new Error('invalid-request'),
  });
  app.register(async routes => {
    validation.install(routes, true);
    const user = authenticateRoutes(routes, dependencies.auth);
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(503).send({ error: 'account-details-unavailable' });
    });
    routes.get(
      '/account/sign-in-methods',
      {
        logLevel: 'silent',
        schema: {
          operationId: 'accountSignInMethods',
          querystring: validation.json(z.strictObject({})),
          response: {
            200: validation.json(accountSignInMethodsSchema),
            ...Object.fromEntries(
              [400, 401, 503].map(status => [status, validation.json(z.object({ error: z.string() }))]),
            ),
          },
        },
      },
      async request => {
        const methods: z.infer<typeof accountSignInMethodsSchema>['methods'] = ['email-link'];
        if (
          dependencies.googleEnabled &&
          (
            await dependencies.identity.query(
              "SELECT 1 FROM app.accounts WHERE user_id=$1 AND provider_id='google' LIMIT 1",
              [user(request)],
            )
          ).rowCount
        )
          methods.push('google');
        return { methods };
      },
    );
  });
}
