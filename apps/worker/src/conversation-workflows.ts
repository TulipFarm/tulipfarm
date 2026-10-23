import { patched, proxyActivities, sleep } from '@temporalio/workflow';
import type { ReplyWork } from '@tulipfarm/conversations/runtime';
import type { createConversationActivities } from './conversation-activities.ts';

const { processConversationReply, deliverConversationReply } = proxyActivities<
  ReturnType<typeof createConversationActivities>
>({
  startToCloseTimeout: '9 minutes',
  retry: { maximumAttempts: 1 },
});
// The title runs after the reply was delivered, so it has its own short budget and can never fail or delay that reply.
const { generateConversationTitle } = proxyActivities<ReturnType<typeof createConversationActivities>>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 1 },
});
const titleAttempts = 2;

export async function conversationReply(work: ReplyWork) {
  if (!patched('title-after-reply')) return processConversationReply(work);
  const { outcome, title } = await deliverConversationReply(work);
  if (title)
    for (let attempt = 1; attempt <= titleAttempts; attempt++) {
      const final = attempt === titleAttempts;
      try {
        if ((await generateConversationTitle({ ...work, ...title, attempt, final })) !== 'retry') break;
      } catch {
        if (final) break;
      }
      await sleep('1 second');
    }
  return outcome;
}
