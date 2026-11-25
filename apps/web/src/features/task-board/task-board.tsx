import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChatIcon, TasksIcon } from '@tulipfarm/icons';
import { Badge } from '@tulipfarm/sprout/badge';
import { Board, type BoardColumn } from '@tulipfarm/sprout/board';
import { Button } from '@tulipfarm/sprout/button';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Status, type StatusState } from '@tulipfarm/sprout/status';
import { toast } from '@tulipfarm/sprout/toast';
import { ToggleGroup, ToggleGroupItem } from '@tulipfarm/sprout/toggle-group';
import { tableApi } from '@/features/tables/api';
import { useTableChanges } from '@/features/tables/changes';
import type { TableWorkspace } from '@/features/tables/references';
import { ActorName } from '@/features/tables/actors';
import { useTaskApi, useTasks } from '@/features/tasks/queries';
import { lanes, taskCards, type Lane, type TaskCard } from './api';
import { ago, currentStep, duration, useAssignmentRun, useNow, sentence } from './live';
import { taskShows, type TaskBoardSearch, type TaskShow } from './search';
import { applyTaskMove, moveHints, taskMove } from './moves';
import { TaskFieldsMenu } from './fields-menu';
import { canonicalTaskKey, useTaskKeys } from './task-api';
import { TaskComposer } from './task-composer';
import { keysByRow, taskOptions, useTaskActivity, useTaskRows, useTasksTable } from './task-data';

const showLabels: Record<TaskShow, string> = { all: 'All', mine: 'Assigned to me', agents: 'Agents' };

export const laneStatus: Record<Lane, StatusState> = {
  todo: 'pending',
  queued: 'paused',
  working: 'running',
  'needs-you': 'warning',
  done: 'success',
};
export const cardStatus = (card: TaskCard): StatusState => (card.state === 'failed' ? 'error' : laneStatus[card.lane]);

/** The built-in Tasks table as a live board: who is doing what, and how far each agent has got. */
export function TaskBoard({
  workspace,
  tableId,
  search,
  changeSearch,
}: {
  workspace: TableWorkspace;
  tableId: string;
  search: TaskBoardSearch;
  changeSearch: (next: Partial<TaskBoardSearch>) => void;
}) {
  const navigate = useNavigate();
  const api = useMemo(() => tableApi(workspace.id), [workspace.id]);
  const { detail, table, canCreate, canUpdate } = useTasksTable(api, tableId);
  const rows = useTaskRows(api, table);
  const activity = useTaskActivity(workspace.id);
  const progress = activity.state.kind === 'ready' ? activity.state.data : undefined;
  const keys = useTaskKeys(workspace.id);
  const keyOf = useMemo(() => keysByRow(keys.state.kind === 'ready' ? keys.state.data : undefined), [keys.state]);
  const changes = useTableChanges();
  const seen = useRef<string | null>(null);
  const signature = progress?.tasks.map(task => `${task.rowId}:${task.runState}:${task.updatedAt}`).join('|') ?? null;
  useEffect(() => {
    // An agent's run can change the row itself, such as its Run state, so reread rows when progress moves.
    if (signature !== null && seen.current !== null && seen.current !== signature) void changes.records(tableId);
    seen.current = signature;
  }, [signature, tableId, changes]);
  const [creating, setCreating] = useState(false);
  const openTask = (key: string) =>
    void navigate({
      to: '/$workspaceSlug/tasks/$key',
      params: { workspaceSlug: workspace.slug, key },
      search: { show: search.show, q: search.q },
    });
  // Old links name a task by row ID; send them to the task's own page.
  const legacy = search.task ? keyOf.get(search.task) : undefined;
  useEffect(() => {
    if (legacy)
      void navigate({
        to: '/$workspaceSlug/tasks/$key',
        params: { workspaceSlug: workspace.slug, key: legacy },
        replace: true,
      });
  }, [legacy, navigate, workspace.slug]);
  const records = rows.state.kind === 'ready' ? rows.state.data.records : [];
  // Shows a dropped card in its new column until the board has reread it.
  const [moved, setMoved] = useState<{ id: string; lane: Lane } | null>(null);
  const cards = useMemo(
    () => taskCards(records, progress).map(card => (moved?.id === card.id ? { ...card, lane: moved.lane } : card)),
    [records, progress, moved],
  );
  // Someone else's new task has no key here yet, so reread the keys once when one is missing.
  const keyless = keys.state.kind === 'ready' && cards.some(card => !keyOf.has(card.id));
  const rereadKeys = keys.refresh;
  useEffect(() => {
    if (keyless) void rereadKeys();
  }, [keyless, rereadKeys]);
  const show = search.show ?? 'all';
  const query = (search.q ?? '').trim().toLowerCase();
  const queryKey = canonicalTaskKey(query);
  const visible = cards.filter(
    card =>
      (show === 'all' ||
        (show === 'agents' && card.assignee?.type === 'agent') ||
        (show === 'mine' && card.assignee?.type === 'member' && card.assignee.id === progress?.me)) &&
      (!query ||
        card.title.toLowerCase().includes(query) ||
        (queryKey ? keyOf.get(card.id) === queryKey : keyOf.get(card.id)?.toLowerCase().includes(query))),
  );
  const filtered = show !== 'all' || query.length > 0;
  const working = visible.filter(card => card.lane === 'working').length;
  const needsYou = visible.filter(card => card.lane === 'needs-you').length;
  const now = useNow(visible.some(card => card.lane === 'working' || card.lane === 'queued'));
  const agentRunsRead = useTasks(useTaskApi(workspace.id), undefined, '');
  const agentRunCount = agentRunsRead.state.kind === 'ready' ? agentRunsRead.state.data.tasks.length : 0;
  const boardContainer = useRef<HTMLDivElement>(null);
  const scrollToLane = (index: number) => {
    const columnsEl = boardContainer.current?.querySelectorAll<HTMLElement>(
      '[data-slot="board-column"], [role="region"]',
    );
    columnsEl?.[index]?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  };
  const columns = useMemo<BoardColumn[]>(
    () =>
      lanes.map(lane => ({
        id: lane.id,
        title: lane.title,
        icon: <Status state={laneStatus[lane.id]} size="sm" aria-hidden="true" tooltip={false} />,
      })),
    [],
  );
  const items = useMemo(() => visible.map(card => ({ ...card, columnId: card.lane })), [visible]);
  const drop = async (card: TaskCard, lane: Lane) => {
    const move = taskMove(card, lane);
    if (!move) return;
    setMoved({ id: card.id, lane });
    const failure = await applyTaskMove(workspace.id, tableId, card, move);
    if (failure) toast.add({ title: failure, type: 'error' });
    await refresh().catch(() => undefined);
    setMoved(null);
  };
  const refresh = async () => {
    await changes.records(tableId);
    await activity.refresh();
  };

  if (detail.state.kind === 'error' || rows.state.kind === 'error')
    return (
      <StatePanel
        heading="h1"
        kind="error"
        title="Tasks could not be loaded"
        description="Check your connection and try again."
      >
        <Button onClick={() => void (detail.state.kind === 'error' ? detail.refresh() : rows.refresh())}>
          Try again
        </Button>
      </StatePanel>
    );
  if (!table || rows.state.kind !== 'ready') return <p className="text-sm text-muted-foreground">Loading Tasks…</p>;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        title="Tasks"
        description={
          cards.length === 0
            ? 'Assign work to a person or an agent and follow it here.'
            : filtered
              ? `Showing ${visible.length} of ${cards.length} ${cards.length === 1 ? 'task' : 'tasks'} · ${working} working · ${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you`
              : `${cards.length} ${cards.length === 1 ? 'task' : 'tasks'} · ${working} working · ${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you`
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <TaskFieldsMenu table={table} />
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link to="/$workspaceSlug/agent-tasks" params={{ workspaceSlug: workspace.slug }} />}
            >
              {agentRunCount > 0 ? `Agent runs (${agentRunCount})` : 'Agent runs'}
            </Button>
            {canCreate && (
              <Button onClick={() => setCreating(true)} disabled={creating}>
                New task
              </Button>
            )}
          </div>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          value={[show]}
          onValueChange={value => {
            const next = value[0] as TaskShow | undefined;
            if (next) changeSearch({ show: next === 'all' ? undefined : next });
          }}
          aria-label="Show tasks"
        >
          {taskShows.map(item => (
            <ToggleGroupItem key={item} value={item}>
              {showLabels[item]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="w-64 max-w-full">
          <SearchField
            label="Search tasks"
            placeholder="Search tasks"
            value={search.q ?? ''}
            onChange={value => changeSearch({ q: value || undefined })}
          />
        </div>
        {rows.state.data.more && (
          <span className="text-xs text-muted-foreground">
            Showing the newest tasks. Search by key, such as TUL-042, to open an older one.
          </span>
        )}
      </div>
      {cards.length === 0 ? (
        <StatePanel
          kind="empty"
          icon={TasksIcon}
          title="No tasks yet"
          description="Create a task and assign it to an agent. Its progress shows here as it works."
        >
          {canCreate && <Button onClick={() => setCreating(true)}>New task</Button>}
        </StatePanel>
      ) : (
        <div ref={boardContainer} data-task-board="" className="flex min-h-0 flex-1 flex-col gap-3">
          <nav aria-label="Task columns" className="flex gap-1.5 overflow-x-auto pb-0.5 sm:hidden">
            {lanes.map((lane, index) => {
              const laneCount = visible.filter(card => card.lane === lane.id).length;
              return (
                <Button key={lane.id} variant="outline" size="sm" onClick={() => scrollToLane(index)}>
                  <Status state={laneStatus[lane.id]} size="sm" aria-hidden="true" tooltip={false} />
                  {lane.title} ({laneCount})
                </Button>
              );
            })}
          </nav>
          <Board
            label="Tasks by status"
            columns={columns}
            items={items}
            columnText={{ empty: 'No tasks' }}
            renamable={false}
            canDrag={card => canUpdate && card.lane !== 'working'}
            canDrop={(card, to) => taskMove(card, to.columnId as Lane) !== null}
            dropText={(card, to) => {
              const move = taskMove(card, to.columnId as Lane);
              return move && moveHints[move];
            }}
            onItemsChange={
              canUpdate
                ? next => {
                    const card = next.find(item => item.columnId !== item.lane);
                    if (card) void drop(card, card.columnId as Lane);
                  }
                : undefined
            }
            onItemOpen={card => {
              const key = keyOf.get(card.id);
              if (key) openTask(key);
            }}
            renderTitle={card => {
              const key = keyOf.get(card.id);
              return (
                <span>
                  {key && <span className="mr-1.5 text-xs font-normal text-muted-foreground tabular-nums">{key}</span>}
                  {card.title}
                </span>
              );
            }}
            renderBody={card =>
              hasCardBody(card) ? <TaskCardBody card={card} workspace={workspace} me={progress?.me} now={now} /> : null
            }
          />
        </div>
      )}
      {creating && (
        <TaskComposer
          workspace={workspace}
          table={table}
          api={api}
          me={progress?.me}
          tasks={taskOptions(cards, keyOf)}
          close={() => setCreating(false)}
        />
      )}
    </div>
  );
}

const hasFooter = (card: TaskCard) => !!card.assignee || card.comments > 0 || card.state === 'failed';

/** Whether a card has anything to show under its title; Sprout leaves out a null body. */
const hasCardBody = (card: TaskCard) => {
  const activity = card.activity;
  return (
    hasFooter(card) ||
    (card.lane === 'working' && !!activity?.run) ||
    (card.lane === 'queued' && !!activity) ||
    (card.lane === 'needs-you' && !!activity?.reason) ||
    (card.lane === 'done' && !!activity?.note)
  );
};

/** What a card shows under its title: live progress, the reason it waits, who has it. */
function TaskCardBody({
  card,
  workspace,
  me,
  now,
}: {
  card: TaskCard;
  workspace: TableWorkspace;
  me: string | undefined;
  now: number;
}) {
  const activity = card.activity;
  const run = useAssignmentRun(workspace.id, card.lane === 'working' ? activity : null, me);
  const step = currentStep(run);
  const steps = Math.max(activity?.run?.steps ?? 0, run?.toolCalls ?? 0);
  const footer = hasFooter(card);
  return (
    <div className="w-full space-y-2 pt-1">
      {card.lane === 'working' && activity?.run && (
        <div className="space-y-0.5 rounded-md bg-info-subtle px-2 py-1.5 text-foreground">
          <p className="truncate font-medium" aria-live="polite">
            {step ?? 'Working…'}
          </p>
          <p className="text-muted-foreground">
            {duration(now - new Date(activity.run.startedAt).getTime())} · {steps} {steps === 1 ? 'step' : 'steps'}
          </p>
        </div>
      )}
      {card.lane === 'queued' && activity && <p>Waiting for a turn · queued {ago(activity.updatedAt, now)}</p>}
      {card.lane === 'needs-you' && activity?.reason && (
        <p className="line-clamp-2 rounded-md bg-warning-subtle px-2 py-1.5 text-warning">
          {sentence(activity.reason)}
          {activity.wakeAt &&
            ` Checks again ${new Date(activity.wakeAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.`}
        </p>
      )}
      {card.lane === 'done' && activity?.note && <p className="line-clamp-2">{plain(activity.note.body)}</p>}
      {footer && (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1">
            {card.assignee && <ActorName workspaceId={workspace.id} actor={card.assignee} compact />}
          </span>
          {card.state === 'failed' && <Badge variant="destructive">Failed</Badge>}
          {card.comments > 0 && (
            <span className="flex items-center gap-1" aria-label={`${card.comments} comments`}>
              <ChatIcon size="xs" aria-hidden="true" />
              {card.comments}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** A one-line preview of a Markdown note. */
const plain = (markdown: string) =>
  markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~[\]]|\(https?:[^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
