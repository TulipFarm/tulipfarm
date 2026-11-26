import { useEffect, useMemo } from 'react';
import { toast } from '@tulipfarm/sprout/toast';
import { tableApi } from '@/features/tables/api';
import type { TableWorkspace } from '@/features/tables/references';
import { taskCards } from './api';
import { useTaskKeys } from './task-api';
import { TaskComposer } from './task-composer';
import { keysByRow, taskOptions, useTaskActivity, useTaskRows, useTasksTable, useTasksTableRead } from './task-data';

/** The task composer over whatever page is open, loading the Tasks table it needs itself. */
export function QuickTask({ workspace, close }: { workspace: TableWorkspace; close: () => void }) {
  const tableRead = useTasksTableRead(workspace.id);
  const tableId = tableRead.state.kind === 'ready' ? tableRead.state.data : null;
  const missing = tableRead.state.kind === 'unavailable' || (tableRead.state.kind === 'ready' && tableId === null);
  return tableRead.state.kind === 'error' ? (
    <Unavailable title={failed} close={close} />
  ) : missing ? (
    <Unavailable title={denied} close={close} />
  ) : tableId ? (
    <Composer workspace={workspace} tableId={tableId} close={close} />
  ) : null;
}

function Composer({ workspace, tableId, close }: { workspace: TableWorkspace; tableId: string; close: () => void }) {
  const api = useMemo(() => tableApi(workspace.id), [workspace.id]);
  const { detail, table, canCreate } = useTasksTable(api, tableId);
  const rows = useTaskRows(api, table);
  const activity = useTaskActivity(workspace.id);
  const keys = useTaskKeys(workspace.id);
  const me = activity.state.kind === 'ready' ? activity.state.data.me : undefined;
  const tasks = useMemo(() => {
    if (rows.state.kind !== 'ready') return [];
    const keyOf = keysByRow(keys.state.kind === 'ready' ? keys.state.data : undefined);
    return taskOptions(taskCards(rows.state.data.records, undefined), keyOf);
  }, [rows.state, keys.state]);
  if (detail.state.kind === 'error') return <Unavailable title={failed} close={close} />;
  if (detail.state.kind === 'unavailable' || (table && !canCreate)) return <Unavailable title={denied} close={close} />;
  if (!table) return null;
  return <TaskComposer workspace={workspace} table={table} api={api} me={me} tasks={tasks} close={close} />;
}

const failed = 'Tasks could not be loaded. Try again.';
const denied = 'You can’t create tasks in this workspace.';

/** Closes the request with a reason instead of leaving an empty dialog. */
function Unavailable({ title, close }: { title: string; close: () => void }) {
  useEffect(() => {
    toast.add({ title, type: 'error' });
    close();
  }, [title, close]);
  return null;
}
