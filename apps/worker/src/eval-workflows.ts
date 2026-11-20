import { proxyActivities } from '@temporalio/workflow';
import type { createEvalActivities } from './eval-activities.ts';

// A run claims its row once, so a retry could only fail; an expired lease marks a lost run interrupted instead.
const { runAgentEval } = proxyActivities<ReturnType<typeof createEvalActivities>>({
  startToCloseTimeout: '4 hours',
  retry: { maximumAttempts: 1 },
});
export async function agentEvalRun(workspaceId: string, runId: string) {
  await runAgentEval(workspaceId, runId);
}
