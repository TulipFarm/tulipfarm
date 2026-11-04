import { z } from 'zod';
import { apiCallViewSchema, type ApiCallDecision } from '@tulipfarm/api-calls/contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';

export type { ApiCallView } from '@tulipfarm/api-calls/contracts';

const messages: Record<string, string> = {
  'api-call-not-found': 'This request is no longer available to you.',
  'api-call-conflict': 'This request changed or was already decided. Review it again.',
  'invalid-api-call-decision': 'Could not record your choice. Try again.',
};

export function apiCallErrorMessage(error: unknown) {
  return error instanceof TableRequestError
    ? error.message
    : 'We could not confirm the outcome. Check your connection and try again.';
}

export function apiCallsApi(workspaceId: string) {
  const workspace = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}`;
  async function request(url: string, signal: AbortSignal, method = 'GET', body?: unknown) {
    const response = await jsonResponse(url, { method, cache: 'no-store', signal, body });
    const value = await readJson(response, true);
    if (!response.ok) {
      const code = responseError(value, 'api-call-unavailable');
      throw new TableRequestError(
        response.status,
        code,
        messages[code] ?? 'Could not complete the request. Check your connection and try again.',
      );
    }
    return value;
  }
  const call = (id: string) => `${workspace}/api-calls/${encodeURIComponent(id)}`;
  return {
    get: async (id: string, signal: AbortSignal) => apiCallViewSchema.parse(await request(call(id), signal)),
    forTask: async (taskId: string, signal: AbortSignal) =>
      z
        .object({ calls: z.array(apiCallViewSchema) })
        .parse(await request(`${workspace}/agent-tasks/${encodeURIComponent(taskId)}/api-calls`, signal)).calls,
    /** Pass the same command ID when retrying, so a lost response replays instead of conflicting. */
    decide: async (id: string, decision: ApiCallDecision) =>
      apiCallViewSchema.parse(await request(`${call(id)}/decision`, AbortSignal.timeout(15_000), 'POST', decision)),
  };
}
