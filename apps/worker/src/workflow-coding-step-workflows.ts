import { proxyActivities } from '@temporalio/workflow';
import type { createWorkflowCodingActivities } from './workflow-coding-steps.ts';

type Activities = ReturnType<typeof createWorkflowCodingActivities>;

// A job has 30 minutes of its own; the activity also allows for starting the machine and opening the pull request.
const { runWorkflowCodingStep } = proxyActivities<Activities>({
  startToCloseTimeout: '40 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 1 },
});
const { interruptWorkflowCodingStep } = proxyActivities<Activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 5, initialInterval: '2 seconds' },
});

/** Runs one workflow coding step. If its worker stops, the step is marked interrupted so the run can fail. */
export async function workflowCodingStepV1(workspaceId: string, runId: string, stepId: string, jobId: string) {
  try {
    await runWorkflowCodingStep(workspaceId, runId, stepId, jobId);
  } catch (error) {
    await interruptWorkflowCodingStep(workspaceId, runId, stepId, jobId);
    throw error;
  }
}
