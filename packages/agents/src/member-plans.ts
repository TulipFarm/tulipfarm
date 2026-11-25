import type { ConversationRuntime } from '@tulipfarm/conversations/runtime';
import type { PlanProvider } from '@tulipfarm/config';
import { createGitHubAccounts, githubConfiguration } from '@tulipfarm/github';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { ChatGptPlanError, createChatGptPlan } from '@tulipfarm/integrations/chatgpt';
import { copilotGitHubClient, createTokenPlan, TokenPlanError } from '@tulipfarm/integrations/token-plans';
import {
  createSubscriptions,
  type SubscriptionCandidate,
  type Subscriptions,
} from '@tulipfarm/integrations/subscriptions';
import { log } from '@tulipfarm/observability';
import type { PlanFailure } from './inference.ts';

/** What a reply needs from a plan connection: a current token, and a way to ask its owner to reconnect. */
export type PlanCredentials = {
  accessToken(workspaceId: string, connectionId: string): Promise<string>;
  requireReconnect(workspaceId: string, connectionId: string): Promise<unknown>;
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

export const isUnusablePlan = (error: unknown) => error instanceof ChatGptPlanError || error instanceof TokenPlanError;

export function subscriptionsFromEnvironment(runtime: ConversationRuntime) {
  return createSubscriptions({ runtime });
}

/**
 * The plans of one provider a turn may run on, in the order they are tried: the plan the caller picked, then their other
 * own plans on for chats, then those shared with them, their
 * teams and the workspace. `current` is the plan answering now; `next` retires it for the reason given and moves to the
 * next plan with a usable token, or returns null when none is left: a chat then answers on the workspace's fallback model,
 * and an agent run stops. `own`
 * tells whether the plan tried last is the caller's own; `answered` records that the current plan wrote the reply. Tokens
 * are read here, inside the activity, so they never enter workflow history.
 */
export async function memberPlans(input: {
  provider: PlanProvider;
  credentials: PlanCredentials | null;
  subscriptions: Subscriptions;
  workspaceId: string;
  caller: string | null;
  model: string;
  /** The caller's plan connection to try first; ignored when it is not one they may use for chats. */
  preferredConnectionId?: string | null;
}) {
  const { credentials, subscriptions, workspaceId } = input;
  const candidates: SubscriptionCandidate[] = credentials
    ? (
        await subscriptions.eligible(
          workspaceId,
          input.provider,
          input.caller,
          'chat',
          input.preferredConnectionId ?? null,
        )
      ).filter(
        candidate =>
          !candidate.disabled.includes(input.model) &&
          (!candidate.models.length || candidate.models.includes(input.model)),
      )
    : [];
  let current: { candidate: SubscriptionCandidate; token: string } | null = null;
  // Whether the last plan that gave a token is the caller's own, so a fallback note can say "your plan".
  let lastOwn = false;
  // The plan the turn moved off last and why, for the Usage page's fallback detail.
  let switched: { from: string; failure: PlanFailure } | null = null;

  async function advance(): Promise<string | null> {
    while (credentials && candidates.length) {
      const candidate = candidates.shift()!;
      try {
        const token = await credentials.accessToken(workspaceId, candidate.connectionId);
        current = { candidate, token };
        lastOwn = input.caller !== null && candidate.ownerMembershipId === input.caller;
        await subscriptions.markUsed(workspaceId, candidate.connectionId).catch(() => undefined);
        return token;
      } catch (error) {
        if (!isUnusablePlan(error)) throw error;
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
      await credentials.requireReconnect(workspaceId, candidate.connectionId).catch(() => undefined);
    else
      await subscriptions
        .coolDown(workspaceId, candidate.connectionId, retryAfterMs, failure === 'usage-limit')
        .catch(() => undefined);
  }

  const first = await advance();
  return {
    token: first,
    async next(failure: PlanFailure, retryAfterMs?: number) {
      const from = (current as { candidate: SubscriptionCandidate } | null)?.candidate.connectionId;
      await retire(failure, retryAfterMs);
      if (from) switched = { from, failure };
      return advance();
    },
    /** The plan connection answering now, and the plan the turn moved off last with why, for usage records. */
    source: () => ({
      connectionId: (current as { candidate: SubscriptionCandidate } | null)?.candidate.connectionId ?? null,
      switched,
    }),
    retire,
    /** Records that the plan answering now wrote the reply, which clears a usage limit it reported earlier. */
    async answered() {
      if (current) await subscriptions.answered(workspaceId, current.candidate.connectionId).catch(() => undefined);
    },
    /** Whether the plan tried last belongs to the caller rather than a teammate, team or the workspace. */
    own: () => lastOwn,
  };
}

/**
 * Plan access for saved-agent runs, resolved as for chats: the member's own plans first, then those shared with them.
 * Credentials are built on first use, so deployments without a credential keyring still run agents on other models.
 */
export function memberPlanAccess(runtime: ConversationRuntime): MemberPlanAccess {
  const subscriptions = subscriptionsFromEnvironment(runtime);
  const credentials: Partial<Record<PlanProvider, PlanCredentials | null>> = {};
  const credentialsFor = (provider: PlanProvider) => {
    if (!(provider in credentials))
      try {
        credentials[provider] = planCredentialsFromEnvironment(runtime, provider);
      } catch {
        credentials[provider] = null;
      }
    return credentials[provider] ?? null;
  };
  return input =>
    memberPlans({
      provider: input.provider,
      credentials: credentialsFor(input.provider),
      subscriptions,
      workspaceId: input.workspaceId,
      caller: input.membershipId,
      model: input.model,
    });
}

/** The plans one member may run `model` on, in the order they are tried. */
export type MemberPlanAccess = (input: {
  provider: PlanProvider;
  workspaceId: string;
  membershipId: string;
  model: string;
}) => Promise<Pick<Awaited<ReturnType<typeof memberPlans>>, 'token' | 'next' | 'source' | 'answered'>>;
