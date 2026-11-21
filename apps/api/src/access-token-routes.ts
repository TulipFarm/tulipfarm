import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccessDenied, WorkspaceMembershipDenied } from '@tulipfarm/access';
import type { registerAuth } from './auth.ts';
import { AccessTokenError, accessTokenSchema, type AccessTokens } from './access-tokens.ts';

const error = { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] };
const workspaceParams = {
  type: 'object',
  properties: { workspaceId: { type: 'string', format: 'uuid' } },
  required: ['workspaceId'],
};
const settingsSchema = z.object({ available: z.boolean(), enabled: z.boolean(), admin: z.boolean() });
const tokenJson = z.toJSONSchema(accessTokenSchema, { target: 'openapi-3.0' });
const settingsJson = z.toJSONSchema(settingsSchema, { target: 'openapi-3.0' });
const tags = ['Workspace settings'];

/** Session routes behind Settings → API and MCP: the admin switch, and creating, listing and revoking tokens. */
export function registerAccessTokenSettings(
  app: FastifyInstance,
  auth: ReturnType<typeof registerAuth>['auth'],
  tokens: AccessTokens,
) {
  const signedIn = async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) {
      reply.code(401).send({ error: 'sign-in-required' });
      return null;
    }
    return {
      userId: session.user.id,
      workspaceId: z.object({ workspaceId: z.uuid() }).parse(request.params).workspaceId,
    };
  };
  const failure = (reply: FastifyReply, caught: unknown) => {
    if (caught instanceof z.ZodError) return reply.code(400).send({ error: 'invalid-request' });
    if (caught instanceof AccessTokenError)
      return reply.code(caught.code === 'not-found' ? 404 : 409).send({ error: caught.code });
    if (caught instanceof AccessDenied) return reply.code(403).send({ error: 'forbidden' });
    if (caught instanceof WorkspaceMembershipDenied) return reply.code(404).send({ error: 'not-found' });
    throw caught;
  };

  app.get(
    '/workspaces/:workspaceId/external-access',
    {
      schema: {
        operationId: 'getExternalAccessV1',
        summary: 'Read whether API and MCP access is available and on for the workspace',
        tags,
        params: workspaceParams,
        response: { 200: settingsJson, 401: error, 404: error },
      },
    },
    async (request, reply) => {
      const caller = await signedIn(request, reply);
      if (!caller) return reply;
      try {
        return await tokens.settings(caller.workspaceId, caller.userId);
      } catch (caught) {
        return failure(reply, caught);
      }
    },
  );

  app.put(
    '/workspaces/:workspaceId/external-access',
    {
      schema: {
        operationId: 'setExternalAccessV1',
        summary: 'Turn API and MCP access on or off for the workspace (admins only)',
        tags,
        params: workspaceParams,
        body: {
          type: 'object',
          properties: { enabled: { type: 'boolean' } },
          required: ['enabled'],
          additionalProperties: false,
        },
        response: { 200: settingsJson, 400: error, 401: error, 403: error, 404: error, 409: error },
      },
    },
    async (request, reply) => {
      const caller = await signedIn(request, reply);
      if (!caller) return reply;
      try {
        const { enabled } = z.strictObject({ enabled: z.boolean() }).parse(request.body);
        return await tokens.setEnabled(caller.workspaceId, caller.userId, enabled);
      } catch (caught) {
        return failure(reply, caught);
      }
    },
  );

  app.get(
    '/workspaces/:workspaceId/access-tokens',
    {
      schema: {
        operationId: 'listAccessTokensV1',
        summary: "List your access tokens, or every member's with scope=all (admins only)",
        tags,
        params: workspaceParams,
        querystring: { type: 'object', properties: { scope: { type: 'string', enum: ['mine', 'all'] } } },
        response: {
          200: { type: 'object', properties: { tokens: { type: 'array', items: tokenJson } }, required: ['tokens'] },
          401: error,
          403: error,
          404: error,
        },
      },
    },
    async (request, reply) => {
      const caller = await signedIn(request, reply);
      if (!caller) return reply;
      try {
        const { scope } = z.object({ scope: z.enum(['mine', 'all']).default('mine') }).parse(request.query);
        return { tokens: await tokens.list(caller.workspaceId, caller.userId, scope === 'all') };
      } catch (caught) {
        return failure(reply, caught);
      }
    },
  );

  app.post(
    '/workspaces/:workspaceId/access-tokens',
    {
      schema: {
        operationId: 'createAccessTokenV1',
        summary: 'Create an access token that acts as you. The token is returned only in this response',
        tags,
        params: workspaceParams,
        body: { type: 'object' },
        response: {
          201: {
            type: 'object',
            properties: { token: { type: 'string' }, accessToken: tokenJson },
            required: ['token', 'accessToken'],
          },
          400: error,
          401: error,
          404: error,
          409: error,
        },
      },
    },
    async (request, reply) => {
      const caller = await signedIn(request, reply);
      if (!caller) return reply;
      try {
        return reply.code(201).send(await tokens.create(caller.workspaceId, caller.userId, request.body));
      } catch (caught) {
        return failure(reply, caught);
      }
    },
  );

  app.delete(
    '/workspaces/:workspaceId/access-tokens/:tokenId',
    {
      schema: {
        operationId: 'revokeAccessTokenV1',
        summary: 'Revoke an access token. Owners revoke their own; admins can revoke any',
        tags,
        params: {
          type: 'object',
          properties: { workspaceId: { type: 'string', format: 'uuid' }, tokenId: { type: 'string', format: 'uuid' } },
          required: ['workspaceId', 'tokenId'],
        },
        response: { 200: tokenJson, 401: error, 404: error },
      },
    },
    async (request, reply) => {
      const caller = await signedIn(request, reply);
      if (!caller) return reply;
      try {
        const { tokenId } = z.object({ tokenId: z.uuid() }).parse(request.params);
        return await tokens.revoke(caller.workspaceId, caller.userId, tokenId);
      } catch (caught) {
        return failure(reply, caught);
      }
    },
  );
}
