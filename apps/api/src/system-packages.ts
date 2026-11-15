import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { SystemPackageError, type createSystemPackages } from '@tulipfarm/agents/system-packages';
import {
  validateSystemPackageSchema,
  packageValidationSchema,
  importSystemPackageSchema,
  systemPackageInstallationSchema,
  installationResumeSchema,
  installationReviewSchema,
  installationApprovalSchema,
  installationListSchema,
} from '@tulipfarm/agents/system-package-contracts';
import { authConfig } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

export function registerSystemPackages(
  app: FastifyInstance,
  dependencies: {
    auth: Parameters<typeof authenticateRoutes>[1];
    service: ReturnType<typeof createSystemPackages>;
  },
) {
  const { service } = dependencies;
  app.register(async routes => {
    const validation = routeValidation({
      missing: 'Missing package validator',
      invalid: () => new SystemPackageError('invalid-request', 400),
    });
    validation.install(routes, true);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    const workspace = z.strictObject({ workspaceId: z.uuid() });
    const installation = workspace.extend({ installationId: z.uuid() });
    const errors = Object.fromEntries(
      [400, 401, 403, 404, 409, 503].map(code => [
        code,
        {
          type: 'object',
          properties: { error: { type: 'string' } },
          required: ['error'],
        },
      ]),
    );
    const schema = (operationId: string, params: z.ZodType, response: z.ZodType, body?: z.ZodType) => ({
      operationId,
      tags: ['System packages'],
      params: validation.json(params),
      ...(body ? { body: validation.json(body) } : {}),
      response: { 200: validation.json(response), ...errors },
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'installation-unavailable' });
      if (error instanceof SystemPackageError) return reply.code(error.status).send({ error: error.code });
      if (error instanceof z.ZodError || (error !== null && typeof error === 'object' && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(503).send({ error: 'installation-unavailable' });
    });
    routes.post(
      '/workspaces/:workspaceId/system-packages/validate',
      {
        logLevel: 'silent',
        bodyLimit: 64 * 1024 * 1024,
        schema: schema('validateSystemPackageV1', workspace, packageValidationSchema, validateSystemPackageSchema),
      },
      request => service.validate(workspace.parse(request.params).workspaceId, user(request), request.body),
    );
    const base = '/workspaces/:workspaceId/system-package-installations';
    routes.post(
      base,
      {
        logLevel: 'silent',
        bodyLimit: 64 * 1024 * 1024,
        schema: schema('importSystemPackageV1', workspace, systemPackageInstallationSchema, importSystemPackageSchema),
      },
      request => service.create(workspace.parse(request.params).workspaceId, user(request), request.body),
    );
    const query = z.strictObject({ after: z.uuid().optional(), chatId: z.uuid().optional() });
    routes.get(
      base,
      {
        logLevel: 'silent',
        schema: {
          ...schema('listSystemPackageInstallationsV1', workspace, installationListSchema),
          querystring: validation.json(query),
        },
      },
      request => {
        const q = query.parse(request.query);
        return service.list(workspace.parse(request.params).workspaceId, user(request), q.after, q.chatId);
      },
    );
    routes.get(
      `${base}/:installationId`,
      {
        logLevel: 'silent',
        schema: schema('readSystemPackageInstallationV1', installation, systemPackageInstallationSchema),
      },
      request => {
        const p = installation.parse(request.params);
        return service.read(p.workspaceId, user(request), p.installationId);
      },
    );
    routes.post(
      `${base}/:installationId/resume`,
      {
        logLevel: 'silent',
        schema: schema(
          'resumeSystemPackageInstallationV1',
          installation,
          systemPackageInstallationSchema,
          installationResumeSchema,
        ),
      },
      request => {
        const p = installation.parse(request.params);
        return service.resume(p.workspaceId, user(request), p.installationId, request.body);
      },
    );
    routes.post(
      `${base}/:installationId/approve`,
      {
        logLevel: 'silent',
        schema: schema(
          'approveSystemPackageInstallationV1',
          installation,
          systemPackageInstallationSchema,
          installationApprovalSchema,
        ),
      },
      request => {
        const p = installation.parse(request.params);
        return service.approve(p.workspaceId, user(request), p.installationId, request.body);
      },
    );
    routes.post(
      `${base}/:installationId/review`,
      {
        logLevel: 'silent',
        schema: schema(
          'reviewSystemPackageResourceV1',
          installation,
          systemPackageInstallationSchema,
          installationReviewSchema,
        ),
      },
      request => {
        const p = installation.parse(request.params);
        return service.review(p.workspaceId, user(request), p.installationId, request.body);
      },
    );
  });
}
