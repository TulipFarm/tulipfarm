import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AccessDenied, lockAuthorization, resolveHuman } from '@tulipfarm/access';
import { GoogleWorkspaceError } from '@tulipfarm/google-workspace/contracts';
import { GoogleOperationError } from '@tulipfarm/google-workspace/operation-contracts';
import {
  GoogleFileError,
  googleFileListRequestSchema,
  googleFileReferenceSchema,
  googleFileContentRequestSchema,
  googleFilePageSchema,
  googleFileMetadataSchema,
} from '@tulipfarm/google-workspace/public-contracts';
import {
  googleOperationCatalog,
  operationRequestSchema as read,
  proposalRequestSchema as propose,
  approvalDecisionSchema as decision,
  googleProposalListQuerySchema,
  googleProposalListSchema,
} from '@tulipfarm/google-workspace/public-contracts';
import { GoogleLifecycleError, type createGoogleOperations } from '@tulipfarm/google-workspace/operations';
import type { createGoogleApproval } from '@tulipfarm/google-workspace/operation-approval';
import { authConfig, type registerAuth } from './auth.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

const workspace = z.strictObject({ workspaceId: z.uuid() });
const proposal = workspace.extend({ proposalId: z.uuid() });

export function registerGoogleOperations(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    runtime: Parameters<typeof createGoogleOperations>[0]['runtime'];
    operations: ReturnType<typeof createGoogleOperations>;
    approve: ReturnType<typeof createGoogleApproval>;
  },
) {
  app.register(async routes => {
    const validation = routeValidation({
      target: 'openapi-3.0',
      missing: 'Missing Google operation validator',
      invalid: () => new Error('invalid-request'),
    });
    validation.install(routes, true);
    const { json } = validation;
    const users = new WeakMap<FastifyRequest, string>();
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');
      if (request.method !== 'GET' && request.headers.origin !== authConfig().webOrigin)
        return reply.code(403).send({ error: 'untrusted-origin' });
      const session = await dependencies.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session) return reply.code(401).send({ error: 'sign-in-required' });
      users.set(request, session.user.id);
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'operation-not-found' });
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid-request' });
      if (error instanceof GoogleFileError)
        return reply
          .code(error.code === 'transfer-busy' ? 429 : error.code === 'transfer-timeout' ? 504 : 409)
          .send({ error: error.code });
      if (
        error instanceof GoogleLifecycleError ||
        error instanceof GoogleOperationError ||
        error instanceof GoogleWorkspaceError
      )
        return reply.code(409).send({ error: error.code });
      return reply.code(503).send({ error: 'operation-unavailable' });
    });
    const user = (request: FastifyRequest) => {
      const id = users.get(request);
      if (!id) throw new AccessDenied();
      return id;
    };
    const schema = (operationId: string, params: z.ZodType, body?: z.ZodType) => ({
      operationId,
      tags: ['Google operations'],
      params: json(params),
      ...(body ? { body: json(body) } : {}),
    });
    const base = '/workspaces/:workspaceId/google-workspace/operations';
    const fileRequests = new Map<FastifyRequest, AbortController>();
    // Capacity is enforced per integration by the operations service; this hook only ties each read to its request lifetime.
    const reserveFileRead = async (request: FastifyRequest, reply: FastifyReply) => {
      const controller = new AbortController();
      fileRequests.set(request, controller);
      request.raw.once('aborted', () => controller.abort());
      const deadline = setTimeout(() => {
        controller.abort();
        reply.raw.destroy();
      }, 20_000);
      reply.raw.once('finish', () => clearTimeout(deadline));
      reply.raw.once('close', () => {
        clearTimeout(deadline);
        controller.abort();
        fileRequests.delete(request);
      });
    };
    const recheckSession = async (request: FastifyRequest) => {
      const session = await dependencies.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session || session.user.id !== user(request)) throw new AccessDenied();
    };
    routes.addHook('onResponse', async request => {
      fileRequests.delete(request);
    });
    routes.post(
      `${base}/files/list`,
      {
        logLevel: 'silent',
        bodyLimit: 8192,
        preHandler: reserveFileRead,
        schema: {
          ...schema('listGoogleFilesV1', workspace, googleFileListRequestSchema),
          response: { 200: json(googleFilePageSchema) },
        },
      },
      async request => {
        const result = await dependencies.operations.listFiles(
          workspace.parse(request.params).workspaceId,
          user(request),
          request.body,
          fileRequests.get(request)?.signal,
        );
        await recheckSession(request);
        return result;
      },
    );
    routes.post(
      `${base}/files/metadata`,
      {
        logLevel: 'silent',
        bodyLimit: 8192,
        preHandler: reserveFileRead,
        schema: {
          ...schema('getGoogleFileV1', workspace, googleFileReferenceSchema),
          response: { 200: json(googleFileMetadataSchema) },
        },
      },
      async request => {
        const result = await dependencies.operations.fileMetadata(
          workspace.parse(request.params).workspaceId,
          user(request),
          request.body,
          fileRequests.get(request)?.signal,
        );
        await recheckSession(request);
        return result;
      },
    );
    routes.post(
      `${base}/files/content`,
      {
        logLevel: 'silent',
        bodyLimit: 8192,
        preHandler: reserveFileRead,
        schema: schema('readGoogleFileContentV1', workspace, googleFileContentRequestSchema),
      },
      async (request, reply) => {
        const result = await dependencies.operations.fileContent(
          workspace.parse(request.params).workspaceId,
          user(request),
          request.body,
          fileRequests.get(request)?.signal,
        );
        await recheckSession(request);
        if (result.kind === 'sheet-range') return result;
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
        reply.header('Content-Disposition', 'attachment');
        reply.header('Content-Length', result.byteLength);
        return reply
          .type(result.mimeType)
          .send(Buffer.from(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength));
      },
    );
    routes.get(
      `${base}/catalog`,
      { logLevel: 'silent', schema: schema('listGoogleOperationsV1', workspace) },
      async request => {
        const workspaceId = workspace.parse(request.params).workspaceId;
        await dependencies.runtime.transaction(workspaceId, commonCompatibility, async tx => {
          await lockAuthorization(tx);
          await resolveHuman(tx, user(request));
        });
        return { operations: googleOperationCatalog };
      },
    );
    routes.post(
      `${base}/read`,
      { logLevel: 'silent', bodyLimit: 2_101_248, schema: schema('readGoogleOperationV1', workspace, read) },
      async request =>
        z
          .json()
          .parse(
            await dependencies.operations.read(
              workspace.parse(request.params).workspaceId,
              user(request),
              read.parse(request.body),
            ),
          ),
    );
    routes.post(
      `${base}/proposals`,
      { logLevel: 'silent', bodyLimit: 2_101_248, schema: schema('proposeGoogleOperationV1', workspace, propose) },
      async request =>
        z
          .json()
          .parse(
            await dependencies.operations.propose(
              workspace.parse(request.params).workspaceId,
              user(request),
              propose.parse(request.body),
            ),
          ),
    );
    routes.get(
      `${base}/proposals`,
      {
        logLevel: 'silent',
        schema: {
          ...schema('listGoogleProposalsV1', workspace),
          querystring: json(googleProposalListQuerySchema),
          response: { 200: json(googleProposalListSchema) },
        },
      },
      request =>
        dependencies.operations.proposals(
          workspace.parse(request.params).workspaceId,
          user(request),
          googleProposalListQuerySchema.parse(request.query),
        ),
    );
    routes.get(
      `${base}/proposals/:proposalId`,
      { logLevel: 'silent', schema: schema('getGoogleProposalV1', proposal) },
      async request => {
        const p = proposal.parse(request.params);
        return z.json().parse(await dependencies.operations.proposal(p.workspaceId, user(request), p.proposalId));
      },
    );
    routes.post(
      `${base}/proposals/:proposalId/decision`,
      { logLevel: 'silent', bodyLimit: 1024, schema: schema('decideGoogleProposalV1', proposal, decision) },
      async request => {
        const p = proposal.parse(request.params);
        return z
          .json()
          .parse(await dependencies.approve(p.workspaceId, user(request), p.proposalId, decision.parse(request.body)));
      },
    );
    routes.post(
      `${base}/proposals/:proposalId/execute`,
      { logLevel: 'silent', schema: schema('executeGoogleProposalV1', proposal) },
      async request => {
        if (request.body !== undefined) z.never().parse(request.body);
        const p = proposal.parse(request.params);
        return z.json().parse(await dependencies.operations.execute(p.workspaceId, user(request), p.proposalId));
      },
    );
  });
}
