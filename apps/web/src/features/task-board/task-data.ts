import { useMemo, useRef } from 'react';
import { useFeatureRead } from '@/lib/query';
import type { TableApi, TableDefinition } from '@/features/tables/api';
import { useTableDetail } from '@/features/tables/hooks';
import { tableKeys } from '@/features/tables/queries';
import { readTaskActivity, readTaskRows, type TaskActivity, type TaskCard } from './api';
import type { TaskKeys } from './task-api';

/** The Tasks table's definition and what the person may do with its rows. */
export function useTasksTable(api: TableApi, tableId: string) {
  const detail = useTableDetail(api, tableId);
  const state = detail.state.kind === 'ready' ? detail.state.data : null;
  const table = useMemo<TableDefinition | null>(
    () =>
      state?.applied
        ? {
            id: state.id,
            revision: state.applied.revision,
            definition: state.applied.definition,
            systemKind: state.systemKind,
          }
        : null,
    [state],
  );
  const open = Boolean(state) && !state?.archived;
  return {
    detail,
    state,
    table,
    canCreate: open && Boolean(state?.rowPermissions.create),
    canUpdate: open && Boolean(state?.rowPermissions.update),
    canDelete: open && Boolean(state?.rowPermissions.delete),
  };
}

/** The newest tasks, shared by the board, the task page and the composer's Parent task chip. */
export function useTaskRows(api: TableApi, table: TableDefinition | null) {
  return useFeatureRead({
    key: [...tableKeys.records(table?.id ?? ''), 'task-board', table?.revision ?? null] as const,
    enabled: table !== null,
    load: signal => readTaskRows(api, table!, signal),
  });
}

const live = (activity: TaskActivity | undefined) =>
  Boolean(activity?.tasks.some(task => task.runState === 'queued' || task.runState === 'working'));

/** Agent progress on tasks, checked every 2 seconds while an agent is busy and every 10 otherwise. */
export function useTaskActivity(workspaceId: string) {
  const busy = useRef(false);
  return useFeatureRead({
    key: ['task-board', 'activity', workspaceId] as const,
    load: async signal => {
      const data = await readTaskActivity(workspaceId, signal);
      busy.current = live(data);
      return data;
    },
    pollWhile: () => true,
    interval: () => (busy.current ? 2000 : 10_000),
    maxChecks: 2000,
  });
}

export type TaskOption = { id: string; key: string | null; title: string };

export function keysByRow(keys: TaskKeys | undefined) {
  return new Map(keys?.keys.map(item => [item.rowId, item.key]));
}

export const taskOptions = (cards: readonly TaskCard[], keys: ReadonlyMap<string, string>): TaskOption[] =>
  cards.map(card => ({ id: card.id, key: keys.get(card.id) ?? null, title: card.title }));

export const optionLabel = (option: TaskOption) => (option.key ? `${option.key} ${option.title}` : option.title);
