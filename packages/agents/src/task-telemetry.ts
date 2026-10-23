import { emitHook } from '@tulipfarm/extensions';
import { recordTaskTransition, trackEvent } from '@tulipfarm/observability';
import { afterCommit, workspaceIdFromSchema } from '@tulipfarm/workspace-storage/runtime';
import type { AgentStorage, AgentTransaction } from './store.ts';

type Transition = Parameters<typeof recordTaskTransition>[0];
type Recorded = { status: Transition; completed?: () => void };
const pending = new WeakMap<AgentTransaction['client'], Recorded[]>();

function record({ status, completed }: Recorded) {
  recordTaskTransition(status);
  try {
    completed?.();
  } catch {
    /* A hook must not fail a committed transition. */
  }
}

type Terminal = Extract<Transition, 'completed' | 'failed'>;
const terminal = (status: Transition): status is Terminal => status === 'completed' || status === 'failed';

function completion(tx: AgentTransaction, status: Transition, taskId: string | undefined) {
  if (!terminal(status) || !taskId) return undefined;
  return () => {
    const workspaceId =
      'workspaceId' in tx && typeof tx.workspaceId === 'string' ? tx.workspaceId : workspaceIdFromSchema(tx.schema);
    void emitHook('task.completed', { workspaceId, taskId, outcome: status });
    trackEvent('task_completed', { workspaceId }, { outcome: status });
  };
}

/** Records a task status change; a terminal one also emits `task.completed` once the change commits. */
export function taskTransition(tx: AgentTransaction, status: Terminal, rowCount: number | null, taskId: string): void;
export function taskTransition(
  tx: AgentTransaction,
  status: Exclude<Transition, Terminal>,
  rowCount: number | null,
): void;
export function taskTransition(tx: AgentTransaction, status: Transition, rowCount: number | null, taskId: string): void;
export function taskTransition(tx: AgentTransaction, status: Transition, rowCount: number | null, taskId?: string) {
  if (!rowCount) return;
  const completed = completion(tx, status, taskId);
  const transitions = pending.get(tx.client);
  if (transitions) transitions.push({ status, ...(completed ? { completed } : {}) });
  else {
    recordTaskTransition(status);
    if (completed) afterCommit(tx.client, completed);
  }
}

export function taskTelemetryCheckpoint(tx: AgentTransaction) {
  const transitions = pending.get(tx.client);
  const length = transitions?.length ?? 0;
  return () => {
    if (transitions) transitions.length = length;
  };
}

// Wrap transaction owners too: bound runtimes share their client's buffer but do not commit.
export function withTaskTelemetry(runtime: AgentStorage): AgentStorage {
  return {
    transaction: async (workspaceId, compatibility, operation) => {
      let transitions: Recorded[] | undefined;
      const result = await runtime.transaction(workspaceId, compatibility, async tx => {
        if (pending.has(tx.client)) return operation(tx);
        transitions = [];
        pending.set(tx.client, transitions);
        try {
          return await operation(tx);
        } finally {
          pending.delete(tx.client);
        }
      });
      for (const transition of transitions ?? []) record(transition);
      return result;
    },
  };
}
