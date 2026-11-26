import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { MemberIdentityError } from '@tulipfarm/integrations/member-identities';
import { createWorkspaceMembers } from '@tulipfarm/workspaces/members';
import {
  addWorkspaceMemberIdentityInputSchema,
  removeWorkspaceMemberIdentityResultSchema,
  updateWorkspaceMemberIdentityInputSchema,
  workspaceMemberIdentitiesSchema,
  workspaceMemberIdentityResultSchema,
  workspaceMemberIdentitySearchSchema,
} from '@tulipfarm/workspaces/member-identities-contracts';
import {
  workspaceMemberIdSchema,
  workspaceMemberMutationSchema,
  workspaceMembersStateSchema,
  WorkspaceMemberError,
} from '@tulipfarm/tables/workspace-members';
import { GenerationError } from '@tulipfarm/tables/store';
import { TableError } from '@tulipfarm/tables/service-contracts';
import { TableValidationError } from '@tulipfarm/tables/definition';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { authConfig, type registerAuth } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { requestBoundaryError } from './security.ts';
import { routeValidation } from './route-validation.ts';
import { createRecordRequests, recordMutationResultSchema } from './table-record-requests.ts';

export function registerWorkspaceMembers(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    runtime: Parameters<typeof createWorkspaceMembers>[0];
  },
) {
  const service = createWorkspaceMembers(dependencies.runtime);
  const recordRequests = createRecordRequests(dependencies.runtime);
  const params = z.object({ workspaceId: z.uuid() });
  const memberParams = params.extend({ memberId: workspaceMemberIdSchema });
  const identityParams = memberParams.extend({ identityId: z.uuid() });
  const query = z.object({
    ids: z.string().max(3700).optional(),
    after: workspaceMemberIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    attention: z.enum(['true', 'false']).default('false'),
  });
  const identitySearchQuery = z.object({
    q: z.string().max(200).default(''),
    provider: z.string().min(1).max(64).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  });
  const validation = routeValidation({
    missing: 'Missing workspace member validator',
    invalid: () => new Error('invalid-request'),
  });
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 409, 503].map(status => [status, validation.json(z.object({ error: z.string() }))]),
  );
  app.register(async routes => {
    validation.install(routes, true);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'member-not-found' });
      if (error instanceof MemberIdentityError) return reply.code(error.status).send({ error: error.code });
      if (error instanceof WorkspaceMemberError) return reply.code(error.status).send({ error: error.code });
      if (error instanceof GenerationError) return reply.code(409).send({ error: error.code });
      if (error instanceof TableError) return reply.code(error.status).send({ error: error.code });
      if (error instanceof TableValidationError) return reply.code(400).send({ error: 'invalid-table-values' });
      if (error instanceof StorageUnavailableError) return reply.code(503).send({ error: 'workspace-unavailable' });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(503).send({ error: 'member-unavailable' });
    });
    const base = '/workspaces/:workspaceId/workspace-members';
    routes.get(
      base,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'workspaceMembersState',
          params: validation.json(params),
          querystring: validation.json(query),
          response: { 200: validation.json(workspaceMembersStateSchema), ...errors },
        },
      },
      request => {
        const p = params.parse(request.params),
          input = query.parse(request.query);
        return service.state(p.workspaceId, user(request), {
          limit: input.limit,
          attention: input.attention === 'true',
          ...(input.after ? { after: input.after } : {}),
          ...(input.ids ? { ids: input.ids.split(',') } : {}),
        });
      },
    );
    routes.get(
      `${base}/identities/search`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'searchWorkspaceMemberIdentities',
          params: validation.json(params),
          querystring: validation.json(identitySearchQuery),
          response: { 200: validation.json(workspaceMemberIdentitySearchSchema), ...errors },
        },
      },
      request => {
        const p = params.parse(request.params),
          input = identitySearchQuery.parse(request.query);
        return service.searchIdentities(p.workspaceId, user(request), {
          q: input.q,
          limit: input.limit,
          ...(input.provider ? { provider: input.provider } : {}),
        });
      },
    );
    routes.get(
      `${base}/:memberId/identities`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'workspaceMemberIdentities',
          params: validation.json(memberParams),
          response: { 200: validation.json(workspaceMemberIdentitiesSchema), ...errors },
        },
      },
      request => {
        const p = memberParams.parse(request.params);
        return service.identities(p.workspaceId, user(request), p.memberId);
      },
    );
    routes.post(
      `${base}/:memberId/identities`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'addWorkspaceMemberIdentity',
          params: validation.json(memberParams),
          body: validation.json(addWorkspaceMemberIdentityInputSchema),
          response: { 200: validation.json(workspaceMemberIdentityResultSchema), ...errors },
        },
      },
      request => {
        const p = memberParams.parse(request.params);
        return service.addIdentity(
          p.workspaceId,
          user(request),
          p.memberId,
          addWorkspaceMemberIdentityInputSchema.parse(request.body),
        );
      },
    );
    routes.patch(
      `${base}/:memberId/identities/:identityId`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'updateWorkspaceMemberIdentity',
          params: validation.json(identityParams),
          body: validation.json(updateWorkspaceMemberIdentityInputSchema),
          response: { 200: validation.json(workspaceMemberIdentityResultSchema), ...errors },
        },
      },
      request => {
        const p = identityParams.parse(request.params);
        return service.updateIdentity(
          p.workspaceId,
          user(request),
          p.memberId,
          p.identityId,
          updateWorkspaceMemberIdentityInputSchema.parse(request.body),
        );
      },
    );
    routes.delete(
      `${base}/:memberId/identities/:identityId`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'removeWorkspaceMemberIdentity',
          params: validation.json(identityParams),
          response: { 200: validation.json(removeWorkspaceMemberIdentityResultSchema), ...errors },
        },
      },
      request => {
        const p = identityParams.parse(request.params);
        return service.removeIdentity(p.workspaceId, user(request), p.memberId, p.identityId);
      },
    );
    routes.post(
      `${base}/:memberId/profile-sync/retry`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'retryWorkspaceMemberProfile',
          params: validation.json(memberParams),
          response: { 200: validation.json(z.object({ status: z.literal('pending') })), ...errors },
        },
      },
      request => {
        const p = memberParams.parse(request.params);
        return service.retry(p.workspaceId, user(request), p.memberId);
      },
    );
    const mutation = z.discriminatedUnion('kind', [
      workspaceMemberMutationSchema.options[0].extend({ requestId: z.uuid() }),
      workspaceMemberMutationSchema.options[1].extend({ requestId: z.uuid() }),
    ]);
    routes.post(
      `${base}/:memberId`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'mutateWorkspaceMember',
          params: validation.json(memberParams),
          body: validation.json(mutation),
          response: { 200: validation.json(recordMutationResultSchema), ...errors },
        },
      },
      request => {
        const p = memberParams.parse(request.params),
          { requestId, ...input } = mutation.parse(request.body);
        if (input.recordId !== p.memberId) throw new z.ZodError([]);
        return recordRequests.mutate(p.workspaceId, user(request), { requestId, mutation: input });
      },
    );
    const photoParams = memberParams.extend({ digest: z.string().regex(/^[a-f0-9]{64}$/) });
    routes.get(
      `${base}/:memberId/photos/:digest`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'workspaceMemberPhoto',
          params: validation.json(photoParams),
          response: {
            200: {
              description: 'Member photo',
              content: {
                'image/png': { schema: { type: 'string', format: 'binary' } },
                'image/jpeg': { schema: { type: 'string', format: 'binary' } },
                'image/webp': { schema: { type: 'string', format: 'binary' } },
              },
            },
            302: { type: 'null', description: 'Redirect to the member photo' },
          },
        },
      },
      async (request, reply) => {
        const p = photoParams.parse(request.params);
        const image = await service.photo(p.workspaceId, user(request), p.memberId, p.digest);
        reply
          .header('Cache-Control', 'private, no-store')
          .header('Referrer-Policy', 'no-referrer')
          .header('X-Content-Type-Options', 'nosniff')
          // The web app is on a sibling origin, such as app. beside api., and shows this in an <img>.
          .header('Cross-Origin-Resource-Policy', 'same-site');
        if (image.startsWith('https://')) return reply.redirect(image);
        const [, mime, body] = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(image) ?? [];
        if (!mime || !body) throw new WorkspaceMemberError('member-profile-failed');
        return reply.type(mime).send(Buffer.from(body, 'base64'));
      },
    );
  });
}
