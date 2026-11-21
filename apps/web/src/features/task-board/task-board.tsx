import { useEffect, useMemo, useRef, useState } from 'react';
import { ChatIcon } from '@tulipfarm/icons';
import { Badge } from '@tulipfarm/sprout/badge';
import { Board, type BoardColumn } from '@tulipfarm/sprout/board';
import { Button } from '@tulipfarm/sprout/button';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Status, type StatusState } from '@tulipfarm/sprout/status';
import { toast } from '@tulipfarm/sprout/toast';
import { ToggleGroup, ToggleGroupItem } from '@tulipfarm/sprout/toggle-group';
import { useFeatureRead } from '@/lib/query';
import { tableApi, type TableDefinition } from '@/features/tables/api';
import { useTableChanges } from '@/features/tables/changes';
import { useTableDetail } from '@/features/tables/hooks';
import { tableKeys } from '@/features/tables/queries';
import { RecordEditor } from '@/features/tables/record-editor';
import type { TableWorkspace } from '@/features/tables/references';
import { ActorName } from '@/features/tables/actors';
import { lanes, readTaskActivity, readTaskRows, taskCards, type Lane, type TaskActivity, type TaskCard } from './api';
import { ago, currentStep, duration, useAssignmentRun, useNow, sentence } from './live';
import { taskShows, type TaskBoardSearch, type TaskShow } from './search';
import { applyTaskMove, moveHints, taskMove } from './moves';
import { TaskSheet } from './task-panel';

const showLabels: Record<TaskShow, string> = { all: 'All', mine: 'Assigned to me', agents: 'Agents' };

export const laneStatus: Record<Lane, StatusState> = {
  todo: 'pending',
  queued: 'paused',
  working: 'running',
  'needs-you': 'warning',
  done: 'success',
};
export const cardStatus = (card: TaskCard): StatusState => (card.state === 'failed' ? 'error' : laneStatus[card.lane]);

const live = (activity: TaskActivity | undefined) =>
  Boolean(activity?.tasks.some(task => task.runState === 'queued' || task.runState === 'working'));

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
  const api = useMemo(() => tableApi(workspace.id), [workspace.id]);
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
  const rows = useFeatureRead({
    key: [...tableKeys.records(tableId), 'task-board', table?.revision ?? null] as const,
    enabled: table !== null,
    load: signal => readTaskRows(api, table!, signal),
  });
  const busy = useRef(false);
  const activity = useFeatureRead({
    key: ['task-board', 'activity', workspace.id] as const,
    load: async signal => {
      const data = await readTaskActivity(workspace.id, signal);
      busy.current = live(data);
      return data;
    },
    // Busy agents are checked every 2 seconds; otherwise every 10, so work others start still appears.
    pollWhile: () => true,
    interval: () => (busy.current ? 2000 : 10_000),
    maxChecks: 2000,
  });
  const progress = activity.state.kind === 'ready' ? activity.state.data : undefined;
  const changes = useTableChanges();
  const seen = useRef<string | null>(null);
  const signature = progress?.tasks.map(task => `${task.rowId}:${task.runState}:${task.updatedAt}`).join('|') ?? null;
  useEffect(() => {
    // An agent's run can change the row itself, such as its Run state, so reread rows when progress moves.
    if (signature !== null && seen.current !== null && seen.current !== signature) void changes.records(tableId);
    seen.current = signature;
  }, [signature, tableId, changes]);
  const [creating, setCreating] = useState(false);
  // The editor's unsaved-changes guard blocks navigation while it is mounted, so open the new task after it closes.
  const [created, setCreated] = useState<string | null>(null);
  useEffect(() => {
    if (!creating && created) {
      setCreated(null);
      changeSearch({ task: created });
    }
  }, [creating, created, changeSearch]);
  const records = rows.state.kind === 'ready' ? rows.state.data.records : [];
  // Shows a dropped card in its new column until the board has reread it.
  const [moved, setMoved] = useState<{ id: string; lane: Lane } | null>(null);
  const cards = useMemo(
    () => taskCards(records, progress).map(card => (moved?.id === card.id ? { ...card, lane: moved.lane } : card)),
    [records, progress, moved],
  );
  const show = search.show ?? 'all';
  const query = (search.q ?? '').trim().toLowerCase();
  const visible = cards.filter(
    card =>
      (show === 'all' ||
        (show === 'agents' && card.assignee?.type === 'agent') ||
        (show === 'mine' && card.assignee?.type === 'member' && card.assignee.id === progress?.me)) &&
      (!query || card.title.toLowerCase().includes(query)),
  );
  const open = search.task ? cards.find(card => card.id === search.task) : undefined;
  const working = visible.filter(card => card.lane === 'working').length;
  const needsYou = visible.filter(card => card.lane === 'needs-you').length;
  const now = useNow(visible.some(card => card.lane === 'working' || card.lane === 'queued'));
  const canCreate = Boolean(state?.rowPermissions.create) && !state?.archived;
  const canUpdate = Boolean(state?.rowPermissions.update) && !state?.archived;
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
            : `${cards.length} ${cards.length === 1 ? 'task' : 'tasks'} · ${working} working · ${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you`
        }
        actions={
          canCreate && (
            <Button onClick={() => setCreating(true)} disabled={creating}>
              New task
            </Button>
          )
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
            Showing the newest tasks. Open the Tasks table for older ones.
          </span>
        )}
      </div>
      {cards.length === 0 ? (
        <StatePanel
          kind="empty"
          title="No tasks yet"
          description="Create a task and assign it to an agent. Its progress shows here as it works."
        >
          {canCreate && <Button onClick={() => setCreating(true)}>New task</Button>}
        </StatePanel>
      ) : (
        <div data-task-board="" className="flex min-h-0 flex-1 flex-col">
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
            onItemOpen={card => changeSearch({ task: card.id })}
            renderBody={card =>
              hasCardBody(card) ? <TaskCardBody card={card} workspace={workspace} me={progress?.me} now={now} /> : null
            }
          />
        </div>
      )}
      {open && (
        <TaskSheet
          card={open}
          table={table}
          api={api}
          workspace={workspace}
          me={progress?.me}
          now={now}
          canUpdate={canUpdate}
          close={() => changeSearch({ task: undefined })}
          refresh={refresh}
        />
      )}
      {creating && (
        <RecordEditor
          record={null}
          table={table}
          api={api}
          workspace={workspace}
          disabled={false}
          close={() => setCreating(false)}
          saved={recordId => {
            setCreated(recordId);
            setCreating(false);
            void refresh();
          }}
          refresh={refresh}
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
