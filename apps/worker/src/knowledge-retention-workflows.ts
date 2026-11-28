import { continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import type { createKnowledgeRetentionActivities } from './knowledge-retention-activities.ts';

type Activities = ReturnType<typeof createKnowledgeRetentionActivities>;
const { purgeExpiredKnowledge } = proxyActivities<Activities>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '10 seconds', backoffCoefficient: 2, maximumInterval: '1 minute', maximumAttempts: 3 },
});
const batchesPerRun = 200;
// A pause between batches spreads the deletes out, so a large first purge never saturates database IO.
const pause = '1 second';

/**
 * Deletes a workspace's expired Knowledge one small batch per transaction until nothing more is ready. A batch that
 * removes nothing ends the run; documents skipped because Keep or a sync still holds them wait for a later run.
 */
export async function knowledgeRetentionPurge(input: { workspaceId: string }): Promise<void> {
  for (let batch = 0; batch < batchesPerRun; batch++) {
    if ((await purgeExpiredKnowledge(input.workspaceId)) === 0) return;
    await sleep(pause);
  }
  await continueAsNew<typeof knowledgeRetentionPurge>(input);
}
