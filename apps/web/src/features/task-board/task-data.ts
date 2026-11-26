import { useCallback, useEffect, useMemo, useRef } from 'react';
import { z } from 'zod';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { useFeatureRead } from '@/lib/query';
import { TableRequestError } from '@/features/tables/request-state';
import type { TableApi, TableDefinition } from '@/features/tables/api';
import { useTableDetail } from '@/features/tables/hooks';
import { tableKeys } from '@/features/tables/queries';
import { readTaskActivity, readTaskRows, type TaskActivity, type TaskCard } from './api';
import { taskPolling, type TaskKeys } from './task-api';

const tasksTableSchema = z.object({ tableId: z.uuid().nullable() });

async function readTasksTable(workspaceId: string, signal: AbortSignal) {
  const response = await jsonResponse(`${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/tasks-table`, {
    method: 'GET',
    signal,
    cache: 'no-store',
  });
  const value = await readJson(response, true);
  if (!response.ok)
    throw new TableRequestError(
      response.status,
      responseError(value, 'tasks-unavailable'),
      'Tasks could not be loaded. Try again.',
    );
  return tasksTableSchema.parse(value).tableId;
}

/** Which table holds the workspace's tasks, or null when the workspace has none. */
export const useTasksTableRead = (workspaceId: string) =>
  useFeatureRead({
    key: ['tasks-table', workspaceId] as const,
    load: signal => readTasksTable(workspaceId, signal),
    staleTime: 5 * 60_000,
  });

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
    ...taskPolling,
  });
}

/** Rereads at once when the person comes back to the tab or window, instead of waiting for the next poll. */
export function useRefreshOnReturn(refresh: () => void) {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    const back = () => {
      if (document.visibilityState === 'visible') latest.current();
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, []);
}

const live = (activity: TaskActivity | undefined) =>
  Boolean(activity?.tasks.some(task => task.runState === 'queued' || task.runState === 'working'));

/** Agent progress on tasks, checked every 2 seconds while an agent is busy and every 5 otherwise. */
export function useTaskActivity(workspaceId: string) {
  const busy = useRef(false);
  // A stable interval: a new function on each render would restart the poll timer before it fires.
  const interval = useCallback(() => (busy.current ? 2000 : 5000), []);
  return useFeatureRead({
    key: ['task-board', 'activity', workspaceId] as const,
    load: async signal => {
      const data = await readTaskActivity(workspaceId, signal);
      busy.current = live(data);
      return data;
    },
    pollWhile: () => true,
    interval,
    maxChecks: Infinity,
  });
}

export type TaskOption = { id: string; key: string | null; title: string };

export function keysByRow(keys: TaskKeys | undefined) {
  return new Map(keys?.keys.map(item => [item.rowId, item.key]));
}

export const taskOptions = (cards: readonly TaskCard[], keys: ReadonlyMap<string, string>): TaskOption[] =>
  cards.map(card => ({ id: card.id, key: keys.get(card.id) ?? null, title: card.title }));

export const optionLabel = (option: TaskOption) => (option.key ? `${option.key} ${option.title}` : option.title);
