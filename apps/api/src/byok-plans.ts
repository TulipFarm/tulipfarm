import type { FastifyError, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied, uuidSchema } from '@tulipfarm/access';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import {
  byokPlanProviders,
  ByokPlanError,
  createByokPlans,
  type ByokPlanProvider,
  type ByokRuntime,
} from '@tulipfarm/integrations/byok-plans';
import { authenticateRoutes } from './authenticated-routes.ts';
import { authConfig, type registerAuth } from './auth.ts';
import { routeValidation } from './route-validation.ts';

export type ByokPlans = ReturnType<typeof createByokPlans>;

const providerSchema = z.enum(byokPlanProviders);
const connectParams = z.strictObject({ workspaceId: uuidSchema, provider: providerSchema });
const connectionParams = z.strictObject({
  workspaceId: uuidSchema,
  provider: providerSchema,
  connectionId: uuidSchema,
});
const connectBody = z.strictObject({
  apiKey: z.string().min(1).max(2048),
  endpoint: z.string().max(500).optional(),
  label: z.string().max(120).optional(),
  connectionId: uuidSchema.optional(),
});
const refreshBody = z.strictObject({ connectionId: uuidSchema });
const errorSchema = z.object({ error: z.string(), message: z.string().optional() });
const statusSchema = z.object({
  connection: z.object({
    connectionId: z.uuid(),
    provider: providerSchema,
    state: z.enum(['connected', 'reconnect-required', 'signed-out']),
    account: z.string().nullable(),
    endpoint: z.string().nullable(),
    models: z.array(
      z.object({
        slug: z.string(),
        label: z.string(),
        maxInputTokens: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        imageInput: z.boolean().optional(),
      }),
    ),
    createdAt: z.string(),
  }),
});
const okSchema = z.object({ ok: z.literal(true) });
const validation = routeValidation({
  target: 'openapi-3.0',
  missing: 'Missing BYOK plan validator',
  invalid: () => new Error('invalid-request'),
});
const { json } = validation;

function schema(operationId: string, response: z.ZodType) {
  const error = json(errorSchema);
  return {
    operationId,
    tags: ['Subscriptions'],
    response: {
      200: json(response),
      400: error,
      401: error,
      403: error,
      404: error,
      409: error,
      429: error,
      502: error,
      503: error,
    },
  };
}

export function byokPlansFromEnvironment(runtime: ByokRuntime | null, env: NodeJS.ProcessEnv = process.env) {
  if (!runtime) return null;
  try {
    return createByokPlans({ runtime, keyring: integrationCredentialKeyring(env), env });
  } catch {
    return null;
  }
}

function errorResponse(error: ByokPlanError): { status: number; body: { error: string; message: string } } {
  switch (error.code) {
    case 'key-invalid':
      return { status: 400, body: { error: error.code, message: 'Enter a valid API key.' } };
    case 'endpoint-required':
      return {
        status: 400,
        body: { error: error.code, message: 'Enter the API base URL for this OpenAI-compatible provider.' },
      };
    case 'endpoint-invalid':
      return {
        status: 400,
        body: { error: error.code, message: `Invalid endpoint URL: ${error.detail ?? 'must be an HTTPS URL'}.` },
      };
    case 'key-rejected':
      return {
        status: 400,
        body: { error: error.code, message: 'The provider rejected this API key. Check the key and try again.' },
      };
    case 'no-models':
      return {
        status: 400,
        body: { error: error.code, message: 'No chat-capable models were returned by this provider.' },
      };
    case 'too-many-accounts':
      return {
        status: 409,
        body: { error: error.code, message: 'You can connect up to 5 keys per provider.' },
      };
    case 'not-connected':
      return { status: 404, body: { error: error.code, message: 'Connection not found.' } };
    case 'reconnect-required':
      return {
        status: 409,
        body: { error: error.code, message: 'Reconnect this API key before refreshing its models.' },
      };
    case 'rate-limited':
      return {
        status: 429,
        body: { error: error.code, message: 'The provider rate-limited model discovery. Try again shortly.' },
      };
    case 'unavailable':
      return {
        status: 502,
        body: {
          error: error.code,
          message: error.detail ? `Could not list models (${error.detail}).` : 'Provider is temporarily unavailable.',
        },
      };
  }
}

export function registerByokPlans(
  app: FastifyInstance,
  auth: { api: Pick<ReturnType<typeof registerAuth>['auth']['api'], 'getSession'> },
  byok: ByokPlans | null,
) {
  app.register(async scope => {
    validation.install(scope, true);
    const user = authenticateRoutes(scope, auth, { origin: () => authConfig().webOrigin });
    scope.setErrorHandler<FastifyError>((error, _request, reply) => {
      if (error instanceof AccessDenied) return reply.code(403).send({ error: 'forbidden' });
      if (error instanceof ByokPlanError) {
        const mapped = errorResponse(error);
        return reply.code(mapped.status).send(mapped.body);
      }
      if (error.statusCode === 400 || error.validation || error instanceof z.ZodError)
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(503).send({ error: 'unavailable' });
    });

    scope.post(
      '/workspaces/:workspaceId/byok-plans/:provider/connect',
      {
        schema: {
          ...schema('connectByokPlanV1', statusSchema),
          params: json(connectParams),
          body: json(connectBody),
        },
      },
      async (request, reply) => {
        if (!byok) return reply.code(503).send({ error: 'unavailable' });
        const params = connectParams.parse(request.params);
        const body = connectBody.parse(request.body);
        const connection = await byok.connect(params.workspaceId, user(request), params.provider, body);
        return reply.code(200).send({ connection });
      },
    );

    scope.post(
      '/workspaces/:workspaceId/byok-plans/:provider/refresh',
      {
        schema: {
          ...schema('refreshByokPlanV1', statusSchema),
          params: json(connectParams),
          body: json(refreshBody),
        },
      },
      async (request, reply) => {
        if (!byok) return reply.code(503).send({ error: 'unavailable' });
        const params = connectParams.parse(request.params);
        const body = refreshBody.parse(request.body);
        const connection = await byok.refreshModels(
          params.workspaceId,
          user(request),
          params.provider,
          body.connectionId,
        );
        return reply.code(200).send({ connection });
      },
    );

    scope.delete(
      '/workspaces/:workspaceId/byok-plans/:provider/connections/:connectionId',
      {
        schema: {
          ...schema('disconnectByokPlanV1', okSchema),
          params: json(connectionParams),
        },
      },
      async (request, reply) => {
        if (!byok) return reply.code(503).send({ error: 'unavailable' });
        const params = connectionParams.parse(request.params);
        await byok.disconnect(
          params.workspaceId,
          user(request),
          params.provider as ByokPlanProvider,
          params.connectionId,
        );
        return reply.code(200).send({ ok: true });
      },
    );
  });
}
