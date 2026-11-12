import { turnRequester } from '@tulipfarm/conversations/turn-requester';
import type { ConversationRuntime, ReplyFence } from '@tulipfarm/conversations/runtime';
import { AccessDenied } from '@tulipfarm/access';
import { planProviders, type PlanProvider } from '@tulipfarm/config';
import { createGitHubAccounts, githubConfiguration } from '@tulipfarm/github';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { ChatGptPlanError, createChatGptPlan } from '@tulipfarm/integrations/chatgpt';
import { copilotGitHubClient, createTokenPlan, TokenPlanError } from '@tulipfarm/integrations/token-plans';
import {
  createSubscriptions,
  type SubscriptionCandidate,
  type Subscriptions,
} from '@tulipfarm/integrations/subscriptions';
import type { PlanFailure } from '@tulipfarm/agents/inference';
import { isFeatureEnabled, log } from '@tulipfarm/observability';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

/** What a reply needs from a member's plan connection: a current token, and a way to ask the member to reconnect. */
export type PlanCredentials = {
  accessToken(workspaceId: string, membershipId: string): Promise<string>;
  requireReconnect(workspaceId: string, membershipId: string): Promise<unknown>;
};

/** The connections for `provider`'s plan. */
export function planCredentialsFromEnvironment(
  runtime: ConversationRuntime,
  provider: PlanProvider,
  env: NodeJS.ProcessEnv = process.env,
): PlanCredentials {
  const keyring = integrationCredentialKeyring(env);
  if (provider === 'chatgpt') return createChatGptPlan({ runtime, keyring });
  const github = provider === 'copilot' ? githubConfiguration(env) : null;
  return createTokenPlan({
    provider,
    runtime,
    keyring,
    ...(provider === 'copilot'
      ? {
          ...copilotGitHubClient(env),
          // A Copilot connection can use the member's personal GitHub account, whose token is read from there.
          ...(github
            ? {
                githubAccountToken: createGitHubAccounts({ runtime, configuration: github, keyring }).memberAccessToken,
              }
            : {}),
        }
      : {}),
    // Replies only read tokens; members connect through the API, which checks them.
    verify: async () => {
      throw new TokenPlanError(provider, 'unavailable');
    },
  });
}

const unusable = (error: unknown) => error instanceof ChatGptPlanError || error instanceof TokenPlanError;

export function subscriptionsFromEnvironment(runtime: ConversationRuntime) {
  return createSubscriptions({ runtime });
}

/** The member a turn's model calls run for; null for Slack and other turns without a member, which use workspace shares. */
export async function turnCaller(runtime: ConversationRuntime, fence: ReplyFence) {
  try {
    const requester = await runtime.transaction(fence.workspaceId, commonCompatibility, tx =>
      turnRequester(tx, fence.conversationId, fence.turnId),
    );
    return requester.membershipId;
  } catch (error) {
    if (error instanceof AccessDenied) return null;
    throw error;
  }
}

/**
 * The plans of one provider a turn may run on, in the order they are tried: the caller's own, then those shared with them, their
 * teams and the workspace. `current` is the plan answering now; `next` retires it for the reason given and moves to the
 * next plan with a usable token, or returns null when none is left so the workspace's fallback model answers. Tokens
 * are read here, inside the activity, so they never enter workflow history.
 */
export async function memberPlans(input: {
  provider: PlanProvider;
  credentials: PlanCredentials | null;
  subscriptions: Subscriptions;
  workspaceId: string;
  caller: string | null;
  model: string;
}) {
  const { credentials, subscriptions, workspaceId } = input;
  // While the workspace's flag for the plan is off, no plan answers and the workspace's fallback model does.
  const offered =
    credentials && (await isFeatureEnabled(planProviders[input.provider].flag, null, { id: workspaceId }));
  const candidates: SubscriptionCandidate[] = offered
    ? (await subscriptions.eligible(workspaceId, input.provider, input.caller)).filter(
        candidate =>
          !candidate.disabled.includes(input.model) &&
          (!candidate.models.length || candidate.models.includes(input.model)),
      )
    : [];
  let current: { candidate: SubscriptionCandidate; token: string } | null = null;

  async function advance(): Promise<string | null> {
    while (credentials && candidates.length) {
      const candidate = candidates.shift()!;
      try {
        const token = await credentials.accessToken(workspaceId, candidate.ownerMembershipId);
        current = { candidate, token };
        await subscriptions.markUsed(workspaceId, candidate.connectionId).catch(() => undefined);
        return token;
      } catch (error) {
        if (!unusable(error)) throw error;
        // A plan that can't give a token now (signed out, needs sign-in, plan turned off, vendor down) is skipped.
      }
    }
    current = null;
    return null;
  }

  async function retire(failure: PlanFailure, retryAfterMs?: number) {
    if (!current || !credentials) return;
    const { candidate } = current;
    log('warn', 'activity', 'call_completed', {
      operation: 'chat.plan-failover',
      outcome: failure,
    });
    if (failure === 'reconnect')
      await credentials.requireReconnect(workspaceId, candidate.ownerMembershipId).catch(() => undefined);
    else await subscriptions.coolDown(workspaceId, candidate.connectionId, retryAfterMs).catch(() => undefined);
  }

  const first = await advance();
  return {
    token: first,
    async next(failure: PlanFailure, retryAfterMs?: number) {
      await retire(failure, retryAfterMs);
      return advance();
    },
    retire,
  };
}
