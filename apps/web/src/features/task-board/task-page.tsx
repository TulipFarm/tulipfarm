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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Status } from '@tulipfarm/sprout/status';
import { toast } from '@tulipfarm/sprout/toast';
import { BareText } from '@/components/ui/bare-text';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import { tableApi, type TableApi, type TableDataRow, type TableDefinition } from '@/features/tables/api';
import { ActorPicker, type Actor } from '@/features/tables/actors';
import { FieldInput } from '@/features/tables/field-input';
import { RecordMutationFeedback, useRecordMutation } from '@/features/tables/record-mutation';
import { changedValues, rejectionMessage, validateRowDraft } from '@/features/tables/record-validation';
import type { TableWorkspace } from '@/features/tables/references';
import type { TableValues } from '@/features/tables/review-contracts';
import { RowThreadPanel } from '@/features/tables/row-thread';
import { taskCards, type TaskCard } from './api';
import { AgentWork, stateLabels } from './agent-work';
import { useNow } from './live';
import { applyTaskMove, taskMove, type TaskMove } from './moves';
import { TaskReminders } from './reminders';
import type { TaskBoardSearch } from './search';
import { readTask, taskDetailKey, useTaskKeys, type TaskDetail } from './task-api';
import { cardStatus } from './task-board';
import { customTaskFields, TaskComposer } from './task-composer';
import {
  keysByRow,
  optionLabel,
  taskOptions,
  useTaskActivity,
  useTaskRows,
  useTasksTable,
  type TaskOption,
} from './task-data';

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
              key={card.title}
              look="title"
              label="Title"
              value={card.title === 'Untitled task' ? '' : card.title}
              placeholder="Task title"
              disabled={!editable}
              required
              save={value => save({ [taskFields.title]: { kind: 'text', value } })}
            />
            <Description
              key={card.description}
              value={card.description}
              disabled={!editable}
              save={value => save({ [taskFields.description]: value ? { kind: 'text', value } : null })}
            />
            <RecordMutationFeedback mutation={update} />
          </div>
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
        <aside aria-label="Properties" className="shrink-0 space-y-5 lg:w-80 lg:border-l lg:pl-6">
          <StatusProperty
            workspaceId={workspace.id}
            card={card}
            tableId={task.tableId}
            canEdit={task.canEdit}
            refresh={refreshAll}
          />
          <Property label="Assignee">
            <ActorPicker
              workspaceId={workspace.id}
              value={card.assignee}
              disabled={!editable}
              change={(actor: Actor | null) => save({ [taskFields.assignee]: actor ? { kind: 'actor', actor } : null })}
              label="Assignee"
              size="sm"
            />
          </Property>
          <Property label="Reporter">
            <ActorPicker
              workspaceId={workspace.id}
              value={card.reporter}
              disabled={!editable}
              change={(actor: Actor | null) => save({ [taskFields.reporter]: actor ? { kind: 'actor', actor } : null })}
              label="Reporter"
              size="sm"
            />
          </Property>
          <Property label="Parent task">
            <ParentPicker
              task={task}
              options={options.filter(option => option.id !== task.rowId)}
              disabled={!editable}
              change={parent =>
                save({
                  [taskFields.parent]: parent
                    ? { kind: 'relationship', tableId: task.tableId, recordIds: [parent] }
                    : null,
                })
              }
            />
          </Property>
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
              key={task.record.token}
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
    <section className="space-y-1.5" aria-label={label}>
      <h2 className="text-xs font-medium text-muted-foreground">{label}</h2>
      {children}
    </section>
  );
}

/** A title edited where it is shown; it saves when focus leaves or on Enter, and Escape puts it back. */
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
  const commit = () => {
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
  return (
    <Property label="Status">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Status state={cardStatus(card)} size="sm" aria-hidden="true" tooltip={false} />
        <span className="flex-1">{card.state ? stateLabels[card.state] : 'To do'}</span>
        {canEdit && move && (
          <Button size="sm" variant="outline" disabled={moving} onClick={() => void act(move)}>
            {move === 'done' ? 'Mark done' : 'Reopen'}
          </Button>
        )}
      </div>
    </Property>
  );
}

function ParentPicker({
  task,
  options,
  disabled,
  change,
}: {
  task: TaskDetail;
  options: readonly TaskOption[];
  disabled: boolean;
  change: (parent: string | null) => void;
}) {
  const value = task.record.values[taskFields.parent];
  const parent = value?.kind === 'relationship' ? (value.recordIds[0] ?? null) : null;
  const chosen = options.find(option => option.id === parent);
  return (
    <Select value={parent ?? ''} disabled={disabled} onValueChange={next => change(next || null)}>
      <SelectTrigger width="full" size="sm" aria-label="Parent task">
        <SelectValue>{chosen ? optionLabel(chosen) : parent ? 'Older task' : 'No parent task'}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="">No parent task</SelectItem>
        {options.map(option => (
          <SelectItem key={option.id} value={option.id}>
            {optionLabel(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
  const [validated, setValidated] = useState(false);
  const changes = changedValues(draft, values);
  const dirty = Object.keys(changes).length > 0;
  const errors = validated ? validateRowDraft(table.definition, draft, values, 'tasks') : {};
  return (
    <section className="space-y-3" aria-label="Fields">
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
          <Button size="sm" variant="ghost" onClick={() => setDraft(values)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setValidated(true);
              if (Object.keys(validateRowDraft(table.definition, draft, values, 'tasks')).length) return;
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
