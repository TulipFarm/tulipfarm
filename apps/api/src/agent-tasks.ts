import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied, uuidSchema } from '@tulipfarm/access';
import { createAgentTasks } from '@tulipfarm/agents/tasks';
import { createTaskApprovals, type createTaskApprovalDecision } from '@tulipfarm/agents/task-approvals';
import { createAgentExecutor } from '@tulipfarm/agents';
import {
  proposeTaskSchema,
  recoverTaskSchema,
  taskDecisionSchema,
  taskProposalViewSchema,
  taskBatchStatusSchema,
  executeTaskActionSchema,
  TaskApprovalError,
} from '@tulipfarm/agents/task-approval-contracts';
import {
  AgentTaskError,
  continueTaskSchema,
  reopenTaskSchema,
  startTaskSchema,
  taskHistoryQuerySchema,
  taskListQuerySchema,
  taskMessageSchema,
  taskReceiptSchema,
  taskSummarySchema,
} from '@tulipfarm/agents/task-contracts';
import type { createAttachments } from '@tulipfarm/conversations/attachments';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { authConfig } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

export function registerAgentTasks(
  app: FastifyInstance,
  dependencies: {
    runtime: WorkspaceRuntime;
    auth: Parameters<typeof authenticateRoutes>[1];
    attachments?: ReturnType<typeof createAttachments> | undefined;
    decide?: ReturnType<typeof createTaskApprovalDecision>;
    claimMcpSelection?: Parameters<typeof createAgentTasks>[1];
    wake?: (workspaceId: string, taskId: string) => Promise<void>;
  },
) {
  const service = createAgentTasks(dependencies.runtime, dependencies.claimMcpSelection);
  const approvals = createTaskApprovals(dependencies.runtime);
  const workspace = z.strictObject({ workspaceId: uuidSchema });
  const task = workspace.extend({ taskId: uuidSchema });
  const page = taskListQuerySchema.extend({ limit: z.coerce.number().int().min(1).max(100).default(25) });
  const historyPage = taskHistoryQuerySchema.extend({
    after: z.coerce.number().int().min(-1).default(-1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  });
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 409, 500, 503].map(status => [
      status,
      { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
    ]),
  );
  app.register(async routes => {
    const validation = routeValidation({
      missing: 'Missing task validator',
      invalid: () => new Error('invalid-request'),
    });
    const { json } = validation;
    validation.install(routes);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    const schema = (operationId: string, summary: string, params: z.ZodType, output: z.ZodType, body?: z.ZodType) => ({
      operationId,
      summary,
      tags: ['Agent tasks'],
      params: json(params),
      ...(body ? { body: json(body) } : {}),
      response: { 200: json(output), ...errors },
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'task-not-found' });
      if (error instanceof StorageUnavailableError)
        return reply
          .code(error.code === 'disabled' ? 404 : 503)
          .send({ error: error.code === 'disabled' ? 'task-not-found' : 'task-operation-unavailable' });
      if (error instanceof AgentTaskError) return reply.code(409).send({ error: error.code });
      if (error instanceof TaskApprovalError) return reply.code(409).send({ error: error.code });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(503).send({ error: 'task-operation-unavailable' });
    });
    const base = '/workspaces/:workspaceId/agent-tasks';
    routes.get(
      `${base}/recent`,
      {
        schema: schema(
          'recentAgentTasksV1',
          'Read the latest three source-authorized private task names',
          workspace,
          z.array(z.object({ id: uuidSchema, name: z.string() })),
        ),
      },
      request => service.recent(workspace.parse(request.params).workspaceId, user(request)),
    );
    routes.post(
      `${base}/:taskId/pause`,
      {
        logLevel: 'silent',
        schema: schema(
          'pauseAgentTaskV1',
          'Stop further task work without deleting history',
          task,
          taskReceiptSchema,
          z.strictObject({ expectedGeneration: z.number().int().nonnegative() }),
        ),
      },
      request => {
        const p = task.parse(request.params);
        return service.pause(p.workspaceId, user(request), p.taskId, request.body);
      },
    );
    const proposalParams = task.extend({ proposalId: uuidSchema });
    routes.get(
      `${base}/:taskId/proposals`,
      {
        schema: {
          ...schema(
            'listTaskProposalsV1',
            'List safe private proposal outcomes',
            task,
            z.object({ proposals: z.array(taskBatchStatusSchema), nextCursor: uuidSchema.nullable() }),
          ),
          querystring: json(z.strictObject({ after: uuidSchema.optional() })),
        },
      },
      request => {
        const p = task.parse(request.params);
        return approvals.list(
          p.workspaceId,
          user(request),
          p.taskId,
          z.object({ after: uuidSchema.optional() }).parse(request.query).after,
        );
      },
    );
    routes.post(
      `${base}/:taskId/proposals`,
      {
        logLevel: 'silent',
        schema: schema(
          'proposeTaskChangesV1',
          'Prepare immutable row changes without writing rows',
          task,
          taskProposalViewSchema,
          proposeTaskSchema,
        ),
      },
      request => {
        const p = task.parse(request.params);
        return approvals.propose(p.workspaceId, user(request), p.taskId, request.body);
      },
    );
    routes.get(
      `${base}/:taskId/proposals/:proposalId`,
      {
        logLevel: 'silent',
        schema: schema(
          'readTaskProposalV1',
          'Read exact source-revalidated changes',
          proposalParams,
          taskProposalViewSchema,
        ),
      },
      request => {
        const p = proposalParams.parse(request.params);
        return approvals.read(p.workspaceId, user(request), p.taskId, p.proposalId);
      },
    );
    routes.get(
      `${base}/:taskId/proposals/:proposalId/status`,
      {
        schema: schema(
          'readTaskProposalStatusV1',
          'Read safe action outcomes without source content',
          proposalParams,
          taskBatchStatusSchema,
        ),
      },
      request => {
        const p = proposalParams.parse(request.params);
        return approvals.status(p.workspaceId, user(request), p.taskId, p.proposalId);
      },
    );
    routes.post(
      `${base}/:taskId/proposals/:proposalId/decision`,
      {
        logLevel: 'silent',
        schema: schema(
          'decideTaskProposalV1',
          'Record an exact protected owner decision',
          proposalParams,
          taskBatchStatusSchema,
          taskDecisionSchema,
        ),
      },
      async request => {
        const p = proposalParams.parse(request.params);
        if (!dependencies.decide) throw new StorageUnavailableError('closed');
        const result = await dependencies.decide(p.workspaceId, user(request), p.taskId, p.proposalId, request.body);
        await dependencies.wake?.(p.workspaceId, p.taskId);
        return result;
      },
    );
    routes.post(
      `${base}/:taskId/proposals/:proposalId/recover`,
      {
        logLevel: 'silent',
        schema: schema(
          'recoverTaskProposalV1',
          'Refresh only unfinished changes for new owner review',
          proposalParams,
          taskProposalViewSchema,
          recoverTaskSchema,
        ),
      },
      request => {
        const p = proposalParams.parse(request.params);
        return approvals.recover(p.workspaceId, user(request), p.taskId, p.proposalId, request.body);
      },
    );
    routes.post(
      `${base}/:taskId/proposals/:proposalId/execute`,
      {
        logLevel: 'silent',
        schema: schema(
          'executeTaskProposalActionV1',
          'Execute an exact approved action with a transactional receipt',
          proposalParams,
          taskBatchStatusSchema,
          executeTaskActionSchema,
        ),
      },
      async request => {
        const p = proposalParams.parse(request.params);
        const proposal = await approvals.read(p.workspaceId, user(request), p.taskId, p.proposalId);
        const { actionId } = executeTaskActionSchema.parse(request.body);
        if (!proposal.actions.some(action => action.id === actionId)) throw new TaskApprovalError('proposal-conflict');
        await createAgentExecutor({ runtime: dependencies.runtime }).execute({
          workspaceId: p.workspaceId,
          runId: proposal.runId,
          callId: actionId,
        });
        await dependencies.wake?.(p.workspaceId, p.taskId);
        return approvals.status(p.workspaceId, user(request), p.taskId, p.proposalId);
      },
    );
    routes.post(
      base,
      {
        schema: schema(
          'startAgentTaskV1',
          'Queue a durable private agent task',
          workspace,
          taskReceiptSchema,
          startTaskSchema,
        ),
      },
      async request => {
        const p = workspace.parse(request.params);
        const result = await service.start(p.workspaceId, user(request), request.body);
        await dependencies.wake?.(p.workspaceId, result.id);
        return result;
      },
    );
    routes.post(
      `${base}/:taskId/continue`,
      {
        logLevel: 'silent',
        schema: schema(
          'continueAgentTaskV1',
          'Answer clarification or explicitly continue within task caps',
          task,
          taskReceiptSchema,
          continueTaskSchema,
        ),
      },
      async request => {
        const p = task.parse(request.params);
        const result = await service.continueTask(p.workspaceId, user(request), p.taskId, request.body);
        await dependencies.wake?.(p.workspaceId, p.taskId);
        return result;
      },
    );
    routes.get(
      base,
      {
        schema: {
          ...schema(
            'listAgentTasksV1',
            'List only the current owner incarnation tasks',
            workspace,
            z.object({ tasks: z.array(taskSummarySchema), nextCursor: uuidSchema.nullable() }),
          ),
          querystring: json(page),
        },
      },
      request => service.list(workspace.parse(request.params).workspaceId, user(request), page.parse(request.query)),
    );
    routes.get(
      `${base}/:taskId`,
      {
        schema: schema(
          'readAgentTaskV1',
          'Read private task identity and cumulative accounting',
          task,
          taskSummarySchema,
        ),
      },
      request => {
        const p = task.parse(request.params);
        return service.read(p.workspaceId, user(request), p.taskId);
      },
    );
    routes.get(
      `${base}/:taskId/history`,
      {
        schema: {
          ...schema(
            'readAgentTaskHistoryV1',
            'Read source-revalidated private task history',
            task,
            z.object({ messages: z.array(taskMessageSchema), nextCursor: z.number().nullable() }),
          ),
          querystring: json(historyPage),
        },
      },
      request => {
        const p = task.parse(request.params);
        return service.history(p.workspaceId, user(request), p.taskId, historyPage.parse(request.query));
      },
    );
    routes.post(
      `${base}/:taskId/reopen`,
      {
        schema: schema(
          'reopenAgentTaskV1',
          'Reopen a completed task without resetting its limits or accounting',
          task,
          taskReceiptSchema,
          reopenTaskSchema,
        ),
      },
      async request => {
        const p = task.parse(request.params);
        const result = await service.reopen(p.workspaceId, user(request), p.taskId, request.body);
        await dependencies.wake?.(p.workspaceId, p.taskId);
        return result;
      },
    );
    const attachmentParams = task.extend({ attachmentId: uuidSchema });
    routes.get(
      `${base}/:taskId/attachments/:attachmentId/content`,
      {
        logLevel: 'silent',
        schema: {
          ...schema(
            'downloadAgentTaskAttachmentV1',
            'Download an explicitly retained private chat attachment',
            attachmentParams,
            z.string(),
          ),
          response: { 200: { type: 'string', format: 'binary' }, ...errors },
        },
      },
      async (request, reply) => {
        const p = attachmentParams.parse(request.params);
        const source = await service.attachment(p.workspaceId, user(request), p.taskId, p.attachmentId);
        if (!dependencies.attachments) throw new StorageUnavailableError('incompatible_version');
        const result = await dependencies.attachments.download(
          p.workspaceId,
          user(request),
          source.conversationId,
          source.attachmentId,
        );
        await service.attachment(p.workspaceId, user(request), p.taskId, p.attachmentId);
        return reply
          .header('content-type', 'application/octet-stream')
          .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`)
          .header('x-content-type-options', 'nosniff')
          .send(Buffer.from(result.bytes));
      },
    );
  });
}
