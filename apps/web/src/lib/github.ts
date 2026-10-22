import { z } from 'zod';
import {
  accountListSchema,
  accountSchema,
  authorizationSchema,
  completionSchema,
  disconnectionSchema,
} from '@tulipfarm/github/contracts';
import { apiOrigin } from './auth';
import { jsonResponse, readJson, requestSignal, responseError } from './http';
import { selectionSchema } from '@tulipfarm/github/read-contracts';
import { batchDisplaySchema } from '@tulipfarm/github/batch-contracts';
import { investigationChoicesSchema, type selectInvestigationSchema } from '@tulipfarm/github/investigation-contracts';

export type GitHubAccount = z.infer<typeof accountSchema>;
export class GitHubRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export function githubError(error: unknown) {
  if (error instanceof GitHubRequestError) {
    if (error.status === 401) return 'Your session expired. Sign in again, then return to Integrations.';
    if (error.status === 404)
      return 'This account is unavailable to your current membership. Check your workspace access.';
    if (error.code === 'account-disabled') return 'Personal GitHub accounts are not configured on this server.';
    if (error.code === 'account-authorization-denied')
      return 'GitHub consent was denied. Return to Integrations and reconnect to try again.';
    if (error.code === 'account-limit-reached')
      return 'You have reached the account limit. Reconnect an existing account.';
    if (error.status === 409)
      return 'This integration needs fresh consent. Reconnect the same GitHub identity. For a different identity, connect another account.';
    if (error.status === 400)
      return 'The consent request was invalid or expired. Return to Integrations and start a new attempt.';
  }
  return 'The result could not be confirmed. Check account status before making another change.';
}
async function request<T>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown, signal?: AbortSignal) {
  const response = await jsonResponse(`${apiOrigin}/v1${path}`, {
    method,
    body,
    cache: 'no-store',
    signal: requestSignal(signal),
  });
  const value = await readJson(response, !response.ok);
  if (!response.ok) throw new GitHubRequestError(response.status, responseError(value, 'account-unavailable'));
  return schema.parse(value);
}
const base = (id: string) => `/workspaces/${encodeURIComponent(id)}/github/accounts`;
export const githubApi = {
  investigation: (workspaceId: string, id: string, task = false, signal?: AbortSignal) =>
    request(
      `/workspaces/${workspaceId}/github/${task ? 'tasks' : 'chats'}/${id}/investigation`,
      investigationChoicesSchema,
      'GET',
      undefined,
      signal,
    ),
  selectInvestigation: (
    workspaceId: string,
    id: string,
    task: boolean,
    input: z.input<typeof selectInvestigationSchema>,
  ) =>
    request(
      `/workspaces/${workspaceId}/github/${task ? 'tasks' : 'chats'}/${id}/investigation`,
      investigationChoicesSchema,
      'PUT',
      input,
    ),
  batches: (workspaceId: string, chatId: string, signal?: AbortSignal) =>
    request(
      `/workspaces/${workspaceId}/github/chats/${chatId}/batches`,
      z.object({ batches: z.array(batchDisplaySchema) }),
      'GET',
      undefined,
      signal,
    ),
  taskBatches: (workspaceId: string, taskId: string, signal?: AbortSignal) =>
    request(
      `/workspaces/${workspaceId}/github/tasks/${taskId}/batches`,
      z.object({ batches: z.array(batchDisplaySchema) }),
      'GET',
      undefined,
      signal,
    ),
  taskSelection: (workspaceId: string, taskId: string, signal?: AbortSignal) =>
    request(`/workspaces/${workspaceId}/github/tasks/${taskId}/selection`, selectionSchema, 'GET', undefined, signal),
  selectTask: (workspaceId: string, taskId: string, accountId: string | null, expectedVersion: number) =>
    request(`/workspaces/${workspaceId}/github/tasks/${taskId}/selection`, selectionSchema, 'PUT', {
      accountId,
      expectedVersion,
    }),
  selection: (workspaceId: string, chatId: string, signal?: AbortSignal) =>
    request(`/workspaces/${workspaceId}/github/chats/${chatId}/selection`, selectionSchema, 'GET', undefined, signal),
  select: (workspaceId: string, chatId: string, accountId: string | null, expectedVersion: number) =>
    request(`/workspaces/${workspaceId}/github/chats/${chatId}/selection`, selectionSchema, 'PUT', {
      accountId,
      expectedVersion,
    }),
  list: (workspaceId: string, signal?: AbortSignal) =>
    request(base(workspaceId), accountListSchema, 'GET', undefined, signal),
  begin: (workspaceId: string) => request(`${base(workspaceId)}/begin`, authorizationSchema, 'POST', {}),
  reconnect: (workspaceId: string, id: string) =>
    request(`${base(workspaceId)}/${id}/reconnect`, authorizationSchema, 'POST'),
  disconnect: (workspaceId: string, id: string) =>
    request(`${base(workspaceId)}/${id}/disconnect`, disconnectionSchema, 'POST'),
  complete: (body: unknown) => request('/github/oauth/callback', completionSchema, 'POST', body),
};
export function githubConsent(url: string) {
  const parsed = new URL(url);
  if (
    parsed.origin !== 'https://github.com' ||
    parsed.pathname !== '/login/oauth/authorize' ||
    parsed.username ||
    parsed.password
  )
    throw new Error('Unexpected consent destination');
  window.location.assign(parsed.href);
}
