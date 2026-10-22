import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { AccountError } from '@tulipfarm/atlassian/accounts';
import {
  OperationError,
  approvalDecisionSchema,
  createSourceSchema,
  sourceSchema,
  operationRequestSchema,
  proposalRequestSchema,
  proposalSchema,
  receiptSchema,
  untrustedResultSchema,
  type createAtlassianOperations,
} from '@tulipfarm/atlassian/operations';
import type { createAtlassianApproval } from '@tulipfarm/atlassian/operation-approval';
import { authConfig, type registerAuth } from './auth.ts';
import { routeValidation } from './route-validation.ts';

const errorSchema = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
  additionalProperties: false,
};
const workspaceParams = z.strictObject({ workspaceId: z.uuid() });
const sourceParams = workspaceParams.extend({ sourceId: z.uuid() });
const proposalParams = workspaceParams.extend({ proposalId: z.uuid() });
const validation = routeValidation({
  target: 'openapi-3.0',
  missing: 'Missing operation validator',
  invalid: () => new Error('invalid-request'),
});
const { json } = validation;
const listingSchema = z.strictObject({
  sources: z.array(sourceSchema).max(100),
  mcp: z.strictObject({ enabled: z.boolean(), explanation: z.string() }),
});
function schema(operationId: string, response: z.ZodType) {
  return {
    operationId,
    tags: ['Atlassian operations'],
    response: {
      200: json(response),
      400: errorSchema,
      401: errorSchema,
      403: errorSchema,
      404: errorSchema,
      409: errorSchema,
      413: errorSchema,
      415: errorSchema,
      503: errorSchema,
    },
  };
}
export function registerAtlassianOperations(
  app: FastifyInstance,
  auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>,
  operations: ReturnType<typeof createAtlassianOperations> | null,
  approve: ReturnType<typeof createAtlassianApproval> | null,
) {
  app.register(async routes => {
    validation.install(routes, true);
    const users = new WeakMap<FastifyRequest, string>();
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');
      if (request.method !== 'GET' && request.headers.origin !== authConfig().webOrigin)
        return reply.code(403).send({ error: 'untrusted-origin' });
      const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session) return reply.code(401).send({ error: 'sign-in-required' });
      users.set(request, session.user.id);
      if (!operations) return reply.code(503).send({ error: 'operation-disabled' });
    });
    routes.setErrorHandler<FastifyError>((error, _request, reply) => {
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'operation-not-found' });
      if (error.statusCode === 400 || error.validation || error instanceof z.ZodError)
        return reply.code(400).send({ error: 'invalid-request' });
      if (error.statusCode === 413 || error.statusCode === 415)
        return reply.code(error.statusCode).send({ error: 'invalid-request' });
      if (error instanceof OperationError)
        return reply
          .code(error.code === 'operation-disabled' || error.code === 'operation-unavailable' ? 503 : 409)
          .send({ error: error.code });
      if (error instanceof AccountError)
        return reply
          .code(error.code === 'account-disabled' || error.code === 'account-unavailable' ? 503 : 409)
          .send({ error: error.code });
      return reply.code(503).send({ error: 'operation-unavailable' });
    });
    const context = (request: FastifyRequest) => {
      const userId = users.get(request);
      if (!userId || !operations) throw new OperationError('operation-disabled');
      return { userId, operations };
    };
    const base = '/workspaces/:workspaceId/atlassian';
    routes.get(
      `${base}/sources`,
      {
        logLevel: 'silent',
        schema: { ...schema('listAtlassianSourcesV1', listingSchema), params: json(workspaceParams) },
      },
      request => {
        const { userId, operations } = context(request);
        return operations.sources(workspaceParams.parse(request.params).workspaceId, userId);
      },
    );
    routes.post(
      `${base}/sources`,
      {
        logLevel: 'silent',
        bodyLimit: 131072,
        schema: {
          ...schema('createAtlassianSourceV1', sourceSchema),
          params: json(workspaceParams),
          body: json(createSourceSchema),
        },
      },
      request => {
        const { userId, operations } = context(request);
        return operations.createSource(workspaceParams.parse(request.params).workspaceId, userId, request.body);
      },
    );
    for (const action of ['disable', 'qualify'] as const)
      routes.post(
        `${base}/sources/:sourceId/${action}`,
        {
          logLevel: 'silent',
          schema: {
            ...schema(`${action}AtlassianSourceV1`, action === 'disable' ? sourceSchema : untrustedResultSchema),
            params: json(sourceParams),
          },
        },
        request => {
          const { userId, operations } = context(request);
          const { workspaceId, sourceId } = sourceParams.parse(request.params);
          return action === 'disable'
            ? operations.disableSource(workspaceId, userId, sourceId)
            : operations.qualify(workspaceId, userId, sourceId);
        },
      );
    routes.post(
      `${base}/operations/read`,
      {
        logLevel: 'silent',
        bodyLimit: 131072,
        schema: {
          ...schema('readAtlassianSourceV1', untrustedResultSchema),
          params: json(workspaceParams),
          body: json(operationRequestSchema),
        },
      },
      request => {
        const { userId, operations } = context(request);
        return operations.read(workspaceParams.parse(request.params).workspaceId, userId, request.body);
      },
    );
    routes.post(
      `${base}/operations/proposals`,
      {
        logLevel: 'silent',
        bodyLimit: 131072,
        schema: {
          ...schema('proposeAtlassianWriteV1', proposalSchema),
          params: json(workspaceParams),
          body: json(proposalRequestSchema),
        },
      },
      request => {
        const { userId, operations } = context(request);
        return operations.propose(workspaceParams.parse(request.params).workspaceId, userId, request.body);
      },
    );
    routes.get(
      `${base}/operations/proposals/:proposalId`,
      {
        logLevel: 'silent',
        schema: { ...schema('getAtlassianProposalV1', proposalSchema), params: json(proposalParams) },
      },
      request => {
        const { userId, operations } = context(request);
        const { workspaceId, proposalId } = proposalParams.parse(request.params);
        return operations.proposal(workspaceId, userId, proposalId);
      },
    );
    routes.post(
      `${base}/operations/proposals/:proposalId/decision`,
      {
        logLevel: 'silent',
        bodyLimit: 1024,
        schema: {
          ...schema('decideAtlassianProposalV1', proposalSchema),
          params: json(proposalParams),
          body: json(approvalDecisionSchema),
        },
      },
      request => {
        const { userId } = context(request);
        if (!approve) throw new OperationError('operation-disabled');
        const { workspaceId, proposalId } = proposalParams.parse(request.params);
        return approve(workspaceId, userId, proposalId, request.body);
      },
    );
    routes.post(
      `${base}/operations/proposals/:proposalId/execute`,
      {
        logLevel: 'silent',
        schema: { ...schema('executeAtlassianProposalV1', receiptSchema.nullable()), params: json(proposalParams) },
      },
      request => {
        if (request.body !== undefined) z.never().parse(request.body);
        const { userId, operations } = context(request);
        const { workspaceId, proposalId } = proposalParams.parse(request.params);
        return operations.execute(workspaceId, userId, proposalId);
      },
    );
  });
}
