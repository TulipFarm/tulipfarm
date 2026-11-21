import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AccessDenied } from '@tulipfarm/access';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import {
  type createPersonalMemoryService,
  personalMemorySchema,
  savePersonalMemorySchema,
  deletePersonalMemorySchema,
  memoryProposalsSchema,
  MemoryProposalNotFound,
  MemoryProposalOutdated,
  PersonalMemoryConflict,
  PersonalMemoryRejected,
  PersonalMemoryUnavailable,
} from '@tulipfarm/conversations/personal-memory';
import { authConfig, type registerAuth } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

const params = z.strictObject({ workspaceId: z.uuid() });
const proposalParams = z.strictObject({ workspaceId: z.uuid(), proposalId: z.uuid() });
const validation = routeValidation({
  missing: 'Missing personal memory request validator',
  invalid: () => new Error('invalid-request'),
});
const failure = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
  additionalProperties: false,
};
function schema(
  operationId: string,
  summary: string,
  body?: z.ZodType,
  options: { params?: z.ZodType; response?: z.ZodType } = {},
) {
  return {
    operationId,
    summary,
    tags: ['Personal memory'],
    params: validation.json(options.params ?? params),
    ...(body ? { body: validation.json(body) } : {}),
    response: {
      200: validation.json(options.response ?? personalMemorySchema),
      400: failure,
      401: failure,
      403: failure,
      404: failure,
      409: failure,
      413: failure,
      422: failure,
      500: failure,
      503: failure,
    },
  };
}

export function registerPersonalMemory(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    service: ReturnType<typeof createPersonalMemoryService>;
  },
) {
  app.register(async routes => {
    validation.install(routes);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'personal-memory-not-found' });
      if (error instanceof MemoryProposalNotFound) return reply.code(404).send({ error: error.message });
      if (error instanceof MemoryProposalOutdated) return reply.code(409).send({ error: error.message });
      if (error instanceof PersonalMemoryConflict) return reply.code(409).send({ error: error.message });
      if (error instanceof StorageUnavailableError || error instanceof PersonalMemoryUnavailable)
        return reply.code(503).send({ error: 'personal-memory-unavailable' });
      if (error instanceof PersonalMemoryRejected) return reply.code(422).send({ error: 'personal-memory-rejected' });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(500).send({ error: 'personal-memory-operation-failed' });
    });
    const base = '/workspaces/:workspaceId/personal-memory';
    routes.get(base, { schema: schema('getPersonalMemoryV1', 'Read your personal memory') }, request =>
      dependencies.service.read(params.parse(request.params).workspaceId, user(request)),
    );
    routes.put(
      base,
      { schema: schema('savePersonalMemoryV1', 'Replace your personal memory', savePersonalMemorySchema) },
      request => dependencies.service.save(params.parse(request.params).workspaceId, user(request), request.body),
    );
    routes.delete(
      base,
      {
        schema: schema(
          'deletePersonalMemoryV1',
          'Delete your personal memory. It can be restored for 7 days.',
          deletePersonalMemorySchema,
        ),
      },
      request => dependencies.service.delete(params.parse(request.params).workspaceId, user(request), request.body),
    );
    routes.post(
      `${base}/undo`,
      {
        schema: schema(
          'undoPersonalMemoryV1',
          'Undo your last personal memory change, or restore deleted memory.',
          deletePersonalMemorySchema,
        ),
      },
      request => dependencies.service.undo(params.parse(request.params).workspaceId, user(request), request.body),
    );
    routes.post(
      `${base}/forget`,
      {
        schema: schema(
          'forgetPersonalMemoryV1',
          'Permanently erase your personal memory, including its history. This cannot be undone.',
          deletePersonalMemorySchema,
        ),
      },
      request => dependencies.service.forget(params.parse(request.params).workspaceId, user(request), request.body),
    );
    const proposals = `${base}/proposals`;
    routes.get(
      proposals,
      {
        schema: schema('listMemoryProposalsV1', 'List edits suggested for your personal memory.', undefined, {
          response: memoryProposalsSchema,
        }),
      },
      request => dependencies.service.proposals(params.parse(request.params).workspaceId, user(request)),
    );
    for (const [action, operationId, summary] of [
      ['confirm', 'confirmMemoryProposalV1', 'Apply a suggested edit to your personal memory'],
      ['dismiss', 'dismissMemoryProposalV1', 'Discard a suggested edit'],
      [
        'refresh',
        'refreshMemoryProposalV1',
        'Update an outdated suggested edit to your current memory, if it still fits',
      ],
    ] as const)
      routes.post(
        `${proposals}/:proposalId/${action}`,
        {
          schema: schema(operationId, summary, undefined, { params: proposalParams, response: memoryProposalsSchema }),
        },
        request => {
          const { workspaceId, proposalId } = proposalParams.parse(request.params);
          const service = dependencies.service;
          return action === 'confirm'
            ? service.confirmProposal(workspaceId, user(request), proposalId)
            : action === 'dismiss'
              ? service.dismissProposal(workspaceId, user(request), proposalId)
              : service.refreshProposal(workspaceId, user(request), proposalId);
        },
      );
  });
}
