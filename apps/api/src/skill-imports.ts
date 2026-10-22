import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied, SourceAuthorizationUnavailable, uuidSchema } from '@tulipfarm/access';
import { createSkillImports } from '@tulipfarm/agents/skill-imports';
import { configuredSkillRuntimeProbe } from '@tulipfarm/workflow-snippets/client';
import type { FileBytes } from '@tulipfarm/files';
import { createSkillPreviews } from '@tulipfarm/agents/skill-previews';
import { skillPreviewQuerySchema, skillPreviewSchema } from '@tulipfarm/agents/skill-import-contracts';
import { skillHistoryQuerySchema, skillHistoryPageSchema } from '@tulipfarm/agents/skill-import-contracts';
import {
  skillImportDecisionSchema,
  skillImportInputSchema,
  skillImportSelectionSchema,
  skillImportViewSchema,
  skillProvenanceSchema,
} from '@tulipfarm/agents/skill-import-contracts';
import { SkillPackageError } from '@tulipfarm/agents/skill-package-contracts';
import { workspaceSkillReceiptSchema, WorkspaceSkillError } from '@tulipfarm/agents/workspace-skill-contracts';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { authenticateRoutes } from './authenticated-routes.ts';
import { authConfig } from './auth.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

export function registerSkillImports(
  app: FastifyInstance,
  dependencies: { runtime: WorkspaceRuntime; auth: Parameters<typeof authenticateRoutes>[1]; objects: FileBytes },
) {
  const available = configuredSkillRuntimeProbe();
  const imports = createSkillImports(dependencies.runtime, undefined, available);
  const previews = createSkillPreviews(dependencies.runtime, dependencies.objects);
  const params = z.strictObject({ workspaceId: uuidSchema, importId: uuidSchema });
  app.register(async routes => {
    const validation = routeValidation({
      missing: 'Missing skill import validator',
      invalid: () => new Error('invalid-request'),
    });
    validation.install(routes);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof SourceAuthorizationUnavailable || error instanceof StorageUnavailableError)
        return reply.code(503).send({ error: 'skill-import-unavailable' });
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'skill-import-not-found' });
      if (error instanceof SkillPackageError)
        return reply
          .code(['source-unsupported', 'package-limit'].includes(error.code) ? 400 : 409)
          .send({ error: error.code });
      if (error instanceof WorkspaceSkillError) return reply.code(409).send({ error: error.code });
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return reply.code(400).send({ error: 'invalid-request' });
      app.log.error('Skill import request failed');
      return reply.code(503).send({ error: 'skill-import-unavailable' });
    });
    const base = '/workspaces/:workspaceId/skill-imports/:importId';
    const skill = z.strictObject({ workspaceId: uuidSchema, skillId: uuidSchema });
    routes.get(
      '/workspaces/:workspaceId/skills/:skillId/history',
      {
        schema: {
          operationId: 'readSkillHistoryV1',
          params: validation.json(skill),
          querystring: validation.json(skillHistoryQuerySchema),
          response: { 200: validation.json(skillHistoryPageSchema) },
        },
      },
      request => {
        const p = skill.parse(request.params);
        return imports.history(p.workspaceId, user(request), p.skillId, request.query);
      },
    );
    routes.get(
      '/workspaces/:workspaceId/skills/:skillId/runtime',
      {
        schema: {
          operationId: 'readSkillRuntimeV1',
          params: validation.json(skill),
          response: {
            200: validation.json(z.strictObject({ available: z.boolean(), profile: z.literal('skill-runtime-v1') })),
          },
        },
      },
      async request => {
        const p = skill.parse(request.params);
        await imports.provenance(p.workspaceId, user(request), p.skillId);
        return { available: await available(), profile: 'skill-runtime-v1' };
      },
    );
    const imported = params.extend({ candidateId: uuidSchema });
    routes.get(
      `${base}/packages/:candidateId/file`,
      {
        schema: {
          operationId: 'previewImportedSkillFileV1',
          params: validation.json(imported),
          querystring: validation.json(skillPreviewQuerySchema),
          response: { 200: validation.json(skillPreviewSchema) },
        },
      },
      request => {
        const p = imported.parse(request.params);
        return previews.imported(p.workspaceId, user(request), p.importId, p.candidateId, request.query);
      },
    );
    const installed = skill.extend({ revision: z.string().regex(/^[a-f0-9]{64}$/) });
    routes.get(
      '/workspaces/:workspaceId/skills/:skillId/revisions/:revision/file',
      {
        schema: {
          operationId: 'previewSkillFileV1',
          params: validation.json(installed),
          querystring: validation.json(skillPreviewQuerySchema),
          response: { 200: validation.json(skillPreviewSchema) },
        },
      },
      request => {
        const p = installed.parse(request.params);
        return previews.installed(p.workspaceId, user(request), p.skillId, p.revision, request.query);
      },
    );
    routes.get(
      '/workspaces/:workspaceId/skills/:skillId/provenance',
      {
        schema: {
          operationId: 'readSkillProvenanceV1',
          params: validation.json(skill),
          response: { 200: validation.json(skillProvenanceSchema.nullable()) },
        },
      },
      request => {
        const p = skill.parse(request.params);
        return imports.provenance(p.workspaceId, user(request), p.skillId);
      },
    );
    routes.put(
      '/workspaces/:workspaceId/skills/:skillId/updates/:importId',
      {
        schema: {
          operationId: 'prepareSkillUpdateV1',
          params: validation.json(skill.extend({ importId: uuidSchema })),
          response: { 200: validation.json(skillImportViewSchema) },
        },
      },
      request => {
        const p = skill.extend({ importId: uuidSchema }).parse(request.params);
        return imports.update(p.workspaceId, user(request), p.skillId, p.importId);
      },
    );
    const schema = (operationId: string, output: z.ZodType, body?: z.ZodType) => ({
      operationId,
      params: validation.json(params),
      ...(body ? { body: validation.json(body) } : {}),
      response: { 200: validation.json(output) },
    });
    routes.put(
      base,
      { schema: schema('prepareSkillImportV1', skillImportViewSchema, skillImportInputSchema) },
      request => {
        const p = params.parse(request.params);
        return imports.begin(p.workspaceId, user(request), p.importId, request.body);
      },
    );
    routes.get(base, { schema: schema('readSkillImportV1', skillImportViewSchema) }, request => {
      const p = params.parse(request.params);
      return imports.read(p.workspaceId, user(request), p.importId);
    });
    routes.put(
      `${base}/selection`,
      { schema: schema('selectSkillImportV1', skillImportViewSchema, skillImportSelectionSchema) },
      request => {
        const p = params.parse(request.params);
        return imports.select(p.workspaceId, user(request), p.importId, request.body);
      },
    );
    routes.post(`${base}/cancel`, { schema: schema('cancelSkillImportV1', skillImportViewSchema) }, request => {
      const p = params.parse(request.params);
      return imports.cancel(p.workspaceId, user(request), p.importId);
    });
    routes.put(
      `${base}/decision`,
      { schema: schema('approveSkillImportV1', z.array(workspaceSkillReceiptSchema), skillImportDecisionSchema) },
      request => {
        const p = params.parse(request.params);
        return imports.approve(p.workspaceId, user(request), p.importId, request.body);
      },
    );
  });
}
