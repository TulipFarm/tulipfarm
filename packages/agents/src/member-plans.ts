import type { ConversationRuntime } from '@tulipfarm/conversations/runtime';
import { isByokProvider, planModelOfFamily, type PlanProvider } from '@tulipfarm/config';
import { createGitHubAccounts, githubConfiguration } from '@tulipfarm/github';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { ByokPlanError, createByokPlans } from '@tulipfarm/integrations/byok-plans';
import { ChatGptPlanError, createChatGptPlan } from '@tulipfarm/integrations/chatgpt';
import { copilotGitHubClient, createTokenPlan, TokenPlanError } from '@tulipfarm/integrations/token-plans';
import {
  createSubscriptions,
  type SubscriptionCandidate,
  type SubscriptionModel,
  type Subscriptions,
} from '@tulipfarm/integrations/subscriptions';
import { log } from '@tulipfarm/observability';
import type { PlanFailure } from './inference.ts';

/** What a reply needs from a plan or BYOK connection: a current token/key, optional custom endpoint, and reconnect trigger. */
export type PlanCredentials = {
  accessToken(workspaceId: string, connectionId: string): Promise<string>;
  accessCredential?(
    workspaceId: string,
    connectionId: string,
  ): Promise<{ token: string; endpoint: string | null; generation?: number }>;
  requireReconnect(workspaceId: string, connectionId: string, generation?: number): Promise<unknown>;
};

/** The connections for `provider`'s plan or BYOK API key provider. */
export function planCredentialsFromEnvironment(
  runtime: ConversationRuntime,
  provider: PlanProvider,
  env: NodeJS.ProcessEnv = process.env,
): PlanCredentials {
  const keyring = integrationCredentialKeyring(env);
  if (isByokProvider(provider)) {
    const byok = createByokPlans({ runtime, keyring, env });
    return {
      async accessToken(workspaceId, connectionId) {
        return (await byok.accessCredential(workspaceId, provider, connectionId)).apiKey;
      },
      async accessCredential(workspaceId, connectionId) {
        const { apiKey, endpoint, generation } = await byok.accessCredential(workspaceId, provider, connectionId);
        return { token: apiKey, endpoint, generation };
      },
      requireReconnect: (workspaceId, connectionId, generation) =>
        byok.markReconnectRequired(workspaceId, provider, connectionId, generation),
    };
  }
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

export const isUnusablePlan = (error: unknown) =>
  error instanceof ChatGptPlanError || error instanceof TokenPlanError || error instanceof ByokPlanError;

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
function findCandidateModel(candidate: SubscriptionCandidate, targetModel: string): SubscriptionModel | null {
  const targetLower = targetModel.toLowerCase();
  if (candidate.modelDetails?.length) {
    const exact = candidate.modelDetails.find(item => item.slug === targetModel);
    if (exact) return exact;
    const ci = candidate.modelDetails.find(item => item.slug.toLowerCase() === targetLower);
    if (ci) return ci;
  }
  const exactSlug = candidate.models.find(slug => slug === targetModel);
  if (exactSlug) return { slug: exactSlug, label: exactSlug };
  const ciSlug = candidate.models.find(slug => slug.toLowerCase() === targetLower);
  if (ciSlug) return { slug: ciSlug, label: ciSlug };
  return null;
}

export async function memberPlans(input: {
  provider: PlanProvider;
  credentials: PlanCredentials | null;
  subscriptions: Subscriptions;
  workspaceId: string;
  caller: string | null;
  model: string;
  /** Optional family ID, used to scope custom OpenAI-compatible families to their exact connection. */
  familyId?: string | null;
  /** The caller's plan connection to try first; ignored when it is not one they may use for chats. */
  preferredConnectionId?: string | null;
}) {
  const { credentials, subscriptions, workspaceId } = input;
  const targetLower = input.model.toLowerCase();
  const requiredPrefix = input.familyId ? planModelOfFamily(input.familyId)?.connectionPrefix : undefined;
  const candidates: SubscriptionCandidate[] = credentials
    ? (
        await subscriptions.eligible(
          workspaceId,
          input.provider,
          input.caller,
          'chat',
          input.preferredConnectionId ?? null,
        )
      ).filter(candidate => {
        if (requiredPrefix && !candidate.connectionId.replaceAll('-', '').toLowerCase().startsWith(requiredPrefix)) {
          return false;
        }
        const disabled = candidate.disabled.some(slug => slug === input.model || slug.toLowerCase() === targetLower);
        if (disabled) return false;
        return !candidate.models.length || findCandidateModel(candidate, input.model) !== null;
      })
    : [];
  let current: {
    candidate: SubscriptionCandidate;
    token: string;
    endpoint: string | null;
    generation?: number | undefined;
    resolvedModel: SubscriptionModel | null;
  } | null = null;
  // Whether the last plan that gave a token is the caller's own, so a fallback note can say "your plan".
  let lastOwn = false;
  // The plan the turn moved off last and why, for the Usage page's fallback detail.
  let switched: { from: string; failure: PlanFailure } | null = null;

  async function advance(): Promise<{
    token: string;
    endpoint: string | null;
    model: string;
    maxInputTokens?: number | undefined;
    maxOutputTokens?: number | undefined;
    imageInput?: boolean | undefined;
  } | null> {
    while (credentials && candidates.length) {
      const candidate = candidates.shift()!;
      try {
        const resolved = credentials.accessCredential
          ? await credentials.accessCredential(workspaceId, candidate.connectionId)
          : { token: await credentials.accessToken(workspaceId, candidate.connectionId), endpoint: null };
        const matched = findCandidateModel(candidate, input.model);
        current = {
          candidate,
          token: resolved.token,
          endpoint: resolved.endpoint,
          generation: resolved.generation,
          resolvedModel: matched,
        };
        lastOwn = input.caller !== null && candidate.ownerMembershipId === input.caller;
        await subscriptions.markUsed(workspaceId, candidate.connectionId).catch(() => undefined);
        return {
          token: resolved.token,
          endpoint: resolved.endpoint,
          model: matched?.slug ?? input.model,
          maxInputTokens: matched?.maxInputTokens,
          maxOutputTokens: matched?.maxOutputTokens,
          imageInput: matched?.imageInput,
        };
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
    const { candidate, generation } = current;
    log('warn', 'activity', 'call_completed', {
      operation: 'chat.plan-failover',
      outcome: failure,
    });
    if (failure === 'reconnect')
      await credentials.requireReconnect(workspaceId, candidate.connectionId, generation).catch(() => undefined);
    else
      await subscriptions
        .coolDown(workspaceId, candidate.connectionId, retryAfterMs, failure === 'usage-limit')
        .catch(() => undefined);
  }

  const first = await advance();
  return {
    token: first?.token ?? null,
    endpoint: first?.endpoint ?? null,
    model: first?.model ?? input.model,
    maxInputTokens: first?.maxInputTokens,
    maxOutputTokens: first?.maxOutputTokens,
    imageInput: first?.imageInput,
    async next(failure: PlanFailure, retryAfterMs?: number) {
      const from = (current as { candidate: SubscriptionCandidate } | null)?.candidate.connectionId;
      await retire(failure, retryAfterMs);
      if (from) switched = { from, failure };
      const nextCred = await advance();
      if (!nextCred) return null;
      return { token: nextCred.token, endpoint: nextCred.endpoint, model: nextCred.model };
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
      familyId: input.familyId ?? null,
    });
}

/** The plans one member may run `model` on, in the order they are tried. */
export type MemberPlanAccess = (input: {
  provider: PlanProvider;
  workspaceId: string;
  membershipId: string;
  model: string;
  familyId?: string | null;
}) => Promise<
  Pick<
    Awaited<ReturnType<typeof memberPlans>>,
    | 'token'
    | 'endpoint'
    | 'model'
    | 'maxInputTokens'
    | 'maxOutputTokens'
    | 'imageInput'
    | 'next'
    | 'source'
    | 'answered'
  >
>;
