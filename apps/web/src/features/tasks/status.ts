import type { z } from 'zod';
import type { taskSummarySchema, TaskFailureReason, TaskPauseReason } from '@tulipfarm/agents/task-contracts';
import type { StatusState } from '@tulipfarm/sprout/status';

type TaskSummary = z.infer<typeof taskSummarySchema>;
export const taskStatusLabels: Record<TaskSummary['status'], string> = {
  pending: 'Working',
  completed: 'Completed',
  'waiting-clarification': 'Needs your answer',
  'waiting-approval': 'Needs your review',
  paused: 'Paused',
  failed: 'Stopped',
};
/** The Status mark for each task status; waiting on a person reads as a warning, like its badge. */
export const taskStatusStates: Record<TaskSummary['status'], StatusState> = {
  pending: 'running',
  completed: 'success',
  'waiting-clarification': 'warning',
  'waiting-approval': 'warning',
  paused: 'paused',
  failed: 'error',
};
const taskNextSteps: Record<TaskSummary['status'], string> = {
  pending: 'The agent is working. You can leave this page and return to check progress.',
  completed: 'Review the result below. Send a follow-up to continue this task.',
  'waiting-clarification': 'The agent needs your answer. Read its question and reply below.',
  'waiting-approval': 'Review the proposed changes below. Nothing in an unapproved batch can run.',
  paused:
    'This task is paused and keeps its progress. Read the latest update, then reply below when you want it to continue.',
  failed:
    "The task stopped. Read the latest update, then reply to try again. If it stops again, check the agent's sources and your access.",
};
const pauseGuidance: Record<TaskPauseReason, { label: string; recovery: string }> = {
  user: { label: 'Paused by you', recovery: 'Your progress is saved. Reply to continue when you are ready.' },
  'limit.toolCalls': {
    label: 'Paused at the tool call limit',
    recovery: 'The next work needs more tool calls. Raise the tool call limit when you reply to continue.',
  },
  'limit.activeTime': {
    label: 'Paused at the active time limit',
    recovery: 'The next work needs more active time. Raise the active time limit when you reply to continue.',
  },
  'limit.credits': {
    label: 'Paused at the task credit limit',
    recovery: 'The next work needs more task credits. Raise the credit limit when you reply to continue.',
  },
  'limit.steps': {
    label: 'Paused at the step limit',
    recovery:
      'This task reached its step limit. Start a new task with a smaller request and the useful results from this one.',
  },
  'limit.workspaceCredits': {
    label: 'Paused because workspace credits are unavailable',
    recovery:
      'Ask a workspace admin to add credits, then reply to continue. Raising this task limit alone will not help.',
  },
  model: {
    label: 'Paused because the model is unavailable',
    recovery: 'Read the latest update. Ask a workspace admin to check the model settings, then reply to retry.',
  },
  context: {
    label: 'Paused because the context is too large',
    recovery: 'Start a new task with a shorter request and only the sources it needs. This task keeps its history.',
  },
  file: {
    label: 'Paused because a file could not be read',
    recovery:
      'Read the latest update for the file problem. Check file access, the integration, and the supported format before replying to retry.',
  },
  plan: {
    label: 'Paused because its plan was stopped',
    recovery:
      'Review the stopped plan and this task progress. Reply here only if you want this task to continue on its own.',
  },
  approval: {
    label: 'Paused for approval',
    recovery: 'Review the pending changes before replying to continue. Continuing does not approve any changes.',
  },
  decision: {
    label: 'Paused because the agent kept choosing steps it cannot take',
    recovery:
      "Read the latest update, then reply with clearer instructions to continue. If the task needs a tool the agent does not have, check the agent's tools first.",
  },
};

const failureGuidance: Record<TaskFailureReason, { label: string; recovery: string }> = {
  'authority-revoked': {
    label: 'Stopped because access changed',
    recovery:
      "The agent or you lost access to something this task needs, such as a source, tool, or table. Check the agent's sources and your access, then reply to try again.",
  },
  internal: {
    label: 'Stopped by an unexpected error',
    recovery: 'Something went wrong on our side. Your progress is saved. Reply to try again.',
  },
};

type TaskState = Pick<TaskSummary, 'status' | 'pauseReason'> & Partial<Pick<TaskSummary, 'failureReason'>>;

function guidance(task: TaskState) {
  if (task.status === 'paused' && task.pauseReason) return pauseGuidance[task.pauseReason];
  if (task.status === 'failed' && task.failureReason) return failureGuidance[task.failureReason];
  return undefined;
}

export function taskStatusLabel(task: TaskState) {
  return guidance(task)?.label ?? taskStatusLabels[task.status];
}

export function taskNextStep(task: TaskState) {
  return guidance(task)?.recovery ?? taskNextSteps[task.status];
}
