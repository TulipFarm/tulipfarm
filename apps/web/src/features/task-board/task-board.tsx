import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChatIcon, TasksIcon } from '@tulipfarm/icons';
import { Badge } from '@tulipfarm/sprout/badge';
import { Board, type BoardColumn } from '@tulipfarm/sprout/board';
import { Button } from '@tulipfarm/sprout/button';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { Skeleton, SkeletonGroup } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Status, type StatusState } from '@tulipfarm/sprout/status';
import { toast } from '@tulipfarm/sprout/toast';
import { ToggleGroup, ToggleGroupItem } from '@tulipfarm/sprout/toggle-group';
import { tableApi } from '@/features/tables/api';
import { useTableChanges } from '@/features/tables/changes';
import type { TableWorkspace } from '@/features/tables/references';
import { ActorName } from '@/features/tables/actors';
import { useTaskApi, useTasks } from '@/features/tasks/queries';
import { useFeatureRead } from '@/lib/query';
import { codeSessionApi } from '@/features/code-sessions/api';
import { useFlag } from '@/lib/feature-flags';
import type { CodeSessionView } from '@tulipfarm/agents/code-session-contracts';
import { lanes, taskCards, type Lane, type TaskCard } from './api';
import { ago, currentStep, duration, useAssignmentRun, useNow, sentence } from './live';
import { taskShows, type TaskBoardSearch, type TaskShow } from './search';
import { applyTaskMove, moveHints, taskMove } from './moves';
import { TaskFieldsMenu } from './fields-menu';
import { canonicalTaskKey, useTaskKeys } from './task-api';
import { TaskComposer } from './task-composer';
import { keysByRow, taskOptions, useRefreshOnReturn, useTaskActivity, useTaskRows, useTasksTable } from './task-data';

const showLabels: Record<TaskShow, string> = { all: 'All', mine: 'Assigned to me', agents: 'Agents' };

export const laneStatus: Record<Lane, StatusState> = {
  todo: 'pending',
  queued: 'paused',
  working: 'running',
  'needs-you': 'warning',
  done: 'success',
};
export const cardStatus = (card: TaskCard): StatusState => (card.state === 'failed' ? 'error' : laneStatus[card.lane]);

/**
 * A column's mark. Working is a still, half-filled ring like Linear's In progress, so a column header never spins;
 * a card's own mark still shows its run moving.
 */
function LaneIcon({ lane }: { lane: Lane }) {
  if (lane !== 'working') return <Status state={laneStatus[lane]} size="sm" aria-hidden="true" tooltip={false} />;
  return (
    <svg
      viewBox="0 0 20 20"
      className="size-3 shrink-0 text-info"
      fill="none"
      aria-hidden="true"
      data-lane-icon="working"
    >
      <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="2" />
      <path d="M10 5a5 5 0 0 1 0 10Z" fill="currentColor" />
    </svg>
  );
}

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
  useRefreshOnReturn(() => {
    void rows.refresh();
    void activity.refresh();
    void keys.refresh();
  });
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
  const codeSessionsEnabled = useFlag('code-sessions');
  const codeSessionsRead = useFeatureRead({
    key: ['code-sessions', 'workspace-board', workspace.id] as const,
    enabled: codeSessionsEnabled,
    load: signal => codeSessionApi(workspace.id).list({ scope: 'workspace' }, signal),
    pollWhile: () => codeSessionsEnabled,
    interval: 10_000,
    maxChecks: 2000,
  });
  const codeSessionByRow = useMemo(() => {
    const map = new Map<string, CodeSessionView>();
    if (codeSessionsRead.state.kind !== 'ready') return map;
    for (const session of codeSessionsRead.state.data.sessions) {
      if (session.rowId && !map.has(session.rowId)) map.set(session.rowId, session);
    }
    return map;
  }, [codeSessionsRead.state]);
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
        icon: <LaneIcon lane={lane.id} />,
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
  if (!table || rows.state.kind !== 'ready') return <TaskBoardSkeleton />;

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
                  <LaneIcon lane={lane.id} />
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
            renderBody={card => {
              const codeSession = codeSessionByRow.get(card.id);
              return hasCardBody(card) || codeSession ? (
                <TaskCardBody card={card} codeSession={codeSession} workspace={workspace} me={progress?.me} now={now} />
              ) : null;
            }}
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

/** Holds the board's shape while its first read loads: header, filters and the five lanes with a few cards. */
export function TaskBoardSkeleton() {
  return (
    <SkeletonGroup label="Loading tasks" gap="lg" data-task-board-skeleton="">
      <div className="flex items-start justify-between gap-4">
        <div className="flex w-72 max-w-full flex-col gap-2">
          <Skeleton shape="title" />
          <Skeleton />
        </div>
        <div className="flex gap-2">
          <div className="w-24">
            <Skeleton shape="action" />
          </div>
          <div className="w-24">
            <Skeleton shape="action" />
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="w-56">
          <Skeleton shape="action" />
        </div>
        <div className="w-64 max-w-full">
          <Skeleton shape="action" />
        </div>
      </div>
      <div className="flex min-h-0 gap-3 overflow-hidden">
        {lanes.map((lane, index) => (
          <div key={lane.id} className="flex w-72 shrink-0 flex-col gap-3 rounded-lg bg-muted/40 p-3">
            <div className="w-24">
              <Skeleton />
            </div>
            {Array.from({ length: 3 - (index % 2) }, (_, card) => (
              <div key={card} className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
                <Skeleton />
                <div className="w-2/3">
                  <Skeleton />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </SkeletonGroup>
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
  codeSession,
  workspace,
  me,
  now,
}: {
  card: TaskCard;
  codeSession?: CodeSessionView | undefined;
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
      {codeSession && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <Badge variant={codeSession.stage === 'failed' ? 'destructive' : 'outline'}>{codeSession.stageLabel}</Badge>
          <span className="truncate font-mono text-muted-foreground">{codeSession.repository}</span>
          {codeSession.pullRequestNumber && <Badge variant="secondary">PR #{codeSession.pullRequestNumber}</Badge>}
        </div>
      )}
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
