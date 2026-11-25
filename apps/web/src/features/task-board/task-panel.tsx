import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { taskFields } from '@tulipfarm/tables/tasks-table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';
import { Button } from '@tulipfarm/sprout/button';
import { MessageResponse } from '@tulipfarm/sprout/message-response';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@tulipfarm/sprout/sheet';
import { Status } from '@tulipfarm/sprout/status';
import { toast } from '@tulipfarm/sprout/toast';
import { ToolActivity } from '@tulipfarm/sprout/tool-activity';
import type { TableApi, TableDefinition } from '@/features/tables/api';
import { ActorName, ActorPicker, type Actor } from '@/features/tables/actors';
import { RecordEditor } from '@/features/tables/record-editor';
import { RecordMutationFeedback, useRecordMutation } from '@/features/tables/record-mutation';
import type { TableWorkspace } from '@/features/tables/references';
import { RowThreadPanel, useRowThread } from '@/features/tables/row-thread';
import { TableRequestError } from '@/features/tables/request-state';
import { toolVisual } from '@/features/chat/tool-labels';
import { useFeatureChanges } from '@/lib/query';
import { taskCredits } from '@/features/tasks/api';
import type { TaskCard } from './api';
import { currentStep, duration, sentence, useAssignmentRun } from './live';
import { applyTaskMove, taskMove, type TaskMove } from './moves';
import { cardStatus } from './task-board';

const stateLabels = {
  queued: 'Queued',
  working: 'Working',
  waiting: 'Waiting for you',
  done: 'Done',
  failed: 'Failed',
} as const;

/** One task: who has it, what the agent is doing right now, and the row's conversation. */
export function TaskSheet({
  card,
  table,
  api,
  workspace,
  me,
  now,
  canUpdate,
  canDelete,
  close,
  refresh,
}: {
  card: TaskCard;
  table: TableDefinition;
  api: TableApi;
  workspace: TableWorkspace;
  me: string | undefined;
  now: number;
  canUpdate: boolean;
  canDelete: boolean;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [moving, setMoving] = useState(false);
  const move = taskMove(card, 'done') ?? (taskMove(card, 'todo') ? 'reopen' : null);
  const moveTask = async (next: TaskMove) => {
    setMoving(true);
    const failure = await applyTaskMove(workspace.id, table.id, card, next);
    if (failure) toast.add({ title: failure, type: 'error' });
    await refresh().catch(() => undefined);
    setMoving(false);
  };
  const { change: changed } = useFeatureChanges();
  const progress = `${card.state}:${card.activity?.updatedAt ?? ''}`;
  const shown = useRef(progress);
  useEffect(() => {
    // The thread only polls while an agent is busy, so reread it when the board sees the task move.
    if (shown.current === progress) return;
    shown.current = progress;
    void changed({ keys: [['tables', 'row-thread', workspace.id, table.id, card.id]] });
  }, [progress, changed, workspace.id, table.id, card.id]);
  const assign = useRecordMutation(api, () => void refresh());
  const remove = useRecordMutation(api, () => {
    setConfirmDelete(false);
    close();
    void refresh();
  });
  const locked = assign.locked || remove.locked;
  const change = (actor: Actor | null) =>
    void assign.submit({
      kind: 'update',
      requestId: crypto.randomUUID(),
      tableId: table.id,
      revision: table.revision,
      recordId: card.id,
      expectedToken: card.record.token,
      values: { [taskFields.assignee]: actor ? { kind: 'actor', actor } : null },
    });
  const deleteTask = () =>
    void remove.submit({
      kind: 'delete',
      requestId: crypto.randomUUID(),
      tableId: table.id,
      revision: table.revision,
      recordId: card.id,
      expectedToken: card.record.token,
    });
  if (editing)
    return (
      <RecordEditor
        record={card.record}
        table={table}
        api={api}
        workspace={workspace}
        disabled={false}
        close={() => setEditing(false)}
        saved={() => {
          setEditing(false);
          void refresh();
        }}
        refresh={refresh}
      />
    );
  return (
    <Sheet open onOpenChange={open => !open && !locked && close()}>
      <SheetContent size="lg" showCloseButton={!locked}>
        <SheetHeader>
          <SheetTitle>{card.title}</SheetTitle>
          <SheetDescription render={<div />}>
            <span className="flex flex-wrap items-center gap-2">
              <Status state={cardStatus(card)} size="sm" aria-hidden="true" tooltip={false} />
              {card.state ? stateLabels[card.state] : card.assignee ? 'To do' : 'Not assigned'}
              {canUpdate && move && (
                <Button size="sm" variant="outline" disabled={moving || locked} onClick={() => void moveTask(move)}>
                  {move === 'done' ? 'Mark done' : 'Reopen'}
                </Button>
              )}
            </span>
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 pb-6">
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-muted-foreground">Assignee</span>
              <span className="min-w-0 flex-1">
                <ActorPicker
                  workspaceId={workspace.id}
                  value={card.assignee}
                  disabled={!canUpdate || locked}
                  change={change}
                  label="Assignee"
                  size="sm"
                />
              </span>
            </div>
            {card.reporter && (
              <div className="flex items-center gap-3">
                <span className="w-24 shrink-0 text-muted-foreground">Reporter</span>
                <ActorName workspaceId={workspace.id} actor={card.reporter} />
              </div>
            )}
          </div>
          <RecordMutationFeedback mutation={assign} />
          <RecordMutationFeedback mutation={remove} />
          {card.assignee?.type === 'agent' && (
            <AgentWork card={card} table={table} workspace={workspace} me={me} now={now} refresh={refresh} />
          )}
          <section className="space-y-2" data-compact-text>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Description</h3>
              <div className="flex items-center gap-2">
                {canUpdate && (
                  <Button size="sm" variant="outline" disabled={locked} onClick={() => setEditing(true)}>
                    Edit
                  </Button>
                )}
                {canDelete && (
                  <Button size="sm" variant="ghost" disabled={locked} onClick={() => setConfirmDelete(true)}>
                    Delete
                  </Button>
                )}
              </div>
            </div>
            {card.description ? (
              <MessageResponse>{card.description}</MessageResponse>
            ) : (
              <p className="text-sm text-muted-foreground">No description.</p>
            )}
          </section>
          <RowThreadPanel
            workspaceId={workspace.id}
            tableId={table.id}
            rowId={card.id}
            changed={() => void refresh()}
            conversationOnly
            noun="task"
          />
        </div>
        <AlertDialog open={confirmDelete} onOpenChange={open => !remove.locked && setConfirmDelete(open)}>
          <AlertDialogContent>
            <AlertDialogTitle>Delete this task?</AlertDialogTitle>
            <AlertDialogDescription>“{card.title}” will be removed from the Tasks board.</AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={remove.locked}>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" disabled={remove.locked} onClick={deleteTask}>
                {remove.state.kind === 'sending' ? 'Deleting…' : 'Delete task'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}

/** Everything about the assigned agent's work in one place: why it stopped, what it is doing, and its runs. */
function AgentWork({
  card,
  table,
  workspace,
  me,
  now,
  refresh,
}: {
  card: TaskCard;
  table: TableDefinition;
  workspace: TableWorkspace;
  me: string | undefined;
  now: number;
  refresh: () => Promise<void>;
}) {
  const activity = card.activity;
  const latest = activity?.run;
  const run = useAssignmentRun(workspace.id, activity, me);
  const { api, read } = useRowThread(workspace.id, table.id, card.id);
  const thread = read.state.kind === 'ready' ? read.state.data : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await read.refresh();
      await refresh();
    } catch (failure) {
      setError(failure instanceof TableRequestError ? failure.message : 'The task could not be updated. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const step = currentStep(run);
  const elapsed = latest
    ? (latest.endedAt ? new Date(latest.endedAt).getTime() : now) - new Date(latest.startedAt).getTime()
    : 0;
  const steps = Math.max(latest?.steps ?? 0, run?.toolCalls ?? 0);
  const credits = run && run.cost.chargedCreditUnits !== '0' ? taskCredits(run.cost.chargedCreditUnits) : null;
  const stopped = card.state === 'waiting' || card.state === 'failed';
  const runs = thread?.runs ?? [];
  return (
    <section className="space-y-3 rounded-lg border p-3" aria-label="Agent work">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{latest && !latest.endedAt ? 'Working now' : 'Agent work'}</h3>
        <div className="flex items-center gap-1">
          {run && latest && (
            <Button
              size="sm"
              variant="ghost"
              nativeButton={false}
              render={
                <Link
                  to="/$workspaceSlug/agent-tasks/$taskId"
                  params={{ workspaceSlug: workspace.slug, taskId: latest.taskId }}
                />
              }
            >
              Open run
            </Button>
          )}
          {thread?.assignment?.canRunNow && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || card.state === 'working' || card.state === 'queued'}
              onClick={() => void act(api.runNow)}
            >
              Run now
            </Button>
          )}
        </div>
      </div>
      {stopped && activity?.reason && (
        <p
          className={`rounded-md px-3 py-2 text-sm ${card.state === 'failed' ? 'bg-destructive/10 text-destructive' : 'bg-warning-subtle text-warning'}`}
        >
          {sentence(activity.reason)} Reply below to continue.
        </p>
      )}
      {activity?.wakeAt && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>
            Checks again{' '}
            {new Date(activity.wakeAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
          </span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(api.clearWake)}>
            Clear wake-up
          </Button>
        </div>
      )}
      {card.state === 'queued' && <p className="text-sm text-muted-foreground">Waiting for a turn to start.</p>}
      {latest ? (
        <p className="text-xs text-muted-foreground">
          {latest.endedAt ? `Last run took ${duration(elapsed)}` : `Working for ${duration(elapsed)}`} · {steps}{' '}
          {steps === 1 ? 'step' : 'steps'}
          {credits ? ` · ${credits} credits` : ''}
        </p>
      ) : (
        !card.state && <p className="text-sm text-muted-foreground">Not started yet.</p>
      )}
      {latest && !latest.endedAt && step && (
        <p className="text-sm font-medium" aria-live="polite">
          {step}
        </p>
      )}
      {run && run.activity.length > 0 ? (
        <ToolActivity
          variant="stepper"
          items={run.activity.map(item => ({
            id: item.id,
            label: item.presentation.label,
            status: item.status,
            visual: toolVisual(item.tool, item.presentation.brand),
          }))}
        />
      ) : (
        latest &&
        !run && (
          <p className="text-xs text-muted-foreground">
            Step-by-step activity is shown to the person who assigned this agent.
          </p>
        )
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {runs.length > 1 && (
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
            All runs ({runs.length})
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
              {runs.map(item => (
                <li key={item.taskId}>
                  <Link
                    to="/$workspaceSlug/agent-tasks/$taskId"
                    params={{ workspaceSlug: workspace.slug, taskId: item.taskId }}
                  >
                    {new Date(item.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                  </Link>{' '}
                  · {item.endedAt ? (item.outcome ?? 'ended') : 'working'}
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
}
