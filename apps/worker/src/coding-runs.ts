import { planProviders, type PlanProvider } from '@tulipfarm/config';
import type { ConversationRuntime } from '@tulipfarm/conversations/runtime';
import type { ExecutionBackend, ExecutionConfiguration } from '@tulipfarm/execution-contract';
import { createCodingRuns, type CodingRunServices, type CodingRuns } from '@tulipfarm/agents/coding-runs';
import type { Subscriptions } from '@tulipfarm/integrations/subscriptions';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { githubChatReads } from './github-composition.ts';
import {
  isUnusablePlan,
  planCredentialsFromEnvironment,
  subscriptionsFromEnvironment,
  type PlanCredentials,
} from './member-plans.ts';

/** Builds coding runs for one runtime. Without a way for the member to approve each run, there are none. */
export type CodingRunsFactory = (runtime: ConversationRuntime) => CodingRuns | undefined;

export function codingRunServices(
  runtime: ConversationRuntime,
  approve: CodingRunServices['approve'],
  options: {
    subscriptions?: Subscriptions;
    credentials?: (provider: PlanProvider) => PlanCredentials;
    github?: CodingRunServices['github'];
  } = {},
): CodingRunServices {
  const subscriptions = options.subscriptions ?? subscriptionsFromEnvironment(runtime);
  const cached: Partial<Record<PlanProvider, PlanCredentials>> = {};
  const credentials = (provider: PlanProvider) =>
    (cached[provider] ??= options.credentials?.(provider) ?? planCredentialsFromEnvironment(runtime, provider));
  const planOn = (workspaceId: string, provider: PlanProvider) =>
    isFeatureEnabled(planProviders[provider].flag, null, { id: workspaceId });
  let reads: ReturnType<typeof githubChatReads> | undefined;
  return {
    enabled: workspaceId => isFeatureEnabled('coding-runs', null, { id: workspaceId }),
    async hasPlan(workspaceId, membershipId, provider) {
      if (!(await planOn(workspaceId, provider))) return false;
      return (await subscriptions.eligible(workspaceId, provider, membershipId)).length > 0;
    },
    async plan(workspaceId, membershipId, provider) {
      if (!(await planOn(workspaceId, provider))) return null;
      for (const candidate of await subscriptions.eligible(workspaceId, provider, membershipId)) {
        try {
          const token = await credentials(provider).accessToken(workspaceId, candidate.ownerMembershipId);
          await subscriptions.markUsed(workspaceId, candidate.connectionId).catch(() => undefined);
          return { connectionId: candidate.connectionId, ownerMembershipId: candidate.ownerMembershipId, token };
        } catch (error) {
          if (!isUnusablePlan(error)) throw error;
        }
      }
      return null;
    },
    github:
      options.github ??
      ((workspaceId, actor, origin) => (reads ??= githubChatReads(runtime)).cloneToken(workspaceId, actor, origin)),
    approve,
  };
}

export function codingRunsFactory(
  backend: ExecutionBackend,
  configuration: Exclude<ExecutionConfiguration, { mode: 'off' }>,
  approve: CodingRunServices['approve'] | undefined,
): CodingRunsFactory {
  return runtime =>
    approve ? createCodingRuns(backend, configuration, codingRunServices(runtime, approve)) : undefined;
}
