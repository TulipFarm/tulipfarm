import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { TableRequestError } from './request-state';
import { memberMessages } from './api';
import {
  tableProposalOutcomeSchema,
  proposalEffectsSchema,
  proposalStatusSchema,
  proposalViewSchema,
  type ProposalCommand,
} from './review-contracts';

const messages: Record<string, string> = {
  'proposal-stale':
    'Affected data or permissions changed. Ask the assistant for a new proposal and review its updated effects.',
  'proposal-expired': 'This proposal expired. Ask the assistant for a new proposal before approving.',
  'proposal-conflict': 'This proposal already has a different decision or command. Check its current status.',
  'proposal-cancelled': 'This proposal is cancelled. Check its status before resuming unfinished work.',
  'proposal-storage-unavailable': 'Table changes are temporarily unavailable. Retry loading this proposal.',
  'table-title-immutable':
    'Table names and titles are fixed. Ask the assistant for a new proposal that changes only the fields or records.',
  'table-name-unavailable': 'A linked table is not ready. Wait for its setup to finish, then retry.',
};

export function proposalApi(workspaceId: string, chatId: string, proposalId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(chatId)}/table-changes/${encodeURIComponent(proposalId)}`;
  async function request(path: string, signal: AbortSignal, body?: ProposalCommand) {
    const response = await jsonResponse(`${base}${path}`, {
      method: body ? 'PUT' : 'GET',
      body,
      signal,
      cache: 'no-store',
    });
    const value = await readJson(response, true);
    if (!response.ok) {
      const code = responseError(value, 'proposal-unavailable');
      throw new TableRequestError(
        response.status,
        code,
        messages[code] ??
          memberMessages[code] ??
          (response.status === 401
            ? 'Your session expired. Sign in to continue.'
            : [403, 404].includes(response.status)
              ? 'This proposal is missing or your permission changed. A workspace admin can review your access.'
              : 'The proposal request could not be confirmed. Check status before retrying.'),
      );
    }
    return value;
  }
  return {
    outcome: async (signal: AbortSignal) => tableProposalOutcomeSchema.parse(await request('/outcome', signal)),
    read: async (signal: AbortSignal) => {
      const view = proposalViewSchema.parse(await request('', signal));
      if (
        view.id !== proposalId ||
        view.manifest.id !== proposalId ||
        view.manifest.workspaceId !== workspaceId ||
        view.manifest.conversationId !== chatId
      )
        throw new Error('Proposal identity mismatch');
      return view;
    },
    status: async (signal: AbortSignal) => proposalStatusSchema.parse(await request('/status', signal)),
    effects: async (tableId: string, after: number, signal: AbortSignal) =>
      proposalEffectsSchema.parse(
        await request(`/tables/${encodeURIComponent(tableId)}/effects?after=${after}&limit=20`, signal),
      ),
    command: async (input: ProposalCommand) =>
      proposalStatusSchema.parse(
        await request('decision' in input ? '/decision' : '/control', AbortSignal.timeout(15_000), input),
      ),
  };
}
export type ProposalApi = ReturnType<typeof proposalApi>;
