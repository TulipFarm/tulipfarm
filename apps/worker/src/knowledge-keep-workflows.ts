import { ApplicationFailure, continueAsNew, proxyActivities } from '@temporalio/workflow';
import type { createKnowledgeKeepActivities } from './knowledge-keep-activities.ts';

type Activities = ReturnType<typeof createKnowledgeKeepActivities>;
const { dueKnowledgeKeep, recordKnowledgeKeepFailure } = proxyActivities<Activities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 },
});
const { syncKnowledgeKeep } = proxyActivities<Activities>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '2 seconds', backoffCoefficient: 2, maximumInterval: '1 minute', maximumAttempts: 5 },
});
const page = 100;
const pagesPerRun = 20;

/**
 * Sends a workspace's published Knowledge to Keep and forgets what was removed, one document at a time in id order.
 * Turning `keep-memory` on makes every published document due, so the first run is the backfill.
 */
export async function knowledgeKeepSync(input: { workspaceId: string; after?: string | null }): Promise<void> {
  let after = input.after ?? null;
  for (let pages = 0; pages < pagesPerRun; pages++) {
    const due = await dueKnowledgeKeep(input.workspaceId, after, page);
    for (const work of due) {
      try {
        const outcome = await syncKnowledgeKeep(input.workspaceId, work.document_id);
        // The flag went off or the endpoint went away; the dispatcher starts a new run when work is due again.
        if (outcome.status === 'disabled') return;
      } catch (error) {
        const permanent =
          error instanceof Error && error.cause instanceof ApplicationFailure && error.cause.nonRetryable === true;
        await recordKnowledgeKeepFailure(
          input.workspaceId,
          work.document_id,
          error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : 'failed',
          permanent,
        );
        // Unless this one document is at fault, Keep is not answering: stop rather than fail every remaining document.
        // The dispatcher starts a later run, which resumes with this document.
        if (!permanent) return;
      }
      after = work.document_id;
    }
    if (due.length < page) return;
  }
  await continueAsNew<typeof knowledgeKeepSync>({ workspaceId: input.workspaceId, after });
}
