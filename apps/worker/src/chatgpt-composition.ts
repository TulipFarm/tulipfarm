import { turnRequester } from '@tulipfarm/conversations/turn-requester';
import type { ConversationRuntime, ReplyFence } from '@tulipfarm/conversations/runtime';
import { AccessDenied } from '@tulipfarm/access';
import { chatGptPlanEnabled } from '@tulipfarm/config';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { ChatGptPlanError, createChatGptPlan, type ChatGptPlan } from '@tulipfarm/integrations/chatgpt';
import {
  createSubscriptions,
  type SubscriptionCandidate,
  type Subscriptions,
} from '@tulipfarm/integrations/subscriptions';
import type { PlanFailure } from '@tulipfarm/agents/inference';
import { log } from '@tulipfarm/observability';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

export function chatGptPlanFromEnvironment(runtime: ConversationRuntime, env: NodeJS.ProcessEnv = process.env) {
  if (!chatGptPlanEnabled(env)) return null;
  return createChatGptPlan({ runtime, keyring: integrationCredentialKeyring(env) });
}

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
 * The ChatGPT plans a turn may run on, in the order they are tried: the caller's own, then those shared with them, their
 * teams and the workspace. `current` is the plan answering now; `next` retires it for the reason given and moves to the
 * next plan with a usable token, or returns null when none is left so the workspace's fallback model answers. Tokens
 * are read here, inside the activity, so they never enter workflow history.
 */
export async function chatGptPlans(input: {
  chatGpt: ChatGptPlan | null;
  subscriptions: Subscriptions;
  workspaceId: string;
  caller: string | null;
  model: string;
}) {
  const { chatGpt, subscriptions, workspaceId } = input;
  const candidates: SubscriptionCandidate[] = chatGpt
    ? (await subscriptions.eligible(workspaceId, 'chatgpt', input.caller)).filter(
        candidate => !candidate.models.length || candidate.models.includes(input.model),
      )
    : [];
  let current: { candidate: SubscriptionCandidate; token: string } | null = null;

  async function advance(): Promise<string | null> {
    while (chatGpt && candidates.length) {
      const candidate = candidates.shift()!;
      try {
        const token = await chatGpt.accessToken(workspaceId, candidate.ownerMembershipId);
        current = { candidate, token };
        await subscriptions.markUsed(workspaceId, candidate.connectionId).catch(() => undefined);
        return token;
      } catch (error) {
        if (!(error instanceof ChatGptPlanError)) throw error;
        // A plan that can't give a token now (signed out, needs sign-in, plan turned off, OpenAI down) is skipped.
      }
    }
    current = null;
    return null;
  }

  async function retire(failure: PlanFailure, retryAfterMs?: number) {
    if (!current || !chatGpt) return;
    const { candidate } = current;
    log('warn', 'activity', 'call_completed', {
      operation: 'chat.plan-failover',
      outcome: failure,
    });
    if (failure === 'reconnect')
      await chatGpt.requireReconnect(workspaceId, candidate.ownerMembershipId).catch(() => undefined);
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
