import {
  ApplicationFailure,
  continueAsNew,
  isCancellation,
  patched,
  proxyActivities,
  sleep,
} from '@temporalio/workflow';
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
// One Keep call forgets many documents. A failed call is not retried: the run forgets those documents one at a time.
const { forgetKnowledgeKeep } = proxyActivities<Activities>({
  startToCloseTimeout: '2 minutes',
  heartbeatTimeout: '1 minute',
  retry: { maximumAttempts: 1 },
});
const page = 100;
// Runs that forget in batches read larger pages, so a page of removed documents is one Keep call.
const batchPage = 250;
const stepsPerRun = 2000;
const longestWait = 30 * 60_000;

function failureKind(error: unknown): KnowledgeKeepFailureKind {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof ApplicationFailure) {
    if (cause.type === knowledgeKeepFailures.keep) return 'keep';
    if (cause.type === knowledgeKeepFailures.busy) return 'busy';
    if (cause.type === knowledgeKeepFailures.permanent) return 'permanent';
  }
  return 'document';
}

/**
 * Sends a workspace's published Knowledge to Keep and forgets what was removed, in id order: one document at a time,
 * except that consecutive removed documents are forgotten with one Keep call, or one at a time when that call fails.
 * Every published document Keep does not hold yet is due, so the first run is the backfill. A document that fails
 * is recorded and backs off while the run moves on to the next. When Keep itself is unreachable, or times out because
 * it is overloaded, the run waits, with a growing delay, and tries the same document again, so no later run starts and
 * hammers Keep in the meantime. The retry resumes the document after its last batch Keep acknowledged. A document that
 * keeps timing out is recorded as failing by the feed after a few tries, and the run then moves on without waiting.
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
  // Until Keep is found to have no batch route.
  let batches = true;
  while (steps < stepsPerRun) {
    // Histories from before batch forgetting replay one document at a time.
    const batching = patched('keep-forget-batch');
    const limit = batching ? batchPage : page;
    const due = await dueKnowledgeKeep(input.workspaceId, after, limit);
    steps++;
    let outage = false;
    for (let index = 0; index < due.length;) {
      if (batching && batches && due[index]!.action === 'forget') {
        let end = index;
        while (end < due.length && due[end]!.action === 'forget') end++;
        const documents = due.slice(index, end).map(work => work.document_id);
        steps++;
        const outcome = await forgetKnowledgeKeep(input.workspaceId, documents).catch((error: unknown) => {
          if (isCancellation(error)) throw error;
          return undefined;
        });
        if (outcome?.status === 'disabled') return;
        if (outcome?.status === 'forgotten') {
          wait = 0;
          after = documents.at(-1)!;
          index = end;
          continue;
        }
        // Keep has no batch route, or the call failed: forget these one at a time, which records failures and waits
        // out an outage of Keep.
        if (outcome?.status === 'unsupported') batches = false;
      }
      const work = due[index]!;
      index++;
      steps++;
      try {
        const outcome = await syncKnowledgeKeep(input.workspaceId, work.document_id);
        // The flag went off or the endpoint went away; the dispatcher starts a new run when work is due again.
        if (outcome.status === 'disabled') return;
        wait = 0;
      } catch (error) {
        const kind = failureKind(error);
        const recorded = await recordKnowledgeKeepFailure(
          input.workspaceId,
          work.document_id,
          error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : 'failed',
          kind,
        );
        // Histories from before the activity returned how it recorded the failure replay an undefined result.
        if ((recorded ?? kind) === 'keep') {
          wait = Math.min(Math.max(wait * 2, firstWait), longestWait);
          await sleep(wait);
          outage = true;
          break;
        }
      }
      after = work.document_id;
    }
    if (!outage && due.length < limit) return;
  }
  await continueAsNew<typeof knowledgeKeepSync>({ ...input, after, wait });
}
