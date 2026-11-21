import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AccessDenied } from '@tulipfarm/access';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import {
  type createPersonalMemoryService,
  personalMemorySchema,
  savePersonalMemorySchema,
  deletePersonalMemorySchema,
  deleteMemoryFileSchema,
  memoryFileContentSchema,
  memoryFilePathSchema,
  memoryFilesSchema,
  memoryInstructionResultSchema,
  memoryInstructionSchema,
  MemoryEditsInvalid,
  MemoryFileNotFound,
  saveMemoryFileSchema,
  PersonalMemoryConflict,
  PersonalMemoryRejected,
  PersonalMemoryUnavailable,
} from '@tulipfarm/conversations/personal-memory';
import { AgentAuthoringError, agentAuthoringErrorSchema } from '@tulipfarm/agents/authoring-assistance-contracts';
import { agentAuthoringStatus } from './agent-authoring-assistance.ts';
import { authConfig, type registerAuth } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

const params = z.strictObject({ workspaceId: z.uuid() });
const validation = routeValidation({
  missing: 'Missing personal memory request validator',
  invalid: () => new Error('invalid-request'),
});
const failure = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
  additionalProperties: false,
};
function schema(
  operationId: string,
  summary: string,
  body?: z.ZodType,
  options: { querystring?: z.ZodType; response?: z.ZodType } = {},
) {
  return {
    operationId,
    summary,
    tags: ['Personal memory'],
    params: validation.json(params),
    ...(options.querystring ? { querystring: validation.json(options.querystring) } : {}),
    ...(body ? { body: validation.json(body) } : {}),
    response: {
      200: validation.json(options.response ?? personalMemorySchema),
      400: failure,
      401: failure,
      402: failure,
      403: failure,
      404: failure,
      409: failure,
      413: failure,
      422: failure,
      429: failure,
      500: failure,
      502: failure,
      503: failure,
      504: failure,
    },
  };
}

export function registerPersonalMemory(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    service: ReturnType<typeof createPersonalMemoryService>;
  },
) {
  app.register(async routes => {
    validation.install(routes);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'personal-memory-not-found' });
      if (error instanceof MemoryFileNotFound) return reply.code(404).send({ error: 'memory-file-not-found' });
      if (error instanceof AgentAuthoringError)
        return reply.code(agentAuthoringStatus(error)).send(agentAuthoringErrorSchema.parse({ error: error.code }));
      if (error instanceof MemoryEditsInvalid)
        return reply.code(502).send({ error: 'personal-memory-instruction-failed' });
      if (error instanceof PersonalMemoryConflict) return reply.code(409).send({ error: error.message });
      if (error instanceof StorageUnavailableError || error instanceof PersonalMemoryUnavailable)
        return reply.code(503).send({ error: 'personal-memory-unavailable' });
      if (error instanceof PersonalMemoryRejected) return reply.code(422).send({ error: 'personal-memory-rejected' });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(500).send({ error: 'personal-memory-operation-failed' });
    });
    const base = '/workspaces/:workspaceId/personal-memory';
    routes.get(base, { schema: schema('getPersonalMemoryV1', 'Read your personal memory') }, request =>
      dependencies.service.read(params.parse(request.params).workspaceId, user(request)),
    );
    routes.put(
      base,
      { schema: schema('savePersonalMemoryV1', 'Replace your personal memory', savePersonalMemorySchema) },
      request => dependencies.service.save(params.parse(request.params).workspaceId, user(request), request.body),
    );
    routes.delete(
      base,
      {
        schema: schema(
          'deletePersonalMemoryV1',
          'Delete your personal memory. It can be restored for 7 days.',
          deletePersonalMemorySchema,
        ),
      },
      request => dependencies.service.delete(params.parse(request.params).workspaceId, user(request), request.body),
    );
    routes.post(
      `${base}/undo`,
      {
        schema: schema(
          'undoPersonalMemoryV1',
          'Undo your last personal memory change, or restore deleted memory.',
          deletePersonalMemorySchema,
        ),
      },
      request => dependencies.service.undo(params.parse(request.params).workspaceId, user(request), request.body),
    );
    routes.post(
      `${base}/forget`,
      {
        schema: schema(
          'forgetPersonalMemoryV1',
          'Permanently erase your personal memory, including its history. This cannot be undone.',
          deletePersonalMemorySchema,
        ),
      },
      request => dependencies.service.forget(params.parse(request.params).workspaceId, user(request), request.body),
    );
    const files = `${base}/files`;
    routes.get(
      files,
      {
        schema: schema('listMemoryFilesV1', 'List your personal memory files with their text, You first.', undefined, {
          response: memoryFilesSchema,
        }),
      },
      request => dependencies.service.files(params.parse(request.params).workspaceId, user(request)),
    );
    routes.get(
      `${files}/read`,
      {
        schema: schema('readMemoryFileV1', 'Read one of your personal memory files.', undefined, {
          querystring: memoryFilePathSchema,
          response: memoryFileContentSchema,
        }),
      },
      request => dependencies.service.readFile(params.parse(request.params).workspaceId, user(request), request.query),
    );
    routes.put(
      files,
      {
        schema: schema(
          'saveMemoryFileV1',
          'Create or replace one of your personal memory files. Saving applies at once.',
          saveMemoryFileSchema,
          { response: memoryFileContentSchema },
        ),
      },
      request => dependencies.service.saveFile(params.parse(request.params).workspaceId, user(request), request.body),
    );
    routes.delete(
      files,
      {
        schema: schema(
          'deleteMemoryFileV1',
          'Delete one of your personal memory files. It can be restored for 7 days.',
          deleteMemoryFileSchema,
          { response: memoryFilesSchema },
        ),
      },
      request => dependencies.service.deleteFile(params.parse(request.params).workspaceId, user(request), request.body),
    );
    routes.post(
      `${base}/instruct`,
      {
        schema: schema(
          'instructPersonalMemoryV1',
          'Tell Bud what to remember or forget. Bud applies the changes to your files at once.',
          memoryInstructionSchema,
          { response: memoryInstructionResultSchema },
        ),
      },
      async (request, reply) => {
        const controller = new AbortController();
        const abort = () => {
          if (!reply.raw.writableEnded) controller.abort();
        };
        request.raw.on('aborted', abort);
        reply.raw.on('close', abort);
        try {
          return await dependencies.service.instruct(
            params.parse(request.params).workspaceId,
            user(request),
            request.body,
            controller.signal,
          );
        } finally {
          request.raw.off('aborted', abort);
          reply.raw.off('close', abort);
        }
      },
    );
  });
}
