import { z } from 'zod';
import { modelCatalogSchema } from '@tulipfarm/config/model-catalog';
import {
  modelPolicyCommandSchema,
  modelPolicyReceiptSchema,
  modelPolicyRuleSchema,
} from '@tulipfarm/agents/model-policy-contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { GovernanceRequestError, loadOwnMembership } from '@/lib/governance';
import { TableRequestError } from '@/features/tables/request-state';

export type ModelPolicyCommand = z.infer<typeof modelPolicyCommandSchema>;
export type ModelPolicyRule = z.infer<typeof modelPolicyRuleSchema>;
export type ModelPolicyReceipt = z.infer<typeof modelPolicyReceiptSchema>;

const messages: Record<string, string> = {
  'model-policy-revision-conflict':
    'Another admin changed this rule. Reload the latest rule, review your retained choice, then save deliberately.',
  'model-family-unavailable':
    'This model pair is no longer available. Refresh the catalog and choose an available fallback, or remove the fallback.',
  'idempotency-conflict':
    'This command identity has different saved input. Check its receipt before doing anything else.',
  'sign-in-required': 'Your session expired. Sign in again to continue.',
  'agent-not-found': 'This operation is unavailable or your workspace access changed.',
  'invalid-request': 'The server rejected these values. Review your fallback choice and try again.',
};

export function modelApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}`;
  async function request(path: string, signal: AbortSignal, input?: ModelPolicyCommand) {
    const response = await jsonResponse(`${base}${path}`, {
      method: input ? 'PUT' : 'GET',
      cache: 'no-store',
      signal,
      body: input,
    });
    const value = await readJson(response, true);
    if (!response.ok) {
      const code = responseError(value, 'model-operation-failed');
      throw new TableRequestError(
        response.status,
        code,
        messages[code] ?? 'The model operation could not be completed. Your input is retained.',
      );
    }
    return value;
  }
  function receipt(value: unknown, input: ModelPolicyCommand) {
    const result = modelPolicyReceiptSchema.parse(value);
    if (
      result.requestId !== input.requestId ||
      result.sourceFamilyId !== input.sourceFamilyId ||
      result.targetFamilyId !== input.targetFamilyId ||
      result.revision !== input.expectedRevision + 1
    )
      throw new Error('Unconfirmed model policy receipt');
    return result;
  }
  return {
    catalog: async (signal: AbortSignal) => {
      const catalog = modelCatalogSchema.parse(await request('/model-catalog', signal));
      // Families the platform cannot serve are hidden from every view; saved choices that point to them read as unset.
      return {
        ...catalog,
        families: catalog.families.filter(family => family.unavailableReason !== 'model-family-unavailable'),
      };
    },
    membership: async (signal: AbortSignal) => {
      try {
        return await loadOwnMembership(workspaceId, signal);
      } catch (error) {
        if (error instanceof GovernanceRequestError)
          throw new TableRequestError(error.status, error.code, 'Could not verify your current workspace role.');
        throw error;
      }
    },
    rule: async (source: string, signal: AbortSignal) => {
      const rule = modelPolicyRuleSchema.parse(
        await request(`/model-policy/rules/${encodeURIComponent(source)}`, signal),
      );
      if (rule.sourceFamilyId !== source) throw new Error('Unexpected model policy source');
      return rule;
    },
    save: async (input: ModelPolicyCommand, signal: AbortSignal) => {
      return receipt(await request('/model-policy', signal, modelPolicyCommandSchema.parse(input)), input);
    },
    command: async (input: ModelPolicyCommand, signal: AbortSignal) => {
      return receipt(await request(`/model-policy/commands/${encodeURIComponent(input.requestId)}`, signal), input);
    },
  };
}
