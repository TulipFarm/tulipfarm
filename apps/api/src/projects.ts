import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { AccessDenied } from '@tulipfarm/access';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import {
  type createProjects,
  addFileSchema,
  fileAudienceSchema,
  ProjectFileAudience,
  ProjectSourceUnavailable,
  knowledgeInputSchema,
  knowledgeSchema,
  knowledgeStateSchema,
  knowledgeUploadSchema,
  projectSourceViewSchema,
  promoteAttachmentSchema,
} from '@tulipfarm/conversations/projects';
import {
  createProjectSchema,
  editProjectSchema,
  projectMemberSchema,
  projectSchema,
  ProjectConflict,
  ProjectManagerRequired,
} from '@tulipfarm/conversations/project-membership';
import { KnowledgeExtractionError } from '@tulipfarm/conversations/knowledge-extraction';
import { AttachmentError } from '@tulipfarm/conversations/attachments';
import { authConfig, type registerAuth } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

const workspace = z.strictObject({ workspaceId: z.uuid() });
const project = workspace.extend({ projectId: z.uuid() });
const knowledge = project.extend({ knowledgeId: z.uuid() });
const source = project.extend({ revisionId: z.uuid() });
const identity = z.object({ id: z.uuid() });
const saved = z.object({ saved: z.boolean() });
const person = { name: z.string(), email: z.string() };
const member = z.object({ membershipId: z.uuid(), userId: z.string(), role: z.enum(['manager', 'member']), ...person });
const detail = z.object({ project: projectSchema, members: z.array(member), files: z.array(knowledgeSchema) });
const createBody = createProjectSchema.omit({ id: true });
const uploadQuery = knowledgeUploadSchema
  .omit({ expectedRevision: true })
  .extend({ expectedRevision: z.uuid().optional() });
const added = z.object({ id: z.uuid(), revisionId: z.uuid() });
const audience = z.object({
  readers: z.number().int(),
  files: z.array(
    z.discriminatedUnion('status', [
      z.object({ fileId: z.uuid(), status: z.literal('ready') }),
      z.object({ fileId: z.uuid(), status: z.literal('unavailable') }),
      z.object({
        fileId: z.uuid(),
        status: z.literal('audience'),
        missing: z.array(z.object({ membershipId: z.uuid(), name: z.string() })).nullable(),
      }),
    ]),
  ),
});
const failure = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
  additionalProperties: false,
};
const validation = routeValidation({
  missing: 'Missing project request validator',
  invalid: () => new Error('invalid-request'),
});
const { json } = validation;
function schema(
  operationId: string,
  summary: string,
  params: z.ZodType,
  response: z.ZodType,
  body?: z.ZodType,
  query?: z.ZodType,
) {
  return {
    operationId,
    summary,
    tags: ['Projects'],
    params: json(params),
    ...(body ? { body: json(body) } : {}),
    ...(query ? { querystring: json(query) } : {}),
    response: {
      200: json(response),
      400: failure,
      401: failure,
      403: failure,
      404: failure,
      409: failure,
      413: failure,
      429: failure,
      500: failure,
      503: failure,
    },
  };
}

export function registerProjects(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    identity: Pool;
    service: ReturnType<typeof createProjects>;
  },
) {
  const { service } = dependencies;
  async function named<T extends { userId: string }>(people: T[]) {
    const rows = z
      .array(z.object({ id: z.string(), name: z.string(), email: z.string() }))
      .parse(
        (
          await dependencies.identity.query('SELECT id, name, email FROM app.users WHERE id = ANY($1)', [
            people.map(item => item.userId),
          ])
        ).rows,
      );
    const found = new Map(rows.map(row => [row.id, row]));
    return people.map(item => ({
      ...item,
      name: found.get(item.userId)?.name ?? 'Former member',
      email: found.get(item.userId)?.email ?? '',
    }));
  }
  app.register(async routes => {
    validation.install(routes);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    routes.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 },
      (_request, body, done) => done(null, body),
    );
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'project-not-found' });
      if (
        error instanceof ProjectConflict ||
        error instanceof ProjectManagerRequired ||
        error instanceof ProjectFileAudience ||
        error instanceof ProjectSourceUnavailable ||
        error instanceof KnowledgeExtractionError ||
        error instanceof AttachmentError
      )
        return reply.code(409).send({ error: error.message });
      if (error instanceof StorageUnavailableError) return reply.code(503).send({ error: 'projects-unavailable' });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(500).send({ error: 'project-operation-failed' });
    });
    const base = '/workspaces/:workspaceId/projects';
    routes.get(
      base,
      { schema: schema('listProjectsV1', 'List accessible projects', workspace, z.array(projectSchema)) },
      request => service.list(workspace.parse(request.params).workspaceId, user(request)),
    );
    routes.put(
      `${base}/:projectId`,
      { schema: schema('createProjectV1', 'Create a project', project, projectSchema, createBody) },
      request => {
        const p = project.parse(request.params);
        return service.create(p.workspaceId, user(request), { ...createBody.parse(request.body), id: p.projectId });
      },
    );
    routes.get(
      `${base}/:projectId`,
      { schema: schema('getProjectV1', 'Read a project with members and knowledge', project, detail) },
      async request => {
        const p = project.parse(request.params);
        const detail = await service.read(p.workspaceId, user(request), p.projectId);
        return { ...detail, members: await named(detail.members) };
      },
    );
    routes.patch(
      `${base}/:projectId`,
      {
        schema: schema(
          'editProjectV1',
          'Edit, archive or restore a project',
          project,
          projectSchema,
          editProjectSchema,
        ),
      },
      request => {
        const p = project.parse(request.params);
        return service.edit(p.workspaceId, user(request), p.projectId, request.body);
      },
    );
    routes.put(
      `${base}/:projectId/members`,
      {
        schema: schema(
          'setProjectMemberV1',
          'Add, remove or change a project member',
          project,
          saved,
          projectMemberSchema,
        ),
      },
      request => {
        const p = project.parse(request.params);
        return service.member(p.workspaceId, user(request), p.projectId, request.body);
      },
    );
    routes.put(
      `${base}/:projectId/knowledge/:knowledgeId`,
      {
        bodyLimit: 2 * 1024 * 1024,
        schema: schema(
          'saveProjectKnowledgeV1',
          'Save pasted project knowledge',
          knowledge,
          identity,
          knowledgeInputSchema,
        ),
      },
      request => {
        const p = knowledge.parse(request.params);
        return service.saveKnowledge(p.workspaceId, user(request), p.projectId, p.knowledgeId, request.body);
      },
    );
    routes.put(
      `${base}/:projectId/knowledge/:knowledgeId/file`,
      {
        bodyLimit: 10 * 1024 * 1024,
        schema: schema(
          'uploadProjectKnowledgeV1',
          'Upload a project knowledge file',
          knowledge,
          identity,
          undefined,
          uploadQuery,
        ),
      },
      request => {
        const p = knowledge.parse(request.params),
          q = uploadQuery.parse(request.query);
        if (!Buffer.isBuffer(request.body)) throw new KnowledgeExtractionError('unreadable-file');
        return service.upload(
          p.workspaceId,
          user(request),
          p.projectId,
          p.knowledgeId,
          { ...q, expectedRevision: q.expectedRevision ?? null },
          request.body,
        );
      },
    );
    routes.patch(
      `${base}/:projectId/knowledge/:knowledgeId`,
      {
        schema: schema(
          'setProjectKnowledgeStateV1',
          'Pin, unpin or remove project knowledge',
          knowledge,
          identity,
          knowledgeStateSchema,
        ),
      },
      request => {
        const p = knowledge.parse(request.params);
        return service.knowledgeState(p.workspaceId, user(request), p.projectId, p.knowledgeId, request.body);
      },
    );
    routes.get(
      `${base}/:projectId/sources/:revisionId`,
      { schema: schema('getProjectSourceV1', 'Read a project knowledge revision', source, projectSourceViewSchema) },
      request => {
        const p = source.parse(request.params);
        return service.source(p.workspaceId, user(request), p.projectId, p.revisionId);
      },
    );
    routes.post(
      `${base}/:projectId/file-audience`,
      {
        schema: schema(
          'checkProjectFileAudienceV1',
          'Check whether everyone who reads a project can open each file',
          project,
          audience,
          fileAudienceSchema,
        ),
      },
      async request => {
        const p = project.parse(request.params);
        const result = await service.fileAudience(p.workspaceId, user(request), p.projectId, request.body);
        const people = await named(
          result.files.flatMap(file => (file.status === 'audience' && file.missing ? file.missing : [])),
        );
        const names = new Map(people.map(person => [person.membershipId, person.name]));
        return {
          readers: result.readers,
          files: result.files.map(file =>
            file.status !== 'audience'
              ? file
              : {
                  fileId: file.fileId,
                  status: file.status,
                  missing:
                    file.missing?.map(member => ({
                      membershipId: member.membershipId,
                      name: names.get(member.membershipId) ?? 'Workspace member',
                    })) ?? null,
                },
          ),
        };
      },
    );
    routes.post(
      `${base}/:projectId/files`,
      {
        schema: schema(
          'addProjectFileV1',
          'Add the text of a file from Files to a project',
          project,
          added,
          addFileSchema,
        ),
      },
      request => {
        const p = project.parse(request.params);
        return service.addFile(p.workspaceId, user(request), p.projectId, request.body);
      },
    );
    routes.post(
      `${base}/:projectId/promotions`,
      {
        schema: schema(
          'promoteProjectAttachmentV1',
          'Save a project chat attachment as knowledge',
          project,
          identity,
          promoteAttachmentSchema,
        ),
      },
      request => {
        const p = project.parse(request.params);
        return service.promote(p.workspaceId, user(request), p.projectId, request.body);
      },
    );
  });
}
