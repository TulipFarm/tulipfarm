import {
  agentAuthoringErrorSchema,
  improvedAgentInstructionsSchema,
  agentPreviewReplySchema,
  type ImproveAgentInstructions,
  type PreviewAgentChat,
} from '@tulipfarm/agents/authoring-assistance-contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';

const messages: Record<string, string> = {
  'credits-exhausted': 'Your workspace has no available credits. Add credits in Usage, then try again.',
  'model-family-unavailable': 'This model is unavailable for your workspace. Your draft is unchanged.',
  'authoring-busy': 'Another authoring request is running in this workspace. Wait for it to finish, then try again.',
  'stale-snapshot': 'The model or selected skills changed. Reset the test chat before trying again.',
  'request-already-dispatched': 'This request was already sent. It will not be charged or sent again automatically.',
  'provider-output-too-large': 'The response exceeded the character limit. Your original instructions are unchanged.',
  'provider-empty-response': 'The model returned no text. Your draft is unchanged.',
  'provider-interrupted': 'The model did not finish its response. Your draft is unchanged.',
  'provider-refused': 'The model could not respond to this request. Edit your input and try again.',
  'provider-rate-limit': 'The model is busy. Wait a moment before trying again.',
  'timed-out': 'The model took too long. Your draft is unchanged. Credits may apply for work already done.',
  'credits-settlement-unavailable':
    'The credit charge could not be confirmed. Check workspace credits before starting another request.',
};

export function agentAuthoringApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/authoring`;
  async function request(path: string, input: unknown, signal: AbortSignal) {
    const response = await jsonResponse(`${base}/${path}`, {
      method: 'POST',
      body: input,
      signal: AbortSignal.any([signal, AbortSignal.timeout(55000)]),
      cache: 'no-store',
    });
    const value = await readJson(response);
    if (!response.ok) {
      const code = agentAuthoringErrorSchema.safeParse(value).data?.error ?? 'authoring-unavailable';
      throw new TableRequestError(
        response.status,
        code,
        [401, 403, 404].includes(response.status)
          ? 'Your access changed. Refresh this page before continuing.'
          : (messages[code] ??
              'The model request failed. Your draft is unchanged. Credits may apply for work already done.'),
      );
    }
    return value;
  }
  return {
    improve: async (input: ImproveAgentInstructions, signal: AbortSignal) =>
      improvedAgentInstructionsSchema.parse(await request('improve-instructions', input, signal)),
    preview: async (input: PreviewAgentChat, signal: AbortSignal) =>
      agentPreviewReplySchema.parse(await request('test-chat', input, signal)),
  };
}
