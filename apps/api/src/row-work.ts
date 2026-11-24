import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { TaskTableError } from '@tulipfarm/tables/tasks-table';
import {
  AssignmentLimitsError,
  assignmentLimitsInputSchema,
  assignmentLimitsSchema,
  commentInputSchema,
  createRowWork,
  inboxSchema,
  inboxSlackInputSchema,
  inboxSlackSchema,
  rowThreadSchema,
  taskActivitySchema,
  tasksTableSchema,
} from '@tulipfarm/agents/row-work';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { commonCompatibility, StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { authConfig, type registerAuth } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { requestBoundaryError, sourceCheckUnavailable } from './security.ts';
import { routeValidation } from './route-validation.ts';

/** Row threads, Run now, the Inbox and assignment limits. Behind the assignable-tasks flag. */
export function registerRowWork(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    runtime: Parameters<typeof createRowWork>[0];
  },
) {
  const service = createRowWork(dependencies.runtime, commonCompatibility);
  const workspace = z.object({ workspaceId: z.uuid() });
  const row = workspace.extend({ tableId: z.uuid(), rowId: z.uuid() });
  const comment = row.extend({ itemId: z.uuid() });
  const inboxItem = workspace.extend({ itemId: z.uuid() });
  const validation = routeValidation({
    missing: 'Missing row work validator',
    invalid: () => new Error('invalid-request'),
  });
  const errors = Object.fromEntries(
    [400, 401, 404, 503].map(status => [status, validation.json(z.object({ error: z.string() }))]),
  );
  const enabled = async (workspaceId: string) => {
    if (!(await isFeatureEnabled('assignable-tasks', null, { id: workspaceId }))) throw new AccessDenied();
  };

  app.register(async routes => {
    validation.install(routes, true);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (sourceCheckUnavailable(error, reply, 'row-work-unavailable')) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'not-found' });
      if (error instanceof AssignmentLimitsError) return reply.code(400).send({ error: error.code });
      if (error instanceof TaskTableError) return reply.code(error.status).send({ error: error.code });
      if (error instanceof StorageUnavailableError) return reply.code(503).send({ error: 'workspace-unavailable' });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(503).send({ error: 'row-work-unavailable' });
    });
    const thread = { 200: validation.json(rowThreadSchema), ...errors };
    const base = '/workspaces/:workspaceId/tables/:tableId/rows/:rowId';

    routes.get(
      `${base}/thread`,
      { logLevel: 'silent', schema: { operationId: 'rowThread', params: validation.json(row), response: thread } },
      async request => {
        const p = row.parse(request.params);
        await enabled(p.workspaceId);
        return service.thread(p.workspaceId, user(request), p.tableId, p.rowId);
      },
    );
    routes.post(
      `${base}/thread/comments`,
      {
        schema: {
          operationId: 'rowThreadComment',
          params: validation.json(row),
          body: validation.json(commentInputSchema),
          response: thread,
        },
      },
      async request => {
        const p = row.parse(request.params);
        await enabled(p.workspaceId);
        return service.comment(p.workspaceId, user(request), p.tableId, p.rowId, request.body);
      },
    );
    routes.patch(
      `${base}/thread/comments/:itemId`,
      {
        schema: {
          operationId: 'rowThreadCommentEdit',
          params: validation.json(comment),
          body: validation.json(commentInputSchema),
          response: thread,
        },
      },
      async request => {
        const p = comment.parse(request.params);
        await enabled(p.workspaceId);
        return service.editComment(p.workspaceId, user(request), p.tableId, p.rowId, p.itemId, request.body);
      },
    );
    routes.delete(
      `${base}/thread/comments/:itemId`,
      { schema: { operationId: 'rowThreadCommentDelete', params: validation.json(comment), response: thread } },
      async request => {
        const p = comment.parse(request.params);
        await enabled(p.workspaceId);
        return service.deleteComment(p.workspaceId, user(request), p.tableId, p.rowId, p.itemId);
      },
    );
    routes.post(
      `${base}/run-now`,
      { schema: { operationId: 'rowRunNow', params: validation.json(row), response: thread } },
      async request => {
        const p = row.parse(request.params);
        await enabled(p.workspaceId);
        return service.runNow(p.workspaceId, user(request), p.tableId, p.rowId);
      },
    );
    routes.post(
      `${base}/done`,
      { schema: { operationId: 'rowMarkDone', params: validation.json(row), response: thread } },
      async request => {
        const p = row.parse(request.params);
        await enabled(p.workspaceId);
        return service.completeTask(p.workspaceId, user(request), p.tableId, p.rowId);
      },
    );
    routes.delete(
      `${base}/done`,
      { schema: { operationId: 'rowReopen', params: validation.json(row), response: thread } },
      async request => {
        const p = row.parse(request.params);
        await enabled(p.workspaceId);
        return service.reopenTask(p.workspaceId, user(request), p.tableId, p.rowId);
      },
    );
    routes.delete(
      `${base}/wake`,
      { schema: { operationId: 'rowClearWake', params: validation.json(row), response: thread } },
      async request => {
        const p = row.parse(request.params);
        await enabled(p.workspaceId);
        return service.clearWake(p.workspaceId, user(request), p.tableId, p.rowId);
      },
    );
    routes.get(
      '/workspaces/:workspaceId/tasks-table',
      {
        logLevel: 'silent',
        schema: {
          operationId: 'workspaceTasksTable',
          params: validation.json(workspace),
          response: { 200: validation.json(tasksTableSchema), ...errors },
        },
      },
      async request => {
        const p = workspace.parse(request.params);
        await enabled(p.workspaceId);
        return service.tasksTable(p.workspaceId, user(request));
      },
    );
    routes.get(
      '/workspaces/:workspaceId/tasks/activity',
      {
        logLevel: 'silent',
        schema: {
          operationId: 'workspaceTaskActivity',
          params: validation.json(workspace),
          response: { 200: validation.json(taskActivitySchema), ...errors },
        },
      },
      async request => {
        const p = workspace.parse(request.params);
        await enabled(p.workspaceId);
        return service.taskActivity(p.workspaceId, user(request));
      },
    );
    routes.get(
      '/workspaces/:workspaceId/inbox',
      {
        logLevel: 'silent',
        schema: {
          operationId: 'workspaceInbox',
          params: validation.json(workspace),
          response: { 200: validation.json(inboxSchema), ...errors },
        },
      },
      async request => {
        const p = workspace.parse(request.params);
        await enabled(p.workspaceId);
        return service.inbox(p.workspaceId, user(request));
      },
    );
    routes.post(
      '/workspaces/:workspaceId/inbox/:itemId/done',
      {
        schema: {
          operationId: 'workspaceInboxDone',
          params: validation.json(inboxItem),
          response: { 200: validation.json(z.object({ ok: z.literal(true) })), ...errors },
        },
      },
      async request => {
        const p = inboxItem.parse(request.params);
        await enabled(p.workspaceId);
        await service.markDone(p.workspaceId, user(request), p.itemId);
        return { ok: true as const };
      },
    );
    const slack = { 200: validation.json(inboxSlackSchema), ...errors };
    routes.get(
      '/workspaces/:workspaceId/inbox/slack',
      { schema: { operationId: 'inboxSlack', params: validation.json(workspace), response: slack } },
      async request => {
        const p = workspace.parse(request.params);
        await enabled(p.workspaceId);
        return service.slackPreferences(p.workspaceId, user(request));
      },
    );
    routes.put(
      '/workspaces/:workspaceId/inbox/slack',
      {
        schema: {
          operationId: 'inboxSlackUpdate',
          params: validation.json(workspace),
          body: validation.json(inboxSlackInputSchema),
          response: slack,
        },
      },
      async request => {
        const p = workspace.parse(request.params);
        await enabled(p.workspaceId);
        return service.setSlackPreferences(p.workspaceId, user(request), request.body);
      },
    );
    const limits = { 200: validation.json(assignmentLimitsSchema), ...errors };
    routes.get(
      '/workspaces/:workspaceId/assignment-limits',
      { schema: { operationId: 'assignmentLimits', params: validation.json(workspace), response: limits } },
      async request => {
        const p = workspace.parse(request.params);
        await enabled(p.workspaceId);
        return service.limits(p.workspaceId, user(request));
      },
    );
    routes.put(
      '/workspaces/:workspaceId/assignment-limits',
      {
        schema: {
          operationId: 'assignmentLimitsUpdate',
          params: validation.json(workspace),
          body: validation.json(assignmentLimitsInputSchema),
          response: limits,
        },
      },
      async request => {
        const p = workspace.parse(request.params);
        await enabled(p.workspaceId);
        return service.setLimits(p.workspaceId, user(request), request.body);
      },
    );
  });
}
