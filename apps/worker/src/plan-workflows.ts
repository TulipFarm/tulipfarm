import {
  condition,
  continueAsNew,
  defineSignal,
  log,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import type { PlanProgress } from '@tulipfarm/agents/plan-runtime';

const steps = proxyActivities<{ advanceAgentPlan(workspaceId: string, planId: string): Promise<PlanProgress> }>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '1 second', maximumInterval: '10 seconds' },
});
// A specialist runs once per attempt. A lost run expires its lease, and the plan retries the task with a new attempt.
const specialists = proxyActivities<{ runPlanSpecialist(workspaceId: string, attemptId: string): Promise<void> }>({
  startToCloseTimeout: '15 minutes',
  retry: { maximumAttempts: 1 },
});
const recovery = proxyActivities<{
  discoverAgentPlanWorkspaces(after: string | null): Promise<string[]>;
  recoverAgentPlanPage(workspaceId: string, after?: string): Promise<string | null>;
}>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3, initialInterval: '10 seconds', maximumInterval: '1 minute' },
});

export async function agentPlanRecovery(after: string | null = null): Promise<void> {
  const workspaces = await recovery.discoverAgentPlanWorkspaces(after).catch(() => {
    log.warn('Plan workspace discovery will retry');
    return null;
  });
  await Promise.all(
    (workspaces ?? []).map(async workspaceId => {
      try {
        let planAfter: string | null = null;
        do {
          planAfter = await recovery.recoverAgentPlanPage(workspaceId, planAfter ?? undefined);
        } while (planAfter);
      } catch {
        log.warn('Plan recovery will retry', { workspaceId });
      }
    }),
  );
  await sleep('1 minute');
  await continueAsNew<typeof agentPlanRecovery>(
    workspaces ? (workspaces.length === 10 ? (workspaces.at(-1) ?? null) : null) : after,
  );
}

/**
 * Advances one plan until nothing can change without a wake. Saved-agent tasks do not signal plans, so a waiting plan
 * rereads them every 30 seconds. Specialists run as activities beside the loop and wake it when they finish.
 */
export async function agentPlanStep(workspaceId: string, planId: string): Promise<void> {
  let wakes = 0;
  setHandler(defineSignal('wakeAgentPlan'), () => {
    wakes++;
  });
  const running = new Map<string, Promise<void>>();
  for (let step = 0; step < 200; step++) {
    const observed = wakes;
    const progress = await steps.advanceAgentPlan(workspaceId, planId);
    for (const attemptId of progress.specialists) {
      if (running.has(attemptId)) continue;
      running.set(
        attemptId,
        specialists
          .runPlanSpecialist(workspaceId, attemptId)
          .catch(() => {
            log.warn('Plan specialist ended without settling', { workspaceId, planId, attemptId });
          })
          .finally(() => {
            running.delete(attemptId);
            wakes++;
          }),
      );
    }
    if (wakes !== observed) continue;
    if (progress.kind === 'terminal' && !running.size) return;
    if (progress.kind === 'terminal') await condition(() => wakes !== observed);
    else await condition(() => wakes !== observed, '30 seconds');
    if (workflowInfo().continueAsNewSuggested && !running.size) break;
  }
  await condition(() => running.size === 0);
  await continueAsNew<typeof agentPlanStep>(workspaceId, planId);
}
