import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { ConversationConflict } from '@tulipfarm/conversations';
import { SecretError, type SecretRequests, type Secrets } from '@tulipfarm/secrets';
import { authConfig, type registerAuth } from './auth.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';
import {
  createSecretBody,
  declineSecretRequestBody,
  deleteSecretBody,
  replaceSecretBody,
  saveSecretBody,
  secretDeletedSchema,
  secretDestinationsBody,
  secretExpiryBody,
  secretGrantsBody,
  secretHistorySchema,
  secretListSchema,
  secretNamesBody,
  secretParams,
  secretRequestParams,
  secretRequestResultSchema,
  secretRequestViewSchema,
  secretRevealBody,
  secretRevealSchema,
  secretRevealsSchema,
  secretsCapabilitiesSchema,
  secretsWorkspaceParams,
  secretSummarySchema,
  submitSecretRequestBody,
  taskSecretRequestParams,
  taskSecretRequestsSchema,
} from './secrets-contracts.ts';

export type SecretsHttpAuth = { api: Pick<ReturnType<typeof registerAuth>['auth']['api'], 'getSession'> };
type Status = 400 | 404 | 409 | 410 | 503;

function classify(error: unknown): [Status, string] {
  if (error instanceof AccessDenied) return [404, 'secret-not-found'];
  if (error instanceof ConversationConflict) return [409, 'secret-conflict'];
  if (error instanceof SecretError)
    switch (error.code) {
      case 'invalid-input':
        return [400, 'invalid-secret'];
      case 'placement-required':
      case 'placement-unsupported':
      case 'destination-denied':
        return [400, `secret-${error.code}`];
      case 'not-found':
        return [404, 'secret-not-found'];
      case 'expired':
        return [410, 'secret-expired'];
      case 'conflict':
      case 'unavailable':
      case 'variable-name-taken':
        return [409, `secret-${error.code}`];
      case 'disabled':
      case 'credential-unavailable':
        return [503, `secrets-${error.code}`];
    }
  return [503, 'secrets-unavailable'];
}

/**
 * Settings and request-form routes. The API encrypts but never decrypts. No route logs its body, and none
 * is cached, because create, replace and submit carry values (P9, P21).
 */
export function registerSecrets(
  app: FastifyInstance,
  auth: SecretsHttpAuth,
  service: { secrets: Secrets; requests: SecretRequests },
  wakeTask?: (workspaceId: string, taskId: string) => Promise<void>,
) {
  app.register(async routes => {
    const validation = routeValidation({
      target: 'openapi-3.0',
      missing: 'Missing secrets validator',
      invalid: error => error,
    });
    validation.install(routes, true);
    const sessions = new WeakMap<FastifyRequest, string>();
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== authConfig().webOrigin)
        return reply.code(403).send({ error: 'untrusted-origin' });
      const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session) return reply.code(401).send({ error: 'sign-in-required' });
      sessions.set(request, session.user.id);
    });
    routes.setErrorHandler((error, _request, reply) => {
      // Validation details could echo a value, so every input error reads the same (P9).
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-secret' });
      if (requestBoundaryError(error, reply)) return;
      const [status, code] = classify(error);
      return reply.code(status).send({ error: code });
    });
    const errorBody = {
      type: 'object',
      properties: { error: { type: 'string' } },
      required: ['error'],
      additionalProperties: false,
    };
    const schema = (operationId: string, output: z.ZodType, params: z.ZodType, body?: z.ZodType) => ({
      operationId,
      tags: ['Secrets'],
      params: validation.json(params),
      ...(body ? { body: validation.json(body) } : {}),
      response: {
        200: validation.json(output),
        ...Object.fromEntries([400, 401, 403, 404, 409, 410, 413, 415, 429, 503].map(status => [status, errorBody])),
      },
    });
    const userId = (request: FastifyRequest) => {
      const id = sessions.get(request);
      if (!id) throw new SecretError('unavailable');
      return id;
    };
    const secret = (request: FastifyRequest) => secretParams.parse(request.params);
    const options = (operationId: string, output: z.ZodType, params: z.ZodType, body?: z.ZodType) => ({
      logLevel: 'silent' as const,
      bodyLimit: 64 * 1024,
      schema: schema(operationId, output, params, body),
    });

    const base = '/workspaces/:workspaceId/secrets';
    routes.get(
      `${base}/capabilities`,
      options('getSecretsCapabilitiesV1', secretsCapabilitiesSchema, secretsWorkspaceParams),
      () => service.secrets.capabilities(),
    );
    routes.get(`${base}`, options('listSecretsV1', secretListSchema, secretsWorkspaceParams), async request => ({
      secrets: await service.secrets.list(secretsWorkspaceParams.parse(request.params).workspaceId, userId(request)),
    }));
    routes.post(
      `${base}`,
      options('createSecretV1', secretSummarySchema, secretsWorkspaceParams, createSecretBody),
      request =>
        service.secrets.create(secretsWorkspaceParams.parse(request.params).workspaceId, userId(request), {
          ...createSecretBody.parse(request.body),
          lifetime: { kind: 'saved' },
          placementSource: 'member',
        }),
    );
    routes.get(
      `${base}/:secretId/history`,
      options('getSecretHistoryV1', secretHistorySchema, secretParams),
      async request => {
        const { workspaceId, secretId } = secret(request);
        return { events: await service.secrets.history(workspaceId, userId(request), secretId) };
      },
    );
    routes.post(
      `${base}/:secretId/replace`,
      options('replaceSecretV1', secretSummarySchema, secretParams, replaceSecretBody),
      request => {
        const { workspaceId, secretId } = secret(request);
        return service.secrets.replace(workspaceId, userId(request), secretId, replaceSecretBody.parse(request.body));
      },
    );
    routes.post(
      `${base}/:secretId/take-ownership`,
      options('takeSecretOwnershipV1', secretSummarySchema, secretParams, replaceSecretBody),
      request => {
        const { workspaceId, secretId } = secret(request);
        return service.secrets.takeOwnership(
          workspaceId,
          userId(request),
          secretId,
          replaceSecretBody.parse(request.body),
        );
      },
    );
    routes.put(
      `${base}/:secretId/destinations`,
      options('setSecretDestinationsV1', secretSummarySchema, secretParams, secretDestinationsBody),
      request => {
        const { workspaceId, secretId } = secret(request);
        return service.secrets.setDestinations(
          workspaceId,
          userId(request),
          secretId,
          secretDestinationsBody.parse(request.body),
        );
      },
    );
    routes.put(
      `${base}/:secretId/grants`,
      options('setSecretGrantsV1', secretSummarySchema, secretParams, secretGrantsBody),
      request => {
        const { workspaceId, secretId } = secret(request);
        return service.secrets.setGrants(workspaceId, userId(request), secretId, secretGrantsBody.parse(request.body));
      },
    );
    routes.put(
      `${base}/:secretId/expiry`,
      options('setSecretExpiryV1', secretSummarySchema, secretParams, secretExpiryBody),
      request => {
        const { workspaceId, secretId } = secret(request);
        return service.secrets.setExpiry(workspaceId, userId(request), secretId, secretExpiryBody.parse(request.body));
      },
    );
    routes.put(
      `${base}/:secretId/names`,
      options('renameSecretV1', secretSummarySchema, secretParams, secretNamesBody),
      request => {
        const { workspaceId, secretId } = secret(request);
        return service.secrets.rename(workspaceId, userId(request), secretId, secretNamesBody.parse(request.body));
      },
    );
    routes.get(
      `${base}/:secretId/reveals`,
      options('listSecretRevealsV1', secretRevealsSchema, secretParams),
      async request => {
        const { workspaceId, secretId } = secret(request);
        return { reveals: await service.secrets.reveals(workspaceId, userId(request), secretId) };
      },
    );
    routes.put(
      `${base}/:secretId/reveals`,
      options('setSecretRevealV1', secretRevealSchema, secretParams, secretRevealBody),
      request => {
        const { workspaceId, secretId } = secret(request);
        return service.secrets.setReveal(workspaceId, userId(request), secretId, secretRevealBody.parse(request.body));
      },
    );
    routes.post(
      `${base}/:secretId/save`,
      options('saveSecretV1', secretSummarySchema, secretParams, saveSecretBody),
      request => {
        const { workspaceId, secretId } = secret(request);
        return service.secrets.save(workspaceId, userId(request), secretId, saveSecretBody.parse(request.body));
      },
    );
    routes.delete(
      `${base}/:secretId`,
      options('deleteSecretV1', secretDeletedSchema, secretParams, deleteSecretBody),
      request => {
        const { workspaceId, secretId } = secret(request);
        return service.secrets.delete(workspaceId, userId(request), secretId, deleteSecretBody.parse(request.body));
      },
    );

    const requests = '/workspaces/:workspaceId/secret-requests/:requestId';
    // A task waiting on the form continues once its owner answers; worker recovery covers a missed wake.
    const wake = async (workspaceId: string, user: string, requestId: string) => {
      if (!wakeTask) return;
      const origin = await service.requests.origin(workspaceId, user, requestId);
      if (origin.kind === 'task') await wakeTask(workspaceId, origin.taskId);
    };
    const form = (request: FastifyRequest) => secretRequestParams.parse(request.params);
    routes.get(
      '/workspaces/:workspaceId/agent-tasks/:taskId/secret-requests',
      options('listTaskSecretRequestsV1', taskSecretRequestsSchema, taskSecretRequestParams),
      async request => {
        const { workspaceId, taskId } = taskSecretRequestParams.parse(request.params);
        return { requests: await service.requests.forTask(workspaceId, userId(request), taskId) };
      },
    );
    routes.get(requests, options('getSecretRequestV1', secretRequestViewSchema, secretRequestParams), request => {
      const { workspaceId, requestId } = form(request);
      return service.requests.view(workspaceId, userId(request), requestId);
    });
    routes.post(
      `${requests}/submit`,
      options('submitSecretRequestV1', secretRequestResultSchema, secretRequestParams, submitSecretRequestBody),
      async request => {
        const { workspaceId, requestId } = form(request);
        const result = await service.requests.submit(
          workspaceId,
          userId(request),
          requestId,
          submitSecretRequestBody.parse(request.body),
        );
        await wake(workspaceId, userId(request), requestId);
        return result;
      },
    );
    routes.post(
      `${requests}/decline`,
      options('declineSecretRequestV1', secretRequestResultSchema, secretRequestParams, declineSecretRequestBody),
      async request => {
        const { workspaceId, requestId } = form(request);
        const result = await service.requests.decline(
          workspaceId,
          userId(request),
          requestId,
          declineSecretRequestBody.parse(request.body),
        );
        await wake(workspaceId, userId(request), requestId);
        return result;
      },
    );
  });
}
