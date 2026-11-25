import { useState, type KeyboardEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { taskFields } from '@tulipfarm/tables/tasks-table';
import { AlarmClockIcon, ChevronRightIcon, CloseIcon, MaximizeIcon, MinimizeIcon, MoreIcon } from '@tulipfarm/icons';
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
import { Dialog, DialogTitle } from '@tulipfarm/sprout/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@tulipfarm/sprout/popover';
import { toast } from '@tulipfarm/sprout/toast';
import { BareText } from '@/components/ui/bare-text';
import { Chip } from '@/components/ui/chip';
import { CompactButton, ComposerDialogContent, InlineSwitch, KeyTag } from '@/components/ui/composer-dialog';
import { useFeatureChanges } from '@/lib/query';
import type { TableApi, TableDefinition } from '@/features/tables/api';
import type { Actor } from '@/features/tables/actors';
import { FieldInput } from '@/features/tables/field-input';
import { RecordMutationFeedback, useRecordMutation } from '@/features/tables/record-mutation';
import { rejectionMessage, validateRowDraft } from '@/features/tables/record-validation';
import type { TableWorkspace } from '@/features/tables/references';
import type { TableField, TableValue, TableValues } from '@/features/tables/review-contracts';
import { rowThreadApi } from '@/features/tables/row-thread';
import {
  draftSchedule,
  draftText,
  reminderFailure,
  scheduleDraft,
  ScheduleFields,
  type ScheduleDraft,
} from './reminders';
import { browserTimeZone, readTaskKeys, reminderApi, taskKeysKey } from './task-api';
import { ActorMenu, ChipMenu, ParentMenu, statusIcon } from './task-chips';
import type { TaskOption } from './task-data';

const lockedFields = new Set<string>(Object.values(taskFields));

/** The fields people add to Tasks beyond the six built-in ones. */
export const customTaskFields = (table: TableDefinition) =>
  table.definition.fields.filter(field => !lockedFields.has(field.id));

const text = (value: string): TableValue => (value.trim() ? { kind: 'text', value: value.trim() } : null);

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

/** A centered dialog for writing a new task, with its people, parent, reminder and custom fields as chips. */
export function TaskComposer({
  workspace,
  table,
  api,
  me,
  tasks,
  parent: initialParent = null,
  close,
}: {
  workspace: TableWorkspace;
  table: TableDefinition;
  api: TableApi;
  /** The creator's membership ID, the Reporter by default. */
  me: string | undefined;
  tasks: readonly TaskOption[];
  parent?: string | null;
  close: () => void;
}) {
  const navigate = useNavigate();
  const { change: changed } = useFeatureChanges();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [done, setDone] = useState(false);
  const [assignee, setAssignee] = useState<Actor | null>(null);
  const [reporter, setReporter] = useState<Actor | null>(me ? { type: 'member', id: me } : null);
  const [parent, setParent] = useState<string | null>(initialParent);
  const [reminder, setReminder] = useState<ScheduleDraft>(scheduleDraft);
  const [reminding, setReminding] = useState(false);
  const [custom, setCustom] = useState<TableValues>({});
  const [createMore, setCreateMore] = useState(false);
  const [reminderOpen, setReminderOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [validated, setValidated] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [recordId, setRecordId] = useState(() => crypto.randomUUID());
  const fields = customTaskFields(table);
  const values: TableValues = {
    ...custom,
    [taskFields.title]: text(title),
    [taskFields.description]: text(description),
    [taskFields.assignee]: assignee ? { kind: 'actor', actor: assignee } : null,
    [taskFields.reporter]: reporter ? { kind: 'actor', actor: reporter } : null,
    [taskFields.parent]: parent ? { kind: 'relationship', tableId: table.id, recordIds: [parent] } : null,
  };
  const create = useRecordMutation(
    api,
    () => undefined,
    rejection => rejectionMessage(table.definition, rejection, values),
  );
  const busy = create.locked || finishing;
  const dirty = title.trim() !== '' || description.trim() !== '';
  const errors = validated ? validateRowDraft(table.definition, values, undefined, 'tasks') : {};
  const reminderFor = assignee?.type === 'member' ? assignee.id : null;
  const reminderSchedule = reminding && reminderFor ? draftSchedule(reminder) : null;

  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmClose(true);
    else close();
  };

  const openTask = (key: string) =>
    void navigate({ to: '/$workspaceSlug/tasks/$key', params: { workspaceSlug: workspace.slug, key } });

  /** Everything the task needs after its row exists: its key, its reminder and, when chosen, Done. */
  const finish = async (id: string) => {
    const problems: string[] = [];
    if (reminderFor && reminderSchedule)
      await reminderApi(workspace.id, table.id, id)
        .create({ membershipId: reminderFor, schedule: reminderSchedule, timeZone: browserTimeZone() })
        .catch((failure: unknown) => problems.push(`The reminder wasn’t set: ${reminderFailure(failure)}`));
    if (done)
      await rowThreadApi(workspace.id, table.id, id)
        .markDone()
        .catch(() => problems.push('It couldn’t be marked done. Mark it done from the task.'));
    const key = await readTaskKeys(workspace.id, AbortSignal.timeout(15_000))
      .then(keys => keys.keys.find(item => item.rowId === id)?.key ?? null)
      .catch(() => null);
    await changed({ keys: [taskKeysKey(workspace.id)] });
    toast.add({
      title: key ? `${key} created` : 'Task created',
      description: problems.join(' ') || undefined,
      type: problems.length ? 'warning' : 'success',
      ...(key ? { actionProps: { children: 'Open task', onClick: () => openTask(key) } } : {}),
    });
  };

  const submit = async () => {
    if (busy) return;
    setValidated(true);
    if (Object.keys(validateRowDraft(table.definition, values, undefined, 'tasks')).length) return;
    const id = recordId;
    const saved = await create.submit({
      kind: 'create',
      requestId: crypto.randomUUID(),
      tableId: table.id,
      revision: table.revision,
      recordId: id,
      values: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null)),
    });
    if (!saved) return;
    setFinishing(true);
    try {
      await finish(id);
    } finally {
      setFinishing(false);
    }
    if (!createMore) {
      close();
      return;
    }
    setTitle('');
    setDescription('');
    setValidated(false);
    setRecordId(crypto.randomUUID());
  };

  const shortcut = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  const required = fields.filter(field => field.required);
  const optional = fields.filter(field => !field.required);
  const errorList = Object.entries(errors).filter(([fieldId]) => fieldId !== taskFields.title);
  const fieldInput = (field: TableField) => (
    <FieldInput
      key={field.id}
      field={field}
      value={custom[field.id]}
      error={errors[field.id]}
      disabled={busy}
      change={value => setCustom(current => ({ ...current, [field.id]: value }))}
      api={api}
      workspace={workspace}
      unavailableFileIds={[]}
    />
  );

  const reminderText = reminderFor && reminding ? draftText(reminder) : 'Reminder';
  return (
    <Dialog open onOpenChange={open => !open && requestClose()}>
      <ComposerDialogContent expanded={expanded} aria-describedby={undefined}>
        <div className="flex min-h-0 flex-col" onKeyDown={shortcut}>
          <div className="flex items-center gap-1.5 py-2.5 pr-2.5 pl-4 text-sm">
            <KeyTag>TUL</KeyTag>
            <ChevronRightIcon size="xs" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <DialogTitle render={<h2 className="text-sm font-normal text-foreground" />}>New task</DialogTitle>
            </div>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={expanded ? 'Make smaller' : 'Make larger'}
              aria-pressed={expanded}
              onClick={() => setExpanded(value => !value)}
            >
              {expanded ? <MinimizeIcon size="xs" aria-hidden="true" /> : <MaximizeIcon size="xs" aria-hidden="true" />}
            </Button>
            <Button size="icon-xs" variant="ghost" aria-label="Close" disabled={busy} onClick={requestClose}>
              <CloseIcon size="xs" aria-hidden="true" />
            </Button>
          </div>
          <div className={`min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pt-1 pb-3 ${expanded ? 'min-h-80' : ''}`}>
            <BareText
              look="title"
              autoFocus
              placeholder="Task title"
              aria-label="Task title"
              aria-invalid={Boolean(errors[taskFields.title])}
              value={title}
              disabled={busy}
              onChange={event => setTitle(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) event.preventDefault();
              }}
            />
            {errors[taskFields.title] && (
              <p role="alert" className="text-xs text-destructive">
                Write a title for the task.
              </p>
            )}
            <BareText
              placeholder="Add description…"
              aria-label="Description"
              value={description}
              disabled={busy}
              onChange={event => setDescription(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
            <ChipMenu
              look="chip"
              name="Status"
              icon={statusIcon(done ? 'success' : 'pending')}
              text={done ? 'Done' : 'Todo'}
              placeholder={false}
              disabled={busy}
              searchable={false}
              choices={[
                { value: 'todo', label: 'Todo', icon: statusIcon('pending') },
                { value: 'done', label: 'Done', icon: statusIcon('success') },
              ]}
              value={done ? 'done' : 'todo'}
              pick={next => setDone(next === 'done')}
            />
            <ActorMenu
              workspaceId={workspace.id}
              look="chip"
              name="Assignee"
              value={assignee}
              change={setAssignee}
              disabled={busy}
            />
            <ActorMenu
              workspaceId={workspace.id}
              look="chip"
              name="Reporter"
              value={reporter}
              change={setReporter}
              disabled={busy}
            />
            <ParentMenu look="chip" tasks={tasks} value={parent} change={setParent} disabled={busy} />
            <Popover open={reminderOpen} onOpenChange={setReminderOpen}>
              <PopoverTrigger
                render={
                  <Chip
                    icon={<AlarmClockIcon size="sm" aria-hidden="true" />}
                    placeholder={!(reminderFor && reminding)}
                    disabled={busy}
                    title="Reminder"
                    aria-label={`Reminder: ${reminderText}`}
                  />
                }
              >
                {reminderText}
              </PopoverTrigger>
              <PopoverContent size="picker" align="start" sideOffset={4}>
                {reminderFor ? (
                  <div className="space-y-3 p-3">
                    <p className="text-sm font-medium">Remind the assignee</p>
                    <ScheduleFields draft={reminder} change={setReminder} disabled={busy} />
                    <div className="flex justify-end gap-2">
                      {reminding && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setReminding(false);
                            setReminderOpen(false);
                          }}
                        >
                          Remove
                        </Button>
                      )}
                      <Button
                        size="sm"
                        disabled={!draftSchedule(reminder)}
                        onClick={() => {
                          setReminding(true);
                          setReminderOpen(false);
                        }}
                      >
                        {reminding ? 'Update reminder' : 'Set reminder'}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="p-3 text-sm text-muted-foreground">
                    Reminders go to the assignee. Assign the task to a person first.
                  </p>
                )}
              </PopoverContent>
            </Popover>
            {required.map(field => (
              <Popover key={field.id}>
                <PopoverTrigger
                  render={
                    <Chip
                      placeholder={!custom[field.id]}
                      disabled={busy}
                      aria-invalid={Boolean(errors[field.id])}
                      title={field.label}
                    />
                  }
                >
                  {field.label}
                </PopoverTrigger>
                <PopoverContent size="picker" align="start" sideOffset={4}>
                  <div className="p-3">{fieldInput(field)}</div>
                </PopoverContent>
              </Popover>
            ))}
            <Popover>
              <PopoverTrigger render={<Chip square aria-label="More fields" title="More fields" disabled={busy} />}>
                <MoreIcon size="sm" aria-hidden="true" />
              </PopoverTrigger>
              <PopoverContent size="picker" align="start" sideOffset={4}>
                {optional.length === 0 ? (
                  <p className="p-3 text-sm text-muted-foreground">
                    This workspace has no other task fields. Add them from Fields on the Tasks page.
                  </p>
                ) : (
                  <div className="space-y-3 p-3">{optional.map(fieldInput)}</div>
                )}
              </PopoverContent>
            </Popover>
          </div>
          {(errorList.length > 0 || create.state.kind === 'rejected' || create.state.kind === 'uncertain') && (
            <div className="space-y-2 px-4 pb-3">
              {errorList.map(([fieldId, message]) => (
                <p key={fieldId} role="alert" className="text-xs text-destructive">
                  {fields.find(field => field.id === fieldId)?.label ?? 'Field'}: {message}
                </p>
              ))}
              <RecordMutationFeedback mutation={create} />
            </div>
          )}
          <div className="flex items-center justify-end gap-3 border-t px-4 py-2.5">
            <InlineSwitch label="Create more" checked={createMore} change={setCreateMore} disabled={busy} />
            <CompactButton
              disabled={busy}
              title={`Create task (${isMac ? '⌘' : 'Ctrl'}+Enter)`}
              onClick={() => void submit()}
            >
              {create.state.kind === 'sending' || finishing ? 'Creating…' : 'Create task'}
            </CompactButton>
          </div>
        </div>
        <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
          <AlertDialogContent>
            <AlertDialogTitle>Discard this task?</AlertDialogTitle>
            <AlertDialogDescription>The title and description you wrote will be lost.</AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep writing</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={close}>
                Discard
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </ComposerDialogContent>
    </Dialog>
  );
}
