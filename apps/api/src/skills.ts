import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied, SourceAuthorizationUnavailable, uuidSchema } from '@tulipfarm/access';
import { createWorkspaceSkills } from '@tulipfarm/agents/workspace-skills';
import {
  workspaceSkillSummarySchema,
  enableWorkspaceSkillSchema,
  reviewWorkspaceSkillSchema,
  setWorkspaceSkillLifecycleSchema,
  workspaceSkillDefinitionSchema,
  workspaceSkillDeletionSchema,
  workspaceSkillQuerySchema,
  workspaceSkillReceiptSchema,
  WorkspaceSkillError,
} from '@tulipfarm/agents/workspace-skill-contracts';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { authConfig } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';
import { skillSharingSchema } from '@tulipfarm/agents/workspace-skill-contracts';
import { isSkillScript, SkillPackageError } from '@tulipfarm/agents/skill-package-contracts';
import { configuredSkillRuntimeProbe } from '@tulipfarm/workflow-snippets/client';

export function registerSkills(
  app: FastifyInstance,
  dependencies: { runtime: WorkspaceRuntime; auth: Parameters<typeof authenticateRoutes>[1] },
) {
  const service = createWorkspaceSkills(dependencies.runtime);
  const available = configuredSkillRuntimeProbe();
  async function requireRuntime(
    p: { workspaceId: string; skillId: string },
    user: string,
    expectedVersion: number,
    review: boolean,
  ) {
    const detail = await service.read(p.workspaceId, user, p.skillId);
    if (detail.management?.version !== expectedVersion) return;
    const definition = review ? detail.definition : detail.reviewedDefinition;
    if (definition?.package?.manifest.files.some(file => isSkillScript(file.path)) && !(await available()))
      throw new SkillPackageError('runtime-unavailable');
  }
  const workspace = z.object({ workspaceId: uuidSchema });
  const skill = workspace.extend({ skillId: uuidSchema });
  const item = workspaceSkillSummarySchema;
  const page = workspaceSkillQuerySchema.extend({ limit: z.coerce.number().int().min(1).max(100).optional() });
  const detail = z.object({
    id: uuidSchema,
    revision: z.string(),
    definition: workspaceSkillDefinitionSchema,
    reviewedDefinition: workspaceSkillDefinitionSchema.nullable(),
    source: z.literal('workspace'),
    management: workspaceSkillReceiptSchema.nullable(),
    canReview: z.boolean(),
    lifecycle: z.enum(['active', 'archived']),
    canManageLifecycle: z.boolean(),
  });
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 409, 500, 503].map(status => [
      status,
      { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
    ]),
  );
  app.register(async routes => {
    const validation = routeValidation({
      missing: 'Missing skill validator',
      invalid: () => new Error('invalid-request'),
    });
    const { json } = validation;
    validation.install(routes);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    const schema = (operationId: string, summary: string, params: z.ZodType, output: z.ZodType, body?: z.ZodType) => ({
      operationId,
      summary,
      tags: ['Skills'],
      params: json(params),
      ...(body ? { body: json(body) } : {}),
      response: { 200: json(output), ...errors },
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof SourceAuthorizationUnavailable)
        return reply.code(503).send({ error: 'skill-operation-unavailable' });
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'skill-not-found' });
      if (error instanceof StorageUnavailableError)
        return reply
          .code(error.code === 'disabled' ? 404 : 503)
          .send({ error: error.code === 'disabled' ? 'skill-not-found' : 'skill-operation-unavailable' });
      if (error instanceof WorkspaceSkillError)
        return reply.code(error.code === 'limit-reached' ? 400 : 409).send({ error: error.code });
      if (error instanceof SkillPackageError) return reply.code(409).send({ error: error.code });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(503).send({ error: 'skill-operation-unavailable' });
    });
    const base = '/workspaces/:workspaceId/skills';
    routes.get(
      base,
      {
        schema: {
          ...schema(
            'listWorkspaceSkillsV1',
            'List visible workspace procedures',
            workspace,
            z.object({ workspace: z.array(item), nextCursor: uuidSchema.nullable() }),
          ),
          querystring: json(page),
        },
      },
      request => service.list(workspace.parse(request.params).workspaceId, user(request), page.parse(request.query)),
    );
    routes.get(
      `${base}/:skillId`,
      { schema: schema('readWorkspaceSkillV1', 'Read the saved draft or active reviewed procedure', skill, detail) },
      request => {
        const p = skill.parse(request.params);
        return service.read(p.workspaceId, user(request), p.skillId);
      },
    );
    routes.get(
      `${base}/:skillId/sharing`,
      { schema: schema('readSkillSharingV1', 'Read skill sharing grants', skill, skillSharingSchema) },
      request => {
        const p = skill.parse(request.params);
        return service.sharing(p.workspaceId, user(request), p.skillId);
      },
    );
    routes.put(
      `${base}/:skillId/sharing`,
      {
        schema: schema(
          'updateSkillSharingV1',
          'Update skill sharing grants',
          skill,
          z.object({ saved: z.boolean() }),
          skillSharingSchema,
        ),
      },
      request => {
        const p = skill.parse(request.params);
        return service.share(p.workspaceId, user(request), p.skillId, request.body);
      },
    );
    routes.put(
      `${base}/:skillId`,
      { schema: { operationId: 'retiredSaveWorkspaceSkillV1', params: json(skill) } },
      (request, reply) => {
        user(request);
        return reply.code(410).send({ error: 'skill-authoring-chat-only' });
      },
    );
    routes.post(
      `${base}/:skillId/review`,
      {
        schema: schema(
          'reviewWorkspaceSkillV1',
          'Activate the exact revision reviewed by a skill manager',
          skill,
          workspaceSkillReceiptSchema,
          reviewWorkspaceSkillSchema,
        ),
      },
      async request => {
        const p = skill.parse(request.params),
          input = reviewWorkspaceSkillSchema.parse(request.body);
        await requireRuntime(p, user(request), input.expectedVersion, true);
        return service.review(p.workspaceId, user(request), p.skillId, input);
      },
    );
    routes.put(
      `${base}/:skillId/enabled`,
      {
        schema: schema(
          'enableWorkspaceSkillV1',
          'Enable or disable reviewed procedure revisions',
          skill,
          workspaceSkillReceiptSchema,
          enableWorkspaceSkillSchema,
        ),
      },
      async request => {
        const p = skill.parse(request.params),
          input = enableWorkspaceSkillSchema.parse(request.body);
        if (input.enabled) await requireRuntime(p, user(request), input.expectedVersion, false);
        return service.setEnabled(p.workspaceId, user(request), p.skillId, input);
      },
    );
    routes.put(
      `${base}/:skillId/lifecycle`,
      {
        schema: schema(
          'setWorkspaceSkillLifecycleV1',
          'Archive, restore, or delete a workspace skill',
          skill,
          workspaceSkillReceiptSchema,
          setWorkspaceSkillLifecycleSchema,
        ),
      },
      request => {
        const p = skill.parse(request.params);
        return service.setLifecycle(p.workspaceId, user(request), p.skillId, request.body);
      },
    );
    routes.get(
      `${base}/:skillId/deletion`,
      {
        schema: schema(
          'previewWorkspaceSkillDeletionV1',
          'List the agents that keep a workspace skill from being deleted',
          skill,
          workspaceSkillDeletionSchema,
        ),
      },
      request => {
        const p = skill.parse(request.params);
        return service.deletion(p.workspaceId, user(request), p.skillId);
      },
    );
  });
}
