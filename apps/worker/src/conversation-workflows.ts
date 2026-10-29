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
// A busy title model usually recovers within minutes, so later tries wait longer instead of giving up after a second.
const titleRetryDelays = ['1 second', '30 seconds', '2 minutes', '5 minutes'] as const;

export async function conversationReply(work: ReplyWork) {
  if (!patched('title-after-reply')) return processConversationReply(work);
  const { outcome, title } = await deliverConversationReply(work);
  if (title) {
    const delays = patched('title-retry-later') ? titleRetryDelays : titleRetryDelays.slice(0, 1);
    for (let attempt = 1; ; attempt++) {
      const delay = delays[attempt - 1];
      const final = delay === undefined;
      const result = await generateConversationTitle({ ...work, ...title, attempt, final }).catch(() => 'retry');
      if (result !== 'retry' || final) break;
      await sleep(delay);
    }
  }
  return outcome;
}
