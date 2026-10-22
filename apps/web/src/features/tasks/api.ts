import { z } from 'zod';
import {
  continueTaskSchema,
  reopenTaskSchema,
  startTaskSchema,
  taskReceiptSchema,
  taskHistoryQuerySchema,
  taskMessageSchema,
  taskSummarySchema,
} from '@tulipfarm/agents/task-contracts';
import { taskBatchStatusSchema, taskProposalViewSchema } from '@tulipfarm/agents/task-approval-contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';
export { taskStatusLabels, taskStatusLabel, taskStatusStates, taskNextStep } from './status';

export type TaskSummary = z.infer<typeof taskSummarySchema>;
export type TaskSources = z.infer<typeof startTaskSchema>['sources'];
export type TaskCommand =
  | {
      kind: 'start';
      input: z.infer<typeof startTaskSchema> & { mcpSelection?: { selectionId: string; version: number } };
    }
  | { kind: 'continue'; id: string; input: z.infer<typeof continueTaskSchema> }
  | { kind: 'reopen'; id: string; input: z.infer<typeof reopenTaskSchema> };
export type TaskProposal = z.infer<typeof taskProposalViewSchema>;
export type TaskAction =
  | { kind: 'decision'; digest: string; decision: 'approve' | 'reject' }
  | { kind: 'execute'; actionId: string }
  | { kind: 'recover'; requestId: string; generation: number };
export function taskApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${workspaceId}/agent-tasks`;
  async function request(path: string, signal?: AbortSignal, body?: unknown) {
    const response = await jsonResponse(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { body }),
      signal: signal ?? AbortSignal.timeout(15000),
    });
    const value = await readJson(response);
    if (!response.ok) {
      const code = z.object({ error: z.string() }).safeParse(value).data?.error ?? 'task-operation-unavailable';
      if (code === 'google-integration-required')
        throw new TableRequestError(
          response.status,
          code,
          'Google Drive files need your Google integration with Drive access. Reconnect Google Drive in Files, then send again. Your message is retained.',
        );
      if (code === 'activation-selection-required')
        throw new TableRequestError(
          response.status,
          code,
          'The server cannot determine which activation is latest. Pin a specific activation in Activated instructions, then start the task again. Your message is retained.',
        );
      throw new TableRequestError(
        response.status,
        code,
        code === 'stale-proposal'
          ? 'A row changed since this proposal. Request a refreshed proposal and review it again.'
          : response.status === 409
            ? 'The task or proposal changed. Refresh its status before taking another action.'
            : [401, 403, 404].includes(response.status)
              ? 'This private task or its source data is unavailable to your current membership.'
              : 'The task request could not be completed. Retry the read or check the operation status.',
      );
    }
    return value;
  }
  return {
    download: async (taskId: string, attachmentId: string) => {
      const response = await fetch(`${base}/${taskId}/attachments/${attachmentId}/content`, {
        credentials: 'include',
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new TableRequestError(
          response.status,
          'attachment-unavailable',
          'This retained file is unavailable. Check your current source access and retry.',
        );
      return response.blob();
    },
    command: async (command: TaskCommand) =>
      taskReceiptSchema.parse(
        await request(command.kind === 'start' ? '' : `/${command.id}/${command.kind}`, undefined, command.input),
      ),
    context: async (id: string, signal: AbortSignal) => {
      const messages: z.infer<typeof taskMessageSchema>[] = [];
      let after = -1;
      for (let page = 0; page < 40; page++) {
        const result = z
          .object({ messages: z.array(taskMessageSchema), nextCursor: z.number().nullable() })
          .parse(await request(`/${id}/history?after=${after}`, signal));
        messages.push(...result.messages);
        if (result.nextCursor === null) return messages;
        after = result.nextCursor;
      }
      throw new Error('Task history exceeds the supported view.');
    },
    list: async (signal: AbortSignal, after?: string, search = '') =>
      z
        .object({ tasks: z.array(taskSummarySchema), nextCursor: z.string().nullable() })
        .parse(
          await request(
            `?${new URLSearchParams({ ...(after ? { after } : {}), ...(search ? { search } : {}) })}`,
            signal,
          ),
        ),
    read: async (id: string, signal: AbortSignal) => taskSummarySchema.parse(await request(`/${id}`, signal)),
    history: async (id: string, signal: AbortSignal, after = -1) => {
      taskHistoryQuerySchema.parse({ after });
      return z
        .object({ messages: z.array(taskMessageSchema), nextCursor: z.number().nullable() })
        .parse(await request(`/${id}/history?after=${after}`, signal));
    },
    proposals: async (id: string, signal: AbortSignal, after?: string) =>
      z
        .object({ proposals: z.array(taskBatchStatusSchema), nextCursor: z.string().nullable() })
        .parse(await request(`/${id}/proposals${after ? `?after=${after}` : ''}`, signal)),
    proposal: async (taskId: string, id: string, signal: AbortSignal) =>
      taskProposalViewSchema.parse(await request(`/${taskId}/proposals/${id}`, signal)),
    action: async (taskId: string, id: string, command: TaskAction) => {
      const { kind, ...body } = command;
      const value = await request(`/${taskId}/proposals/${id}/${kind}`, undefined, body);
      return kind === 'recover'
        ? { kind: 'recovered' as const, proposal: taskProposalViewSchema.parse(value) }
        : { kind: 'status' as const, status: taskBatchStatusSchema.parse(value) };
    },
  };
}
export function taskCredits(units: string) {
  const value = BigInt(units),
    scale = 1_000_000_000_000n;
  const fraction = (value % scale).toString().padStart(12, '0').replace(/0+$/, '');
  return `${value / scale}${fraction ? `.${fraction}` : ''}`;
}
