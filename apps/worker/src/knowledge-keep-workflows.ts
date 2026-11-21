import { ApplicationFailure, continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import type { KnowledgeKeepFailureKind } from '@tulipfarm/knowledge';
import type { createKnowledgeKeepActivities } from './knowledge-keep-activities.ts';
import { knowledgeKeepFailures } from './knowledge-keep-failures.ts';

type Activities = ReturnType<typeof createKnowledgeKeepActivities>;
const { dueKnowledgeKeep, recordKnowledgeKeepFailure } = proxyActivities<Activities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 },
});
// A document is sent in batches of bounded size, each a Keep call of at most 30 seconds with a heartbeat before it. The
// heartbeat timeout notices a stalled attempt; the overall limit covers the largest document. A retry that starts while
// a stalled attempt still runs finds the document's lease held and leaves it for a later run.
const { syncKnowledgeKeep } = proxyActivities<Activities>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { initialInterval: '10 seconds', backoffCoefficient: 2, maximumInterval: '1 minute', maximumAttempts: 3 },
});
const page = 100;
const stepsPerRun = 2000;
const longestWait = 30 * 60_000;

function failureKind(error: unknown): KnowledgeKeepFailureKind {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof ApplicationFailure) {
    if (cause.type === knowledgeKeepFailures.keep) return 'keep';
    if (cause.type === knowledgeKeepFailures.permanent) return 'permanent';
  }
  return 'document';
}

/**
 * Sends a workspace's published Knowledge to Keep and forgets what was removed, one document at a time in id order.
 * Every published document Keep does not hold yet is due, so the first run is the backfill. A document that fails
 * is recorded and backs off while the run moves on to the next. When Keep itself is unreachable the run waits, with a
 * growing delay, and tries the same document again, so no later run starts and hammers Keep in the meantime.
 */
export async function knowledgeKeepSync(input: {
  workspaceId: string;
  after?: string | null;
  wait?: number;
  /** The first wait after Keep is found unreachable, in milliseconds. Defaults to one minute. */
  outageWait?: number;
}): Promise<void> {
  let after = input.after ?? null;
  let wait = input.wait ?? 0;
  const firstWait = input.outageWait ?? 60_000;
  let steps = 0;
  while (steps < stepsPerRun) {
    const due = await dueKnowledgeKeep(input.workspaceId, after, page);
    steps++;
    let outage = false;
    for (const work of due) {
      steps++;
      try {
        const outcome = await syncKnowledgeKeep(input.workspaceId, work.document_id);
        // The flag went off or the endpoint went away; the dispatcher starts a new run when work is due again.
        if (outcome.status === 'disabled') return;
        wait = 0;
      } catch (error) {
        const kind = failureKind(error);
        await recordKnowledgeKeepFailure(
          input.workspaceId,
          work.document_id,
          error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : 'failed',
          kind,
        );
        if (kind === 'keep') {
          wait = Math.min(Math.max(wait * 2, firstWait), longestWait);
          await sleep(wait);
          outage = true;
          break;
        }
      }
      after = work.document_id;
    }
    if (!outage && due.length < page) return;
  }
  await continueAsNew<typeof knowledgeKeepSync>({ ...input, after, wait });
}
