import { turnRequester } from '@tulipfarm/conversations/turn-requester';
import type { ConversationRuntime, ReplyFence } from '@tulipfarm/conversations/runtime';
import { chatGptPlanEnabled } from '@tulipfarm/config';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { ChatGptPlanError, createChatGptPlan, type ChatGptPlan } from '@tulipfarm/integrations/chatgpt';
import { ModelCallError } from '@tulipfarm/observability';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

export function chatGptPlanFromEnvironment(runtime: ConversationRuntime, env: NodeJS.ProcessEnv = process.env) {
  if (!chatGptPlanEnabled(env)) return null;
  return createChatGptPlan({ runtime, keyring: integrationCredentialKeyring(env) });
}

/**
 * The requesting member and their ChatGPT access token for a ChatGPT plan reply. Slack and project chats, and turns
 * without a requesting member, can't use a member's plan.
 */
export async function memberChatGptToken(input: {
  runtime: ConversationRuntime;
  chatGpt: ChatGptPlan | null;
  fence: ReplyFence;
  shared: boolean;
}) {
  const { runtime, chatGpt, fence } = input;
  if (!chatGpt) throw new ModelCallError('chatgpt-member-required', { outputStarted: false });
  const requester = input.shared
    ? null
    : await runtime.transaction(fence.workspaceId, commonCompatibility, tx =>
        turnRequester(tx, fence.conversationId, fence.turnId),
      );
  if (!requester) throw new ModelCallError('chatgpt-member-required', { outputStarted: false });
  try {
    return {
      membershipId: requester.membershipId,
      accessToken: await chatGpt.accessToken(fence.workspaceId, requester.membershipId),
    };
  } catch (error) {
    if (!(error instanceof ChatGptPlanError)) throw error;
    if (error.code === 'unavailable') throw new ModelCallError('unavailable', { outputStarted: false });
    throw new ModelCallError(error.code === 'not-connected' ? 'chatgpt-member-required' : 'chatgpt-reconnect', {
      outputStarted: false,
    });
  }
}

/** OpenAI rejected the member's token: their connection now asks them to reconnect. */
export async function noteChatGptFailure(
  chatGpt: ChatGptPlan | null,
  workspaceId: string,
  membershipId: string,
  error: unknown,
) {
  if (!chatGpt || !(error instanceof Error) || error.message !== 'model-chatgpt-reconnect') return;
  await chatGpt.requireReconnect(workspaceId, membershipId).catch(() => undefined);
}
