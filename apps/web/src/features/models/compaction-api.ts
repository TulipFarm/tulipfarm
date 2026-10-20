import type { z } from 'zod';
import {
  compactionPolicyCommandSchema,
  compactionPolicyReceiptSchema,
  compactionPolicySchema,
} from '@tulipfarm/agents/compaction-policy-contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';

export type CompactionPolicy = z.infer<typeof compactionPolicySchema>;
export type CompactionPolicyCommand = z.infer<typeof compactionPolicyCommandSchema>;

const messages: Record<string, string> = {
  'compaction-policy-revision-conflict':
    'Another admin changed compaction settings. Reload the latest settings, review your retained choices, then save again.',
  'model-family-unavailable': 'A selected summary model is no longer available. Choose another approved summary model.',
  'workspace-disabled':
    'A selected summary model is turned off for this workspace. Turn it on above or choose another.',
  'idempotency-conflict': 'This save conflicts with an earlier save. Reload the latest settings before saving again.',
  'agent-not-found': 'Only workspace admins can change compaction settings, or your workspace access changed.',
  'sign-in-required': 'Your session expired. Sign in again to continue.',
  'invalid-request': 'The server rejected these values. Review the highlighted settings and try again.',
};

export function compactionApi(workspaceId: string) {
  const url = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/compaction-policy`;
  async function request(signal: AbortSignal, input?: CompactionPolicyCommand) {
    const response = await jsonResponse(url, { method: input ? 'PUT' : 'GET', cache: 'no-store', signal, body: input });
    const value = await readJson(response, true);
    if (!response.ok) {
      const code = responseError(value, 'compaction-policy-failed');
      throw new TableRequestError(
        response.status,
        code,
        messages[code] ??
          (response.status === 503
            ? 'Compaction settings are unavailable right now. Retry in a moment.'
            : 'Compaction settings could not be saved. Your choices are retained.'),
      );
    }
    return value;
  }
  return {
    read: async (signal: AbortSignal) => compactionPolicySchema.parse(await request(signal)),
    save: async (input: CompactionPolicyCommand, signal: AbortSignal) => {
      const receipt = compactionPolicyReceiptSchema.parse(
        await request(signal, compactionPolicyCommandSchema.parse(input)),
      );
      if (receipt.requestId !== input.requestId || receipt.revision !== input.expectedRevision + 1)
        throw new Error('Unconfirmed compaction settings receipt');
      return receipt;
    },
  };
}
