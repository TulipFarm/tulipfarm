import { codingRunViewSchema, type CodingRunDecision } from '@tulipfarm/agents/coding-run-contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';

export type { CodingRunView } from '@tulipfarm/agents/coding-run-contracts';

const messages: Record<string, string> = {
  'coding-run-not-found': 'This run is no longer available to you.',
  'coding-run-conflict': 'This run changed or was already decided. Review it again.',
  'invalid-coding-run-decision': 'Could not record your choice. Try again.',
};

export function codingRunErrorMessage(error: unknown) {
  return error instanceof TableRequestError
    ? error.message
    : 'We could not confirm your choice. Check your connection and try again.';
}

export function codingRunsApi(workspaceId: string) {
  const workspace = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}`;
  async function request(url: string, signal: AbortSignal, method = 'GET', body?: unknown) {
    const response = await jsonResponse(url, { method, cache: 'no-store', signal, body });
    const value = await readJson(response, true);
    if (!response.ok) {
      const code = responseError(value, 'coding-runs-unavailable');
      throw new TableRequestError(
        response.status,
        code,
        messages[code] ?? 'Could not complete the request. Check your connection and try again.',
      );
    }
    return value;
  }
  const run = (id: string) => `${workspace}/coding-runs/${encodeURIComponent(id)}`;
  return {
    get: async (id: string, signal: AbortSignal) => codingRunViewSchema.parse(await request(run(id), signal)),
    /** Pass the same command ID when retrying, so a lost response replays instead of conflicting. */
    decide: async (id: string, decision: CodingRunDecision) =>
      codingRunViewSchema.parse(await request(`${run(id)}/decision`, AbortSignal.timeout(15_000), 'POST', decision)),
  };
}
