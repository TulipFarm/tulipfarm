import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SourceAuthorizationUnavailable } from '@tulipfarm/access';
import {
  AgentLessonError,
  agentLessonEditSchema,
  agentLessonEntryParamsSchema as entry,
  agentLessonParamsSchema as agent,
  agentLessonsViewSchema,
  type AgentLessons,
} from '@tulipfarm/agents/agent-lessons-service';
import { authConfig, type registerAuth } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

/** What a saved agent learned from its earlier runs, for the people who can edit it. */
export function registerAgentLessons(
  app: FastifyInstance,
  dependencies: { auth: ReturnType<typeof registerAuth>['auth']; lessons: AgentLessons },
) {
  const { lessons } = dependencies;
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 422, 500, 503].map(status => [
      status,
      { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
    ]),
  );
  const validation = routeValidation({
    missing: 'Missing agent lessons validator',
    invalid: () => new AgentLessonError('not-found'),
  });
  const { json } = validation;
  const schema = (operationId: string, params: z.ZodType, body?: z.ZodType) => ({
    operationId,
    tags: ['Agents'],
    params: json(params),
    ...(body ? { body: json(body) } : {}),
    response: { 200: json(agentLessonsViewSchema), ...errors },
  });
  app.register(async routes => {
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    validation.install(routes);
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof AgentLessonError) return reply.code(error.status).send({ error: error.code });
      if (error instanceof SourceAuthorizationUnavailable)
        return reply.code(503).send({ error: 'agent-operation-unavailable' });
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(503).send({ error: 'agent-operation-unavailable' });
    });
    const base = '/workspaces/:workspaceId/agents/:agentId/lessons';
    routes.get(base, { schema: schema('getAgentLessonsV1', agent) }, request => {
      const p = agent.parse(request.params);
      return lessons.read(p.workspaceId, user(request), p.agentId);
    });
    routes.delete(base, { schema: schema('clearAgentLessonsV1', agent) }, request => {
      const p = agent.parse(request.params);
      return lessons.clear(p.workspaceId, user(request), p.agentId);
    });
    routes.put(`${base}/:entryId`, { schema: schema('updateAgentLessonV1', entry, agentLessonEditSchema) }, request => {
      const p = entry.parse(request.params);
      return lessons.edit(p.workspaceId, user(request), p.agentId, p.entryId, request.body);
    });
    routes.delete(`${base}/:entryId`, { schema: schema('deleteAgentLessonV1', entry) }, request => {
      const p = entry.parse(request.params);
      return lessons.remove(p.workspaceId, user(request), p.agentId, p.entryId);
    });
    routes.delete(`${base}/suggestions/:entryId`, { schema: schema('dismissAgentSuggestionV1', entry) }, request => {
      const p = entry.parse(request.params);
      return lessons.dismiss(p.workspaceId, user(request), p.agentId, p.entryId);
    });
  });
}
