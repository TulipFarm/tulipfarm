import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccessDenied, SourceAuthorizationUnavailable, uuidSchema } from '@tulipfarm/access';
import { createAgentAuthoringAssistance } from '@tulipfarm/agents/authoring-assistance';
import {
  agentAuthoringLimits,
  AgentAuthoringError,
  agentAuthoringErrorSchema,
  improveAgentInstructionsSchema,
  improvedAgentInstructionsSchema,
  previewAgentChatSchema,
  agentPreviewReplySchema,
} from '@tulipfarm/agents/authoring-assistance-contracts';
import type { ModelFamilyEligibility } from '@tulipfarm/agents/model-policy';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { modelEnvironment } from './model-environment.ts';
import { authConfig } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

export function registerAgentAuthoringAssistance(
  app: FastifyInstance,
  dependencies: {
    runtime: WorkspaceRuntime;
    auth: Parameters<typeof authenticateRoutes>[1];
    modelFamilyEligibility: ModelFamilyEligibility;
    environment?: ReturnType<typeof modelEnvironment>;
    defaultFamilyId?: string;
    fetcher?: typeof fetch;
  },
) {
  const environment = dependencies.environment === undefined ? modelEnvironment() : dependencies.environment;
  const defaultFamilyId = dependencies.defaultFamilyId ?? environment?.defaultFamily;
  const service = createAgentAuthoringAssistance({
    runtime: dependencies.runtime,
    eligible: dependencies.modelFamilyEligibility,
    environment,
    ...(defaultFamilyId ? { defaultFamilyId } : {}),
    ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
  });
  app.register(async routes => {
    const validation = routeValidation({
      missing: 'Missing agent authoring validator',
      invalid: () => new AgentAuthoringError('invalid-request'),
    });
    validation.install(routes, true);
    const { json } = validation;
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    const params = z.strictObject({ workspaceId: uuidSchema });
    const errors = Object.fromEntries(
      [400, 401, 402, 403, 404, 409, 413, 429, 502, 503, 504].map(status => [
        status,
        json(z.object({ error: z.string() })),
      ]),
    );
    routes.setErrorHandler((error, request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof SourceAuthorizationUnavailable)
        return reply.code(503).send({ error: 'authoring-unavailable' });
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'agent-authoring-not-found' });
      if (error instanceof StorageUnavailableError)
        return reply.code(error.code === 'disabled' ? 404 : 503).send({ error: 'authoring-unavailable' });
      if (error instanceof AgentAuthoringError) {
        const status =
          error.code === 'invalid-request'
            ? 400
            : error.code === 'input-too-large'
              ? 413
              : error.code === 'credits-exhausted'
                ? 402
                : error.code === 'workspace-disabled'
                  ? 403
                  : ['authoring-busy', 'provider-rate-limit'].includes(error.code)
                    ? 429
                    : error.code === 'timed-out'
                      ? 504
                      : [
                            'idempotency-conflict',
                            'request-already-dispatched',
                            'stale-snapshot',
                            'cancelled',
                            'model-family-unavailable',
                          ].includes(error.code)
                        ? 409
                        : [
                              'provider-unavailable',
                              'provider-quota',
                              'provider-authentication',
                              'provider-permission',
                              'credits-settlement-unavailable',
                              'authoring-unavailable',
                            ].includes(error.code)
                          ? 503
                          : 502;
        return reply.code(status).send(agentAuthoringErrorSchema.parse({ error: error.code }));
      }
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      request.log.error(
        {
          operation: request.routeOptions.schema?.operationId,
          workspaceId: params.safeParse(request.params).data?.workspaceId,
          'error.type':
            error instanceof TypeError
              ? 'TypeError'
              : error instanceof RangeError
                ? 'RangeError'
                : error instanceof Error
                  ? 'Error'
                  : 'unknown',
        },
        'Agent authoring request failed',
      );
      return reply.code(503).send({ error: 'authoring-unavailable' });
    });
    async function run(
      request: FastifyRequest,
      reply: FastifyReply,
      operation: typeof service.improve | typeof service.preview,
    ) {
      const controller = new AbortController();
      const abort = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      request.raw.on('aborted', abort);
      reply.raw.on('close', abort);
      try {
        if (request.raw.aborted || reply.raw.destroyed) controller.abort();
        return await operation(
          params.parse(request.params).workspaceId,
          user(request),
          request.body,
          controller.signal,
        );
      } finally {
        request.raw.off('aborted', abort);
        reply.raw.off('close', abort);
      }
    }
    const base = '/workspaces/:workspaceId/agents/authoring';
    routes.post(
      `${base}/improve-instructions`,
      {
        bodyLimit: agentAuthoringLimits.requestBytes,
        schema: {
          operationId: 'improveAgentInstructionsV1',
          tags: ['Agents'],
          summary: 'Request a paid Luna instruction suggestion without saving it',
          params: json(params),
          body: json(improveAgentInstructionsSchema),
          response: { 200: json(improvedAgentInstructionsSchema), ...errors },
        },
      },
      (request, reply) => run(request, reply, service.improve),
    );
    routes.post(
      `${base}/test-chat`,
      {
        bodyLimit: agentAuthoringLimits.requestBytes,
        schema: {
          operationId: 'previewUnsavedAgentV1',
          tags: ['Agents'],
          summary: 'Request a paid, tool-free reply from an immutable unsaved agent snapshot',
          params: json(params),
          body: json(previewAgentChatSchema),
          response: { 200: json(agentPreviewReplySchema), ...errors },
        },
      },
      (request, reply) => run(request, reply, service.preview),
    );
  });
}
