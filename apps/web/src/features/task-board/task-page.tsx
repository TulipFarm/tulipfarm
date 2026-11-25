import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { taskFields } from '@tulipfarm/tables/tasks-table';
import { AddIcon, CopyIcon, MoreIcon } from '@tulipfarm/icons';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
import { Button } from '@tulipfarm/sprout/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { MessageResponse } from '@tulipfarm/sprout/message-response';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Status, type StatusState } from '@tulipfarm/sprout/status';
import { toast } from '@tulipfarm/sprout/toast';
import { BareText } from '@/components/ui/bare-text';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import { tableApi, type TableApi, type TableDataRow, type TableDefinition } from '@/features/tables/api';
import { FieldInput } from '@/features/tables/field-input';
import { RecordMutationFeedback, useRecordMutation } from '@/features/tables/record-mutation';
import { changedValues, rejectionMessage, validateRowDraft } from '@/features/tables/record-validation';
import type { TableWorkspace } from '@/features/tables/references';
import type { TableValues } from '@/features/tables/review-contracts';
import { RowThreadPanel } from '@/features/tables/row-thread';
import { CodeSessionTaskSection } from '@/features/code-sessions/CodeSessionTaskSection';
import { taskCards, type TaskCard } from './api';
import { AgentWork, stateLabels } from './agent-work';
import { useNow } from './live';
import { applyTaskMove, taskMove, type TaskMove } from './moves';
import { TaskReminders } from './reminders';
import type { TaskBoardSearch } from './search';
import { readTask, taskDetailKey, taskPolling, useTaskKeys, type TaskDetail } from './task-api';
import { cardStatus } from './task-board';
import { ActorMenu, ChipMenu, ParentMenu, type MenuChoice } from './task-chips';
import { customTaskFields, TaskComposer } from './task-composer';
import { keysByRow, taskOptions, useRefreshOnReturn, useTaskActivity, useTaskRows, useTasksTable } from './task-data';

/** A task's own page: its words and conversation on the left, everything about it on the right. */
export function TaskView({
  workspace,
  taskKey,
  back,
}: {
  workspace: TableWorkspace;
  taskKey: string;
  /** The board's filters, kept for the way back. */
  back: Omit<TaskBoardSearch, 'task'>;
}) {
  const read = useFeatureRead({
    key: taskDetailKey(workspace.id, taskKey),
    load: signal => readTask(workspace.id, taskKey, signal),
    ...taskPolling,
  });
  const backLink = <Link to="/$workspaceSlug/tasks" params={{ workspaceSlug: workspace.slug }} search={back} />;
  if (read.state.kind === 'loading') return <p className="text-sm text-muted-foreground">Loading task…</p>;
  if (read.state.kind === 'error' || read.state.kind === 'unavailable')
    return (
      <StatePanel
        heading="h1"
        kind="error"
        title="This task could not be loaded"
        description="Check your connection and try again."
      >
        <Button onClick={() => void read.refresh()}>Try again</Button>
      </StatePanel>
    );
  const task = read.state.data;
  if (task === 'not-found')
    return (
      <StatePanel
        heading="h1"
        kind="empty"
        title="Task not found"
        description={`There’s no task ${taskKey} in this workspace, or you can’t open it.`}
      >
        <Button nativeButton={false} render={backLink}>
          Back to Tasks
        </Button>
      </StatePanel>
    );
  return (
    <TaskLoaded
      key={task.rowId}
      workspace={workspace}
      task={task}
      back={back}
      refresh={async () => void (await read.refresh())}
    />
  );
}

function TaskLoaded({
  workspace,
  task,
  back,
  refresh,
}: {
  workspace: TableWorkspace;
  task: TaskDetail;
  back: Omit<TaskBoardSearch, 'task'>;
  refresh: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const api = useMemo(() => tableApi(workspace.id), [workspace.id]);
  const { table, canCreate, canDelete } = useTasksTable(api, task.tableId);
  const rows = useTaskRows(api, table);
  const activity = useTaskActivity(workspace.id);
  const progress = activity.state.kind === 'ready' ? activity.state.data : undefined;
  const keys = useTaskKeys(workspace.id);
  const keyOf = useMemo(() => keysByRow(keys.state.kind === 'ready' ? keys.state.data : undefined), [keys.state]);
  const record: TableDataRow = useMemo(() => ({ ...task.record, unavailableFileIds: [] }), [task.record]);
  const card = useMemo(() => taskCards([record], progress)[0]!, [record, progress]);
  const allCards = useMemo(
    () => (rows.state.kind === 'ready' ? taskCards(rows.state.data.records, progress) : []),
    [rows.state, progress],
  );
  const options = useMemo(() => taskOptions(allCards, keyOf), [allCards, keyOf]);
  const subtasks = allCards.filter(item => {
    const parent = item.record.values[taskFields.parent];
    return parent?.kind === 'relationship' && parent.recordIds.includes(task.rowId);
  });
  const { change: changed } = useFeatureChanges();
  useRefreshOnReturn(() => {
    void refresh();
    void rows.refresh();
    void activity.refresh();
    void keys.refresh();
  });
  // The polled task carries its thread; when someone comments or a run moves, reread the thread panel's own copy.
  const lastItem = task.thread.items.at(-1);
  const threadSignature = `${task.thread.items.length}:${lastItem?.id ?? ''}:${task.thread.assignment?.runState ?? ''}`;
  const threadSeen = useRef(threadSignature);
  useEffect(() => {
    if (threadSeen.current === threadSignature) return;
    threadSeen.current = threadSignature;
    void changed({ keys: [['tables', 'row-thread', workspace.id, task.tableId, task.rowId]] });
  }, [threadSignature, changed, workspace.id, task.tableId, task.rowId]);
  // Agent progress moves the row and its thread, so reread both when the activity feed sees this task change.
  const signature = card.activity ? `${card.activity.runState}:${card.activity.updatedAt}` : null;
  const seen = useRef(signature);
  useEffect(() => {
    if (seen.current === signature) return;
    seen.current = signature;
    void refresh();
    void changed({ keys: [['tables', 'row-thread', workspace.id, task.tableId, task.rowId]] });
  }, [signature, refresh, changed, workspace.id, task.tableId, task.rowId]);
  const now = useNow(card.state === 'working' || card.state === 'queued');
  const [composing, setComposing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refreshAll = async () => {
    await refresh();
    await activity.refresh();
  };
  const update = useRecordMutation(
    api,
    () => void refresh(),
    rejection => (table ? rejectionMessage(table.definition, rejection, task.record.values) : undefined),
  );
  const remove = useRecordMutation(api, () => {
    setConfirmDelete(false);
    toast.add({ title: `${task.key} deleted`, type: 'success' });
    void navigate({ to: '/$workspaceSlug/tasks', params: { workspaceSlug: workspace.slug }, search: back });
  });
  const editable = task.canEdit && table !== null && !update.locked;
  const save = (values: TableValues) => {
    if (!table) return;
    void update.submit({
      kind: 'update',
      requestId: crypto.randomUUID(),
      tableId: table.id,
      revision: table.revision,
      recordId: task.rowId,
      expectedToken: task.record.token,
      values,
    });
  };
  const copy = async () => {
    const link = `${window.location.origin}/${workspace.slug}/tasks/${task.key}`;
    try {
      await navigator.clipboard.writeText(`${task.key} ${card.title}\n${link}`);
      toast.add({ title: `Copied ${task.key} and its link`, type: 'success' });
    } catch {
      toast.add({ title: 'The link could not be copied', type: 'error' });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4" data-task-key={task.key}>
      <PageHeader
        title={task.key}
        parent={{
          label: 'Tasks',
          link: <Link to="/$workspaceSlug/tasks" params={{ workspaceSlug: workspace.slug }} search={back} />,
        }}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void copy()}>
              <CopyIcon size="sm" aria-hidden="true" />
              Copy link
            </Button>
            {canDelete && task.canEdit && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button variant="outline" size="icon-sm" aria-label="More task options" />}
                >
                  <MoreIcon size="md" aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                    Delete task
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-8 lg:flex-row">
        <div className="min-w-0 flex-1 space-y-6">
          <div className="space-y-4">
            <InlineText
              look="title"
              label="Title"
              value={card.title === 'Untitled task' ? '' : card.title}
              placeholder="Task title"
              disabled={!editable}
              required
              save={value => save({ [taskFields.title]: { kind: 'text', value } })}
            />
            <Description
              value={card.description}
              disabled={!editable}
              save={value => save({ [taskFields.description]: value ? { kind: 'text', value } : null })}
            />
            <RecordMutationFeedback mutation={update} />
          </div>
          <CodeSessionTaskSection
            workspaceId={workspace.id}
            workspaceSlug={workspace.slug}
            rowId={task.rowId}
            taskTitle={card.title}
          />
          <section aria-label="Activity" className="space-y-2 border-t pt-4">
            <h2 className="text-sm font-medium">Activity</h2>
            <RowThreadPanel
              workspaceId={workspace.id}
              tableId={task.tableId}
              rowId={task.rowId}
              changed={() => void refreshAll()}
              conversationOnly
              noun="task"
            />
          </section>
        </div>
        <aside aria-label="Properties" className="shrink-0 space-y-5 lg:w-72 lg:border-l lg:pl-5">
          <div className="space-y-0.5">
            <StatusProperty
              workspaceId={workspace.id}
              card={card}
              tableId={task.tableId}
              canEdit={task.canEdit}
              refresh={refreshAll}
            />
            <PropertyRow label="Assignee">
              <ActorMenu
                workspaceId={workspace.id}
                look="property"
                name="Assignee"
                value={card.assignee}
                disabled={!editable}
                change={actor => save({ [taskFields.assignee]: actor ? { kind: 'actor', actor } : null })}
              />
            </PropertyRow>
            <PropertyRow label="Reporter">
              <ActorMenu
                workspaceId={workspace.id}
                look="property"
                name="Reporter"
                value={card.reporter}
                disabled={!editable}
                change={actor => save({ [taskFields.reporter]: actor ? { kind: 'actor', actor } : null })}
              />
            </PropertyRow>
            <PropertyRow label="Parent">
              <ParentMenu
                look="property"
                tasks={options.filter(option => option.id !== task.rowId)}
                value={parentOf(task)}
                disabled={!editable}
                change={parent =>
                  save({
                    [taskFields.parent]: parent
                      ? { kind: 'relationship', tableId: task.tableId, recordIds: [parent] }
                      : null,
                  })
                }
              />
            </PropertyRow>
          </div>
          <Property label="Subtasks">
            <div className="space-y-1">
              {subtasks.length === 0 && <p className="text-sm text-muted-foreground">No subtasks.</p>}
              {subtasks.map(subtask => (
                <SubtaskLink key={subtask.id} workspace={workspace} card={subtask} taskKey={keyOf.get(subtask.id)} />
              ))}
              {canCreate && table && (
                <Button size="sm" variant="ghost" onClick={() => setComposing(true)}>
                  <AddIcon size="sm" aria-hidden="true" />
                  Add subtask
                </Button>
              )}
            </div>
          </Property>
          {card.assignee?.type === 'agent' && (
            <AgentWork
              card={card}
              tableId={task.tableId}
              workspace={workspace}
              me={progress?.me}
              now={now}
              refresh={refreshAll}
            />
          )}
          <Property label="Reminders">
            <TaskReminders
              workspaceId={workspace.id}
              tableId={task.tableId}
              rowId={task.rowId}
              reminders={task.reminders}
              assignee={card.assignee?.type === 'member' ? card.assignee.id : null}
              changed={refresh}
            />
          </Property>
          {table && customTaskFields(table).length > 0 && (
            <CustomFields
              table={table}
              api={api}
              workspace={workspace}
              values={task.record.values}
              disabled={!editable}
              save={save}
            />
          )}
        </aside>
      </div>
      {composing && table && (
        <TaskComposer
          workspace={workspace}
          table={table}
          api={api}
          me={progress?.me}
          tasks={options}
          parent={task.rowId}
          close={() => setComposing(false)}
        />
      )}
      <AlertDialog open={confirmDelete} onOpenChange={open => !remove.locked && setConfirmDelete(open)}>
        <AlertDialogContent>
          <AlertDialogTitle>Delete {task.key}?</AlertDialogTitle>
          <AlertDialogDescription>“{card.title}” will be removed from Tasks.</AlertDialogDescription>
          <RecordMutationFeedback mutation={remove} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.locked}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.locked || !table}
              onClick={() =>
                table &&
                void remove.submit({
                  kind: 'delete',
                  requestId: crypto.randomUUID(),
                  tableId: table.id,
                  revision: table.revision,
                  recordId: task.rowId,
                  expectedToken: task.record.token,
                })
              }
            >
              {remove.state.kind === 'sending' ? 'Deleting…' : 'Delete task'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5 border-t pt-4" aria-label={label}>
      <h2 className="text-xs font-medium text-muted-foreground">{label}</h2>
      {children}
    </section>
  );
}

/** One Linear-style property: a muted label beside a value that opens its menu. */
function PropertyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-2">
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function parentOf(task: TaskDetail): string | null {
  const value = task.record.values[taskFields.parent];
  return value?.kind === 'relationship' ? (value.recordIds[0] ?? null) : null;
}

/**
 * A title edited where it is shown; it saves when focus leaves or on Enter, and Escape puts it back.
 * A newer saved title shows when it arrives, except while the person is typing or their own save is in flight.
 */
function InlineText({
  value,
  save,
  look,
  label,
  placeholder,
  disabled,
  required = false,
}: {
  value: string;
  save: (value: string) => void;
  look: 'title' | 'body';
  label: string;
  placeholder: string;
  disabled: boolean;
  required?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  const [focused, setFocused] = useState(false);
  if (value !== shown && !focused && !disabled) {
    setShown(value);
    setDraft(value);
  }
  const commit = () => {
    setFocused(false);
    const next = draft.trim();
    if (next === value.trim()) return;
    if (required && !next) setDraft(value);
    else save(next);
  };
  return (
    <BareText
      look={look}
      aria-label={label}
      placeholder={placeholder}
      value={draft}
      readOnly={disabled}
      onChange={event => setDraft(event.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={commit}
      onKeyDown={event => {
        if (event.key === 'Enter' && look === 'title') {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === 'Escape') {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/** The Markdown description, written in place by people who can edit the task. */
function Description({ value, disabled, save }: { value: string; disabled: boolean; save: (value: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  // A newer saved description replaces the draft only while the person isn't writing one.
  if (value !== shown && !editing && !disabled) {
    setShown(value);
    setDraft(value);
  }
  if (editing)
    return (
      <div className="space-y-2 rounded-md border p-3">
        <BareText
          autoFocus
          aria-label="Description"
          placeholder="Add description…"
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setDraft(value);
              setEditing(false);
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              setEditing(false);
              if (draft.trim() !== value.trim()) save(draft.trim());
            }
          }}
        />
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(value);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setEditing(false);
              if (draft.trim() !== value.trim()) save(draft.trim());
            }}
          >
            Save
          </Button>
        </div>
      </div>
    );
  return (
    <div className="space-y-2" data-compact-text>
      {value ? (
        <MessageResponse>{value}</MessageResponse>
      ) : (
        <p className="text-sm text-muted-foreground">No description.</p>
      )}
      {!disabled && (
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          {value ? 'Edit description' : 'Add description'}
        </Button>
      )}
    </div>
  );
}

function StatusProperty({
  workspaceId,
  card,
  tableId,
  canEdit,
  refresh,
}: {
  workspaceId: string;
  card: TaskCard;
  tableId: string;
  canEdit: boolean;
  refresh: () => Promise<void>;
}) {
  const [moving, setMoving] = useState(false);
  const move: TaskMove | null = taskMove(card, 'done') ?? (taskMove(card, 'todo') ? 'reopen' : null);
  const act = async (next: TaskMove) => {
    setMoving(true);
    const failure = await applyTaskMove(workspaceId, tableId, card, next);
    if (failure) toast.add({ title: failure, type: 'error' });
    await refresh().catch(() => undefined);
    setMoving(false);
  };
  const current = card.state ? stateLabels[card.state] : 'To do';
  const icon = (state: StatusState) => <Status state={state} size="sm" aria-hidden="true" tooltip={false} />;
  const choices: MenuChoice[] =
    move === 'reopen'
      ? [
          { value: 'reopen', label: 'To do', icon: icon('pending') },
          { value: '', label: current, icon: icon(cardStatus(card)) },
        ]
      : [
          { value: '', label: current, icon: icon(cardStatus(card)) },
          ...(move ? [{ value: move, label: 'Done', icon: icon('success') }] : []),
        ];
  return (
    <PropertyRow label="Status">
      <ChipMenu
        look="property"
        name="Status"
        icon={icon(cardStatus(card))}
        text={current}
        placeholder={false}
        disabled={!canEdit || !move || moving}
        searchable={false}
        choices={choices}
        value=""
        pick={next => {
          if (next === 'done' || next === 'reopen') void act(next);
        }}
      />
    </PropertyRow>
  );
}

function SubtaskLink({
  workspace,
  card,
  taskKey,
}: {
  workspace: TableWorkspace;
  card: TaskCard;
  taskKey: string | undefined;
}) {
  const content = (
    <>
      <Status state={cardStatus(card)} size="sm" aria-hidden="true" tooltip={false} />
      {taskKey && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{taskKey}</span>}
      <span className="min-w-0 flex-1 truncate">{card.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{card.state ? stateLabels[card.state] : 'To do'}</span>
    </>
  );
  return taskKey ? (
    <div className="grid">
      <Button
        variant="ghost"
        size="sm"
        nativeButton={false}
        render={<Link to="/$workspaceSlug/tasks/$key" params={{ workspaceSlug: workspace.slug, key: taskKey }} />}
      >
        <span className="flex w-full min-w-0 items-center gap-2 text-left">{content}</span>
      </Button>
    </div>
  ) : (
    <div className="flex items-center gap-2 px-1.5 py-1 text-sm">{content}</div>
  );
}

/** The workspace's own task fields, saved together. */
function CustomFields({
  table,
  api,
  workspace,
  values,
  disabled,
  save,
}: {
  table: TableDefinition;
  api: TableApi;
  workspace: TableWorkspace;
  values: TableValues;
  disabled: boolean;
  save: (values: TableValues) => void;
}) {
  const fields = customTaskFields(table);
  const [draft, setDraft] = useState<TableValues>(values);
  const [base, setBase] = useState<TableValues>(values);
  const [validated, setValidated] = useState(false);
  const changes = changedValues(draft, base);
  const dirty = Object.keys(changes).length > 0;
  // Newer saved values replace the fields while nothing here is being changed, or once they include the change.
  if (values !== base && (!dirty || Object.keys(changedValues(draft, values)).length === 0)) {
    setBase(values);
    setDraft(values);
  }
  const errors = validated ? validateRowDraft(table.definition, draft, base, 'tasks') : {};
  return (
    <section className="space-y-3 border-t pt-4" aria-label="Fields">
      <h2 className="text-xs font-medium text-muted-foreground">Fields</h2>
      {fields.map(field => (
        <FieldInput
          key={field.id}
          field={field}
          value={draft[field.id]}
          error={errors[field.id]}
          disabled={disabled}
          change={value => setDraft(current => ({ ...current, [field.id]: value }))}
          api={api}
          workspace={workspace}
          unavailableFileIds={[]}
          singleLine
          hideHelper
        />
      ))}
      {dirty && !disabled && (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setDraft(base)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setValidated(true);
              if (Object.keys(validateRowDraft(table.definition, draft, base, 'tasks')).length) return;
              save(changes);
            }}
          >
            Save fields
          </Button>
        </div>
      )}
    </section>
  );
}
