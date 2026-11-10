import { TableRequestError } from '../tables/request-state.ts';
import type { agentApi, AgentDetail } from './api.ts';

type Api = Pick<ReturnType<typeof agentApi>, 'detail' | 'policy' | 'replaceActivation'>;
type Definition = AgentDetail['definition'];
export type RevisionActivation = {
  requestId: string;
  savedRevision: string;
  policyVersion: number;
  activationIds: string[];
  scope: AgentDetail['activations'][number]['scope'];
};

export function needsActivationReview(previous: Definition, next: Definition) {
  const selections = (definition: Definition) => [
    definition.tools,
    definition.skills ?? [],
    definition.mcp ?? [],
    definition.modelFamilyId ?? null,
    definition.responseRule ?? 'tag',
  ];
  return JSON.stringify(selections(previous)) !== JSON.stringify(selections(next));
}

export async function activateRevision(api: Api, id: string, input: RevisionActivation) {
  const signal = AbortSignal.timeout(15000);
  const [detail, policy] = await Promise.all([api.detail(id, signal), api.policy(id, signal)]);
  if (detail.savedRevision !== input.savedRevision)
    throw new TableRequestError(409, 'definition-changed', 'A newer version was saved. Review it before activating.');
  if (!detail.capabilities.includes('manage'))
    throw new TableRequestError(403, 'activation-not-allowed', 'A manager needs to activate this version.');
  if (!policy.enabled)
    throw new TableRequestError(
      409,
      'execution-disabled',
      'Execution is off. Turn on Enable execution and save, then activate.',
    );
  if (policy.version !== input.policyVersion)
    throw new TableRequestError(
      409,
      'policy-version-conflict',
      'An agent, policy, or workspace definition changed. Refresh status and review your retained edits before saving again.',
    );
  await api.replaceActivation(id, {
    requestId: input.requestId,
    revision: detail.definitionRevision,
    scope: input.scope,
    expectedSavedRevision: input.savedRevision,
    expectedPolicyVersion: input.policyVersion,
    expectedActivationIds: input.activationIds,
  });
  return { name: detail.name, savedRevision: detail.savedRevision, revision: detail.definitionRevision };
}
