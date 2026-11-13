import { proxyActivities } from '@temporalio/workflow';
import type { createCodingRunActivities } from './coding-runs.ts';

type Activities = ReturnType<typeof createCodingRunActivities>;

// A run has 30 minutes of its own; the activity also allows for starting the machine and saving the diff.
const { runCodingRun } = proxyActivities<Activities>({
  startToCloseTimeout: '40 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 1 },
});
const { interruptCodingRun } = proxyActivities<Activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 5, initialInterval: '2 seconds' },
});

/** Runs one approved coding run. If its worker stops, the run is marked interrupted so the chat continues. */
export async function codingRun(workspaceId: string, runId: string) {
  try {
    await runCodingRun(workspaceId, runId);
  } catch (error) {
    await interruptCodingRun(workspaceId, runId);
    throw error;
  }
}
