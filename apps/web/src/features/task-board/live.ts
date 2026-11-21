import { useEffect, useState } from 'react';
import { useFeatureRead } from '@/lib/query';
import { taskReads } from '@/features/tasks/queries';
import { taskApi, type TaskSummary } from '@/features/tasks/api';
import type { AssignmentActivity } from './api';

/** The current time, ticking each second while `running`, so elapsed times stay live. */
export function useNow(running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

export function duration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function ago(value: string, now: number) {
  const elapsed = now - new Date(value).getTime();
  return elapsed < 60_000 ? 'just now' : `${duration(elapsed).split(' ')[0]} ago`;
}

/**
 * The agent run behind a task, for the member who sponsors it. Only the sponsor can read a run,
 * so everyone else gets `undefined` and sees the assignment's own progress instead.
 */
export function useAssignmentRun(workspaceId: string, activity: AssignmentActivity | null, me: string | undefined) {
  const taskId = activity?.run?.taskId;
  const readable = Boolean(taskId) && activity?.sponsorMembershipId === me;
  const read = useFeatureRead({
    ...taskReads.summary(taskApi(workspaceId), taskId ?? 'none'),
    enabled: readable,
    pollWhile: (task: TaskSummary) => task.status === 'pending',
    interval: 1500,
    maxChecks: 1200,
    retry: () => false,
  });
  return readable && read.state.kind === 'ready' ? read.state.data : undefined;
}

/** What the agent is doing now: its running tool, or thinking between tools. */
export function currentStep(run: TaskSummary | undefined) {
  if (!run) return null;
  const running = [...run.activity].reverse().find(item => item.status === 'running');
  return running ? running.presentation.label : run.status === 'pending' ? 'Thinking…' : null;
}

/** Ends a server reason with a full stop so more text can follow it. */
export const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);
