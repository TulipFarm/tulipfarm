import { rowThreadApi } from '@/features/tables/row-thread';
import { TableRequestError } from '@/features/tables/request-state';
import type { Lane, TaskCard } from './api';

/** What dropping a card on a column does. Working and Needs you only change through the agent or a reply. */
export type TaskMove = 'run' | 'done' | 'reopen';

export function taskMove(card: TaskCard, lane: Lane): TaskMove | null {
  if (card.lane === lane || card.lane === 'working') return null;
  if (lane === 'queued') return card.activity && card.lane !== 'queued' ? 'run' : null;
  if (lane === 'done') return 'done';
  if (lane === 'todo') return card.lane === 'done' && !card.activity ? 'reopen' : null;
  return null;
}

export const moveHints: Record<TaskMove, string> = {
  run: 'Drop to run the agent',
  done: 'Drop to mark done',
  reopen: 'Drop to reopen',
};

export async function applyTaskMove(workspaceId: string, tableId: string, card: TaskCard, move: TaskMove) {
  const thread = rowThreadApi(workspaceId, tableId, card.id);
  try {
    await (move === 'run' ? thread.runNow() : move === 'done' ? thread.markDone() : thread.reopen());
    return null;
  } catch (failure) {
    if (failure instanceof TableRequestError && failure.code === 'run-state-protected')
      return move === 'reopen'
        ? 'Tasks with an agent reopen by running again. Drop it on Queued.'
        : 'The agent is working on this task. Wait for the run to end.';
    return move === 'run'
      ? 'The agent could not be started. Open the task to see why.'
      : 'The task could not be moved. Try again.';
  }
}
