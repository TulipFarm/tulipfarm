import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied, lockAndResolveHuman } from '@tulipfarm/access';
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
  reminderInputSchema,
  remindersSchema,
  rowThreadSchema,
  taskActivitySchema,
  taskDetailSchema,
  taskKeysSchema,
  TaskReminderError,
  tasksTableSchema,
} from '@tulipfarm/agents/row-work';
import { createTaskClarifications, TaskClarificationError } from '@tulipfarm/agents/task-clarifications';
import {
  taskClarificationAnswerInputSchema,
  taskClarificationViewSchema,
} from '@tulipfarm/agents/task-clarification-contracts';
import { commonCompatibility, StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { authConfig, type registerAuth } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { requestBoundaryError, sourceCheckUnavailable } from './security.ts';
import { routeValidation } from './route-validation.ts';

/** Row threads, Run now, the Inbox and assignment limits. */
export function registerRowWork(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    runtime: Parameters<typeof createRowWork>[0] & Parameters<typeof createTaskClarifications>[0]['runtime'];
  },
) {
  const service = createRowWork(dependencies.runtime, commonCompatibility);
  const clarifications = createTaskClarifications({ runtime: dependencies.runtime });
  const workspace = z.object({ workspaceId: z.uuid() });
  const row = workspace.extend({ tableId: z.uuid(), rowId: z.uuid() });
  const clarificationParam = row.extend({ clarificationId: z.uuid() });
  const comment = row.extend({ itemId: z.uuid() });
  const inboxItem = workspace.extend({ itemId: z.uuid() });
  const taskKey = workspace.extend({ key: z.string().regex(/^tul-\d{1,10}$/i) });
  const reminder = row.extend({ reminderId: z.uuid() });
  const validation = routeValidation({
    missing: 'Missing row work validator',
    invalid: () => new Error('invalid-request'),
  });
  const errors = Object.fromEntries(
    [400, 401, 404, 409, 503].map(status => [status, validation.json(z.object({ error: z.string() }))]),
  );

  app.register(async routes => {
    validation.install(routes, true);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (sourceCheckUnavailable(error, reply, 'row-work-unavailable')) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'not-found' });
      if (error instanceof AssignmentLimitsError) return reply.code(400).send({ error: error.code });
      if (error instanceof TaskTableError) return reply.code(error.status).send({ error: error.code });
      if (error instanceof TaskReminderError) return reply.code(error.status).send({ error: error.code });
      if (error instanceof TaskClarificationError) {
        const status = error.code === 'not-found' ? 404 : error.code === 'already-answered' ? 409 : 400;
        return reply.code(status).send({ error: error.code });
      }
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
      request => {
        const p = row.parse(request.params);
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
      request => {
        const p = row.parse(request.params);
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
      request => {
        const p = comment.parse(request.params);
        return service.editComment(p.workspaceId, user(request), p.tableId, p.rowId, p.itemId, request.body);
      },
    );
    routes.delete(
      `${base}/thread/comments/:itemId`,
      { schema: { operationId: 'rowThreadCommentDelete', params: validation.json(comment), response: thread } },
      request => {
        const p = comment.parse(request.params);
        return service.deleteComment(p.workspaceId, user(request), p.tableId, p.rowId, p.itemId);
      },
    );
    routes.post(
      `${base}/run-now`,
      { schema: { operationId: 'rowRunNow', params: validation.json(row), response: thread } },
      request => {
        const p = row.parse(request.params);
        return service.runNow(p.workspaceId, user(request), p.tableId, p.rowId);
      },
    );
    routes.post(
      `${base}/done`,
      { schema: { operationId: 'rowMarkDone', params: validation.json(row), response: thread } },
      request => {
        const p = row.parse(request.params);
        return service.completeTask(p.workspaceId, user(request), p.tableId, p.rowId);
      },
    );
    routes.delete(
      `${base}/done`,
      { schema: { operationId: 'rowReopen', params: validation.json(row), response: thread } },
      request => {
        const p = row.parse(request.params);
        return service.reopenTask(p.workspaceId, user(request), p.tableId, p.rowId);
      },
    );
    routes.delete(
      `${base}/wake`,
      { schema: { operationId: 'rowClearWake', params: validation.json(row), response: thread } },
      request => {
        const p = row.parse(request.params);
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
      request => {
        const p = workspace.parse(request.params);
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
      request => {
        const p = workspace.parse(request.params);
        return service.taskActivity(p.workspaceId, user(request));
      },
    );
    const reminders = { 200: validation.json(remindersSchema), ...errors };
    routes.get(
      `${base}/reminders`,
      { schema: { operationId: 'taskReminders', params: validation.json(row), response: reminders } },
      async request => {
        const p = row.parse(request.params);
        return service.reminders(p.workspaceId, user(request), p.tableId, p.rowId);
      },
    );
    routes.post(
      `${base}/reminders`,
      {
        schema: {
          operationId: 'taskReminderCreate',
          params: validation.json(row),
          body: validation.json(reminderInputSchema),
          response: reminders,
        },
      },
      async request => {
        const p = row.parse(request.params);
        return service.createReminder(p.workspaceId, user(request), p.tableId, p.rowId, request.body);
      },
    );
    routes.delete(
      `${base}/reminders/:reminderId`,
      { schema: { operationId: 'taskReminderCancel', params: validation.json(reminder), response: reminders } },
      async request => {
        const p = reminder.parse(request.params);
        return service.cancelReminder(p.workspaceId, user(request), p.tableId, p.rowId, p.reminderId);
      },
    );
    routes.get(
      `${base}/clarifications`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'taskClarificationsList',
          params: validation.json(row),
          response: {
            200: validation.json(
              z.object({
                items: z.array(taskClarificationViewSchema),
              }),
            ),
            ...errors,
          },
        },
      },
      async request => {
        const p = row.parse(request.params);
        const actor = await dependencies.runtime.transaction(p.workspaceId, commonCompatibility, tx =>
          lockAndResolveHuman(tx, user(request)),
        );
        const items = await clarifications.listOpen(p.workspaceId, actor, p.tableId, p.rowId);
        return { items };
      },
    );
    routes.post(
      `${base}/clarifications/:clarificationId/answer`,
      {
        schema: {
          operationId: 'taskClarificationAnswer',
          params: validation.json(clarificationParam),
          body: validation.json(taskClarificationAnswerInputSchema),
          response: { 200: validation.json(z.object({ item: taskClarificationViewSchema })), ...errors },
        },
      },
      async request => {
        const p = clarificationParam.parse(request.params);
        const body = taskClarificationAnswerInputSchema.parse(request.body);
        const actor = await dependencies.runtime.transaction(p.workspaceId, commonCompatibility, tx =>
          lockAndResolveHuman(tx, user(request)),
        );
        const item = await clarifications.answer(
          p.workspaceId,
          actor,
          p.clarificationId,
          { answers: body.answers },
          'web',
          { tableId: p.tableId, rowId: p.rowId },
        );
        return { item };
      },
    );
    routes.get(
      '/workspaces/:workspaceId/tasks/keys',
      {
        logLevel: 'silent',
        schema: {
          operationId: 'workspaceTaskKeys',
          params: validation.json(workspace),
          response: { 200: validation.json(taskKeysSchema), ...errors },
        },
      },
      async request => {
        const p = workspace.parse(request.params);
        return service.taskKeys(p.workspaceId, user(request));
      },
    );
    routes.get(
      '/workspaces/:workspaceId/tasks/:key',
      {
        logLevel: 'silent',
        schema: {
          operationId: 'workspaceTaskByKey',
          params: validation.json(taskKey),
          response: { 200: validation.json(taskDetailSchema), ...errors },
        },
      },
      async request => {
        const p = taskKey.parse(request.params);
        return service.taskByKey(p.workspaceId, user(request), p.key);
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
      request => {
        const p = workspace.parse(request.params);
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
        await service.markDone(p.workspaceId, user(request), p.itemId);
        return { ok: true as const };
      },
    );
    const slack = { 200: validation.json(inboxSlackSchema), ...errors };
    routes.get(
      '/workspaces/:workspaceId/inbox/slack',
      { schema: { operationId: 'inboxSlack', params: validation.json(workspace), response: slack } },
      request => {
        const p = workspace.parse(request.params);
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
      request => {
        const p = workspace.parse(request.params);
        return service.setSlackPreferences(p.workspaceId, user(request), request.body);
      },
    );
    const limits = { 200: validation.json(assignmentLimitsSchema), ...errors };
    routes.get(
      '/workspaces/:workspaceId/assignment-limits',
      { schema: { operationId: 'assignmentLimits', params: validation.json(workspace), response: limits } },
      request => {
        const p = workspace.parse(request.params);
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
      request => {
        const p = workspace.parse(request.params);
        return service.setLimits(p.workspaceId, user(request), request.body);
      },
    );
  });
}
