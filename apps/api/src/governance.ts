import { authenticateRoutes } from './authenticated-routes.ts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { createGovernanceService, GovernanceConflict } from '@tulipfarm/workspaces/governance';
import { WorkspaceMemberError } from '@tulipfarm/tables/workspace-members';
import {
  collaborationDirectorySchema,
  teamRoleInputSchema,
  createdInvitationSchema,
  enrollmentInputSchema,
  governanceSnapshotSchema,
  governanceSuccessSchema,
  grantInputSchema,
  personGrantInputSchema,
  personGrantListSchema,
  invitationInputSchema,
  invitationLinkSchema,
  invitationListQuerySchema,
  invitationListSchema,
  joinedWorkspaceSchema,
  resendInvitationSchema,
  leaveTeamInputSchema,
  memberRoleInputSchema,
  ownMembershipSchema,
  redeemInvitationSchema,
  teamInputSchema,
  teamUpdateSchema,
} from '@tulipfarm/workspaces/governance-contracts';
import { authConfig, type registerAuth } from './auth.ts';
import { requestBoundaryError } from './security.ts';

const workspaceParams = z.object({ workspaceId: z.uuid() });
const memberParams = workspaceParams.extend({ membershipId: z.uuid() });
const teamParams = workspaceParams.extend({ teamId: z.uuid() });
const invitationParams = workspaceParams.extend({ invitationId: z.uuid() });
const ownershipInput = z.strictObject({ teamId: z.uuid() });
const invitationBody = invitationInputSchema;
const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'input' });
const errorSchema = json(z.object({ error: z.string() }));
const responses = (schema: z.ZodType) => ({
  200: json(schema),
  400: errorSchema,
  401: errorSchema,
  403: errorSchema,
  404: errorSchema,
  409: errorSchema,
  413: errorSchema,
  415: errorSchema,
  500: errorSchema,
  503: errorSchema,
});

export function registerGovernance(
  app: FastifyInstance,
  dependencies: Parameters<typeof createGovernanceService>[0] & {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
  },
) {
  const service = createGovernanceService(dependencies);
  app.register(async routes => {
    const user = authenticateRoutes(routes, dependencies.auth, { origin: () => authConfig().webOrigin });
    const validateTeam = async (request: FastifyRequest) => {
      request.body = teamInputSchema.parse(request.body);
    };
    routes.setErrorHandler((error, _request, reply) => {
      if (
        error instanceof z.ZodError &&
        ['createTeamV1', 'renameTeamV1'].includes(_request.routeOptions.schema?.operationId ?? '')
      ) {
        const field = error.issues[0]?.path[0];
        return reply.code(400).send({
          error:
            field === 'name'
              ? 'invalid-team-name'
              : field === 'description'
                ? 'invalid-team-description'
                : 'invalid-request',
        });
      }
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'governance-not-found' });
      if (error instanceof GovernanceConflict)
        return reply
          .code(
            ['invitations-unavailable', 'teams-unavailable', 'person-grants-unavailable'].includes(error.code)
              ? 503
              : 409,
          )
          .send({ error: error.code });
      if (error instanceof WorkspaceMemberError) return reply.code(error.status).send({ error: error.code });
      if (error instanceof StorageUnavailableError) return reply.code(503).send({ error: 'workspace-unavailable' });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(500).send({ error: 'governance-operation-failed' });
    });
    const base = '/workspaces/:workspaceId/governance';
    const schema = (
      operationId: string,
      params: z.ZodType,
      body?: z.ZodType,
      response: z.ZodType = governanceSuccessSchema,
    ) => ({
      operationId,
      tags: ['Governance'],
      params: json(params),
      ...(body ? { body: json(body) } : {}),
      response: responses(response),
    });
    routes.get(
      base,
      { schema: schema('getGovernanceV1', workspaceParams, undefined, governanceSnapshotSchema) },
      request => {
        return service.snapshot(workspaceParams.parse(request.params).workspaceId, user(request));
      },
    );
    routes.get(
      `${base}/me`,
      { schema: schema('getOwnMembershipV1', workspaceParams, undefined, ownMembershipSchema) },
      request => {
        return service.ownMembership(workspaceParams.parse(request.params).workspaceId, user(request));
      },
    );
    routes.get(
      `${base}/directory`,
      { schema: schema('getCollaborationDirectoryV1', workspaceParams, undefined, collaborationDirectorySchema) },
      request => service.collaborationDirectory(workspaceParams.parse(request.params).workspaceId, user(request)),
    );
    routes.put(
      `${base}/members/:membershipId/role`,
      { schema: schema('setMemberRoleV1', memberParams, memberRoleInputSchema) },
      request => {
        const { workspaceId, membershipId } = memberParams.parse(request.params);
        return service.setMemberRole(workspaceId, user(request), membershipId, request.body);
      },
    );
    routes.delete(`${base}/members/:membershipId`, { schema: schema('removeMemberV1', memberParams) }, request => {
      const { workspaceId, membershipId } = memberParams.parse(request.params);
      return service.removeMember(workspaceId, user(request), membershipId);
    });
    routes.post(`${base}/leave`, { schema: schema('leaveWorkspaceV1', workspaceParams) }, request =>
      service.leave(workspaceParams.parse(request.params).workspaceId, user(request)),
    );
    routes.put(
      `${base}/teams/:teamId`,
      { preValidation: validateTeam, schema: schema('createTeamV1', teamParams, teamInputSchema) },
      request => {
        const { workspaceId, teamId } = teamParams.parse(request.params);
        return service.createTeam(workspaceId, user(request), teamId, request.body);
      },
    );
    routes.put(
      `${base}/teams/:teamId/name`,
      {
        preValidation: async request => {
          request.body = teamUpdateSchema.parse(request.body);
        },
        schema: schema('renameTeamV1', teamParams, teamUpdateSchema),
      },
      request => {
        const { workspaceId, teamId } = teamParams.parse(request.params);
        return service.renameTeam(workspaceId, user(request), teamId, request.body);
      },
    );
    routes.delete(`${base}/teams/:teamId`, { schema: schema('deleteTeamV1', teamParams) }, request => {
      const { workspaceId, teamId } = teamParams.parse(request.params);
      return service.deleteTeam(workspaceId, user(request), teamId);
    });
    routes.post(
      `${base}/teams/:teamId/leave`,
      {
        preValidation: async request => {
          leaveTeamInputSchema.parse(request.body ?? {});
        },
        schema: schema('leaveTeamV1', teamParams),
      },
      request => {
        const { workspaceId, teamId } = teamParams.parse(request.params);
        return service.leaveTeam(workspaceId, user(request), teamId);
      },
    );
    const enrollmentParams = teamParams.extend({ membershipId: z.uuid() });
    routes.put(
      `${base}/teams/:teamId/members/:membershipId/role`,
      { schema: schema('setTeamRoleV1', enrollmentParams, teamRoleInputSchema) },
      request => {
        const { workspaceId, teamId, membershipId } = enrollmentParams.parse(request.params);
        return service.setTeamRole(workspaceId, user(request), teamId, membershipId, request.body);
      },
    );
    routes.put(
      `${base}/teams/:teamId/members/:membershipId`,
      { schema: schema('setTeamEnrollmentV1', enrollmentParams, enrollmentInputSchema) },
      request => {
        const { workspaceId, teamId, membershipId } = enrollmentParams.parse(request.params);
        return service.setEnrollment(workspaceId, user(request), teamId, membershipId, request.body);
      },
    );
    routes.put(`${base}/grants`, { schema: schema('setTableGrantV1', workspaceParams, grantInputSchema) }, request =>
      service.setGrant(workspaceParams.parse(request.params).workspaceId, user(request), request.body),
    );
    routes.get(
      `${base}/person-grants`,
      { schema: schema('listTablePersonGrantsV1', workspaceParams, undefined, personGrantListSchema) },
      request => service.listPersonGrants(workspaceParams.parse(request.params).workspaceId, user(request)),
    );
    routes.put(
      `${base}/person-grants`,
      { schema: schema('setTablePersonGrantV1', workspaceParams, personGrantInputSchema) },
      request => service.setPersonGrant(workspaceParams.parse(request.params).workspaceId, user(request), request.body),
    );
    const tableParams = workspaceParams.extend({ tableId: z.uuid() });
    const transferTable = (request: { params: unknown; body: unknown } & Parameters<typeof user>[0]) => {
      const { workspaceId, tableId } = tableParams.parse(request.params);
      return service.transferTable(workspaceId, user(request), tableId, ownershipInput.parse(request.body).teamId);
    };
    routes.put(
      `${base}/tables/:tableId/owner`,
      { schema: schema('transferTableOwnershipV1', tableParams, ownershipInput) },
      transferTable,
    );
    routes.get(
      `${base}/invitations`,
      {
        schema: {
          ...schema('listGovernanceInvitationsV1', workspaceParams, undefined, invitationListSchema),
          querystring: json(invitationListQuerySchema),
        },
      },
      request =>
        service.listInvitations(workspaceParams.parse(request.params).workspaceId, user(request), request.query),
    );
    routes.post(
      `${base}/invitations`,
      {
        logLevel: 'silent',
        preValidation: async request => {
          request.body = invitationInputSchema.parse(request.body);
        },
        schema: schema('createGovernanceInvitationV1', workspaceParams, invitationBody, createdInvitationSchema),
      },
      request =>
        service.createInvitation(workspaceParams.parse(request.params).workspaceId, user(request), request.body),
    );
    routes.get(
      `${base}/invitations/:invitationId/link`,
      {
        logLevel: 'silent',
        schema: schema('copyGovernanceInvitationV1', invitationParams, undefined, invitationLinkSchema),
      },
      request => {
        const { workspaceId, invitationId } = invitationParams.parse(request.params);
        return service.copyInvitation(workspaceId, user(request), invitationId);
      },
    );
    routes.post(
      `${base}/invitations/:invitationId/resend`,
      {
        logLevel: 'silent',
        preValidation: async request => {
          request.body = resendInvitationSchema.parse(request.body);
        },
        schema: schema(
          'resendGovernanceInvitationV1',
          invitationParams,
          resendInvitationSchema,
          createdInvitationSchema,
        ),
      },
      request => {
        const { workspaceId, invitationId } = invitationParams.parse(request.params);
        return service.resendInvitation(workspaceId, user(request), invitationId, request.body);
      },
    );
    routes.post(
      `${base}/invitations/:invitationId/revoke`,
      { schema: schema('revokeGovernanceInvitationV1', invitationParams) },
      request => {
        const { workspaceId, invitationId } = invitationParams.parse(request.params);
        return service.revokeInvitation(workspaceId, user(request), invitationId);
      },
    );
    routes.post(
      '/invitations/redeem',
      {
        logLevel: 'silent',
        schema: {
          operationId: 'redeemGovernanceInvitationV1',
          tags: ['Governance'],
          body: json(redeemInvitationSchema),
          response: responses(joinedWorkspaceSchema),
        },
      },
      request => service.redeemInvitation(user(request), redeemInvitationSchema.parse(request.body).token),
    );
  });
}
