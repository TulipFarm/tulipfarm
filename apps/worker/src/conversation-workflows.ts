import { proxyActivities } from '@temporalio/workflow';
import type { ReplyWork } from '@tulipfarm/conversations/runtime';
import type { createConversationActivities } from './conversation-activities.ts';

const { processConversationReply } = proxyActivities<ReturnType<typeof createConversationActivities>>({
  startToCloseTimeout: '9 minutes',
  retry: { maximumAttempts: 1 },
});

export async function conversationReply(work: ReplyWork) {
  return processConversationReply(work);
}
