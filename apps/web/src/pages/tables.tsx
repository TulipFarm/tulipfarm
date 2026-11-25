import { ChatIcon } from '@tulipfarm/icons';
import { Link, Navigate } from '@tanstack/react-router';
import { z } from 'zod';
import { tableDetailRoute, tableEditRoute, taskRoute, tasksRoute, workspaceRoute } from '@/router';
import { Button } from '@tulipfarm/sprout/button';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { CreateInChatSample, StatePanel } from '@tulipfarm/sprout/state-panel';
import { TableDetail } from '@/features/tables/tables';
import { TaskBoard } from '@/features/task-board/task-board';
import { canonicalTaskKey } from '@/features/task-board/task-api';
import { TaskView } from '@/features/task-board/task-page';
import { TableRequestError } from '@/features/tables/request-state';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { useFeatureRead } from '@/lib/query';

export function TableDetailPage() {
  const { tableId } = tableDetailRoute.useParams();
  const { workspace, sessionId } = workspaceRoute.useRouteContext();
  const search = tableDetailRoute.useSearch();
  const navigate = tableDetailRoute.useNavigate();
  const tasks = useTasksTableId(workspace.id);
  if (tasks.kind === 'loading') return null;
  // Tasks never show as a table; its rows open as tasks.
  if (tasks.kind === 'ready' && tasks.data === tableId)
    return (
      <Navigate
        to="/$workspaceSlug/tasks"
        params={{ workspaceSlug: workspace.slug }}
        search={search.row ? { task: search.row } : {}}
        replace
      />
    );
  return (
    <PageContent>
      <TableDetail
        key={`${workspace.id}/${tableId}`}
        workspace={{ id: workspace.id, slug: workspace.slug, sessionId }}
        tableId={tableId}
        search={search}
        changeSearch={next => void navigate({ search: current => ({ ...current, ...next }), replace: true })}
      />
    </PageContent>
  );
}

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

const useTasksRead = (workspaceId: string) =>
  useFeatureRead({
    key: ['tasks-table', workspaceId] as const,
    load: signal => readTasksTable(workspaceId, signal),
    staleTime: 5 * 60_000,
  });

/** The Tasks table ID, or `missing` when it can't be read, so table pages still open. */
function useTasksTableId(workspaceId: string) {
  const state = useTasksRead(workspaceId).state;
  return state.kind === 'error' ? ({ kind: 'missing' } as const) : state;
}

/** The workspace's built-in Tasks as a live board of who is doing what. */
export function TasksPage() {
  const { workspace, sessionId } = workspaceRoute.useRouteContext();
  const search = tasksRoute.useSearch();
  const navigate = tasksRoute.useNavigate();
  const read = useTasksRead(workspace.id);
  const state = read.state;
  return (
    <PageContent data-task-page="">
      {state.kind === 'ready' && state.data ? (
        <TaskBoard
          key={`${workspace.id}/${state.data}`}
          workspace={{ id: workspace.id, slug: workspace.slug, sessionId }}
          tableId={state.data}
          search={search}
          changeSearch={next => void navigate({ search: current => ({ ...current, ...next }), replace: true })}
        />
      ) : state.kind === 'loading' ? (
        <p className="text-sm text-muted-foreground">Loading Tasks…</p>
      ) : state.kind === 'error' ? (
        <StatePanel
          heading="h1"
          kind="error"
          title="Tasks could not be loaded"
          description="Check your connection and try again."
        >
          <Button onClick={() => void read.refresh()}>Try again</Button>
        </StatePanel>
      ) : (
        <StatePanel
          heading="h1"
          kind="unavailable"
          title="Tasks isn’t available in this workspace"
          description="Your tables are still in Tables."
        >
          <Button
            nativeButton={false}
            render={<Link to="/$workspaceSlug/tables" params={{ workspaceSlug: workspace.slug }} />}
          >
            Open tables
          </Button>
        </StatePanel>
      )}
    </PageContent>
  );
}

/** One task on its own page, addressed by its key, such as TUL-123. */
export function TaskPage() {
  const { key } = taskRoute.useParams();
  const { workspace, sessionId } = workspaceRoute.useRouteContext();
  const search = taskRoute.useSearch();
  const canonical = canonicalTaskKey(key);
  if (canonical && canonical !== key)
    return (
      <Navigate
        to="/$workspaceSlug/tasks/$key"
        params={{ workspaceSlug: workspace.slug, key: canonical }}
        search={search}
        replace
      />
    );
  return (
    <PageContent data-task-page="">
      <TaskView
        key={`${workspace.id}/${key}`}
        workspace={{ id: workspace.id, slug: workspace.slug, sessionId }}
        taskKey={key}
        back={search}
      />
    </PageContent>
  );
}

export function NewTablePage() {
  return <SchemaInChat />;
}
export function EditTablePage() {
  const { tableId } = tableEditRoute.useParams();
  const { workspace } = workspaceRoute.useRouteContext();
  const tasks = useTasksTableId(workspace.id);
  if (tasks.kind === 'loading') return null;
  if (tasks.kind === 'ready' && tasks.data === tableId)
    return <Navigate to="/$workspaceSlug/tasks" params={{ workspaceSlug: workspace.slug }} replace />;
  return <SchemaInChat tableId={tableId} />;
}

function SchemaInChat({ tableId }: { tableId?: string }) {
  const { workspace } = workspaceRoute.useRouteContext();
  return (
    <PageContent>
      <PageHeader
        title={tableId ? 'Change table fields' : 'Create a table'}
        back={{
          label: 'Back to tables',
          link: <Link to="/$workspaceSlug/tables" params={{ workspaceSlug: workspace.slug }} />,
        }}
      />
      <StatePanel
        kind="empty"
        icon={ChatIcon}
        title="Build tables in chat"
        description="Describe the fields and changes you need to the built-in assistant. Review the exact schema and row effects in your chat before approving execution."
        sample={<CreateInChatSample />}
      >
        <Button
          nativeButton={false}
          render={
            <Link
              to="/$workspaceSlug"
              params={{ workspaceSlug: workspace.slug }}
              search={tableId ? { intent: 'edit-table', tableId } : { intent: 'create-table' }}
            />
          }
        >
          <ChatIcon size="md" aria-hidden="true" />
          {tableId ? 'Change fields in chat' : 'Create table in chat'}
        </Button>
      </StatePanel>
    </PageContent>
  );
}
