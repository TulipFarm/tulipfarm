import type { FastifyInstance } from 'fastify';
import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import type { createIntegrationService } from '@tulipfarm/integrations';
import {
  IntegrationError,
  integrationDetailSchema,
  integrationListSchema,
  integrationMetadataSchema,
  createIntegrationSchema,
  rotateIntegrationSchema,
  updateIntegrationSchema,
  integrationGrantsSchema,
  transferIntegrationSchema,
  readIssueSchema,
  issueResultSchema,
  integrationCreationGrantsSchema,
  integrationCreationGrantsSnapshotSchema,
  updateCreationGrantsSchema,
} from '@tulipfarm/integrations/contracts';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { authConfig, type registerAuth } from './auth.ts';
import { requestBoundaryError } from './security.ts';

const workspaceParams = z.strictObject({ workspaceId: z.uuid() });
const integrationParams = workspaceParams.extend({ integrationId: z.uuid() });
const successSchema = z.object({ removed: z.literal(true) });
const creationContextSchema = z.strictObject({ teams: z.array(z.strictObject({ id: z.uuid(), name: z.string() })) });
const errorSchema = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
  additionalProperties: false,
};
const validation = routeValidation({
  missing: 'Missing integration request validator',
  invalid: () => new Error('invalid-request'),
});
const { json } = validation;
function schema(operationId: string, params: z.ZodType, response: z.ZodType, body?: z.ZodType) {
  return {
    operationId,
    tags: ['Integrations'],
    params: json(params),
    ...(body ? { body: json(body) } : {}),
    response: {
      200: json(response),
      400: errorSchema,
      401: errorSchema,
      403: errorSchema,
      404: errorSchema,
      409: errorSchema,
      413: errorSchema,
      415: errorSchema,
      429: errorSchema,
      500: errorSchema,
      502: errorSchema,
      503: errorSchema,
      504: errorSchema,
    },
  };
}

export function registerIntegrations(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    service: ReturnType<typeof createIntegrationService>;
  },
) {
  const { service } = dependencies;
  const origin = authConfig().webOrigin;
  app.register(async routes => {
    validation.install(routes);
    const user = authenticateRoutes(routes, dependencies.auth, { origin });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'integration-not-found' });
      if (error instanceof IntegrationError) {
        const statuses = {
          conflict: 409,
          'in-progress': 409,
          'provider-failed': 502,
          'provider-retryable': 503,
          'credential-unavailable': 503,
        };
        return reply.code(statuses[error.code]).send({ error: error.code });
      }
      if (error instanceof StorageUnavailableError) return reply.code(503).send({ error: 'integrations-unavailable' });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(500).send({ error: 'integration-operation-failed' });
    });
    const base = '/workspaces/:workspaceId/integrations';
    routes.get(
      `${base}/collaborators`,
      {
        logLevel: 'silent',
        schema: schema(
          'getIntegrationCollaboratorsV1',
          workspaceParams,
          z.strictObject({ members: creationContextSchema.shape.teams, teams: creationContextSchema.shape.teams }),
        ),
      },
      request => service.collaborators(workspaceParams.parse(request.params).workspaceId, user(request)),
    );
    routes.get(
      `${base}/creation-context`,
      { logLevel: 'silent', schema: schema('getIntegrationCreationContextV1', workspaceParams, creationContextSchema) },
      request => service.creationContext(workspaceParams.parse(request.params).workspaceId, user(request)),
    );
    routes.get(
      `${base}/creation-grants/:owningTeamId`,
      {
        logLevel: 'silent',
        schema: schema(
          'getIntegrationCreationGrantsV1',
          workspaceParams.extend({ owningTeamId: z.uuid() }),
          integrationCreationGrantsSnapshotSchema,
        ),
      },
      request => {
        const params = workspaceParams.extend({ owningTeamId: z.uuid() }).parse(request.params);
        return service.creationGrants(params.workspaceId, user(request), params.owningTeamId);
      },
    );
    routes.put(
      `${base}/creation-grants`,
      {
        logLevel: 'silent',
        schema: schema(
          'setIntegrationCreationGrantsV1',
          workspaceParams,
          integrationCreationGrantsSchema,
          updateCreationGrantsSchema,
        ),
      },
      request =>
        service.setCreationGrants(
          workspaceParams.parse(request.params).workspaceId,
          user(request),
          updateCreationGrantsSchema.parse(request.body),
        ),
    );
    routes.get(
      base,
      { logLevel: 'silent', schema: schema('listIntegrationsV1', workspaceParams, integrationListSchema) },
      request => service.list(workspaceParams.parse(request.params).workspaceId, user(request)),
    );
    routes.post(
      base,
      {
        logLevel: 'silent',
        schema: schema('createIntegrationV1', workspaceParams, integrationMetadataSchema, createIntegrationSchema),
      },
      request =>
        service.create(
          workspaceParams.parse(request.params).workspaceId,
          user(request),
          createIntegrationSchema.parse(request.body),
        ),
    );
    routes.get(
      `${base}/:integrationId`,
      { logLevel: 'silent', schema: schema('getIntegrationV1', integrationParams, integrationDetailSchema) },
      request => {
        const { workspaceId, integrationId } = integrationParams.parse(request.params);
        return service.get(workspaceId, user(request), integrationId);
      },
    );
    routes.post(
      `${base}/:integrationId/rotate`,
      {
        logLevel: 'silent',
        schema: schema('rotateIntegrationV1', integrationParams, integrationDetailSchema, rotateIntegrationSchema),
      },
      request => {
        const { workspaceId, integrationId } = integrationParams.parse(request.params);
        return service.rotate(workspaceId, user(request), integrationId, rotateIntegrationSchema.parse(request.body));
      },
    );
    routes.patch(
      `${base}/:integrationId`,
      {
        logLevel: 'silent',
        schema: schema('updateIntegrationV1', integrationParams, integrationDetailSchema, updateIntegrationSchema),
      },
      request => {
        const { workspaceId, integrationId } = integrationParams.parse(request.params);
        return service.update(workspaceId, user(request), integrationId, updateIntegrationSchema.parse(request.body));
      },
    );
    routes.put(
      `${base}/:integrationId/grants`,
      {
        logLevel: 'silent',
        schema: schema('setIntegrationGrantsV1', integrationParams, integrationDetailSchema, integrationGrantsSchema),
      },
      request => {
        const { workspaceId, integrationId } = integrationParams.parse(request.params);
        return service.setGrants(
          workspaceId,
          user(request),
          integrationId,
          integrationGrantsSchema.parse(request.body),
        );
      },
    );
    routes.put(
      `${base}/:integrationId/owner`,
      {
        logLevel: 'silent',
        schema: schema('transferIntegrationV1', integrationParams, integrationDetailSchema, transferIntegrationSchema),
      },
      request => {
        const { workspaceId, integrationId } = integrationParams.parse(request.params);
        return service.transfer(
          workspaceId,
          user(request),
          integrationId,
          transferIntegrationSchema.parse(request.body),
        );
      },
    );
    routes.delete(
      `${base}/:integrationId`,
      { logLevel: 'silent', schema: schema('deleteIntegrationV1', integrationParams, successSchema) },
      request => {
        const { workspaceId, integrationId } = integrationParams.parse(request.params);
        return service.remove(workspaceId, user(request), integrationId);
      },
    );
    routes.post(
      `${base}/read-issue`,
      {
        logLevel: 'silent',
        schema: schema('readIntegrationIssueV1', workspaceParams, issueResultSchema, readIssueSchema),
      },
      request =>
        service.readIssue(
          workspaceParams.parse(request.params).workspaceId,
          user(request),
          readIssueSchema.parse(request.body),
        ),
    );
  });
}
