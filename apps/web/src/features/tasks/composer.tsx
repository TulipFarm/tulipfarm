import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button, type ButtonState, type ButtonBlockerFix } from '@tulipfarm/sprout/button';
import { FileTypeIcon } from '@tulipfarm/sprout/attachment';
import { ChoiceGroup, Field } from '@tulipfarm/sprout/field';
import { Form, FormSection } from '@tulipfarm/sprout/form';
import { Input } from '@tulipfarm/sprout/input';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Disclosure } from '@/components/disclosure';
import { useTaskApi, useTaskSources, useTaskSourceChats, useTaskSourceFiles, taskKeys } from './queries';
import { ReferenceName } from '@/components/reference-name';
import { useTableWrite } from '@/features/tables/use-table-write';
import { UnsavedChanges, WriteFeedback } from '@/features/tables/feedback';
import { AgentRead } from '@/features/agents/feedback';
import { activationLabel, scopeText } from '@/features/agents/labels';
import { tableApi } from '@/features/tables/api';
import { useTableNames } from '@/features/tables/hooks';
import type { AgentDetail } from '@/features/agents/api';
import { conversationApi } from '@/features/chat/conversation-api';
import { taskApi, type TaskCommand, type TaskSources, type TaskSummary } from './api';
import { defaultTaskLimits, limitDraft, limitRange, parseLimits, taskLimitFields } from './limits';
import { McpPrivateContext, type McpSelectionState } from '@/features/workspace-mcp/selection';
import { readDraftFiles, referenceKey, writeDraftFiles, type FileReference } from '@/features/chat/draft-files';
import { useFeatureRead, useFeatureScope } from '@/lib/query';

export function TaskStart({
  workspaceId,
  slug,
  detail,
  concealed,
  setup,
}: {
  workspaceId: string;
  slug: string;
  detail: AgentDetail;
  concealed: boolean;
  setup?: ButtonBlockerFix | undefined;
}) {
  const api = useTaskApi(workspaceId);
  const navigate = useNavigate();
  const [acceptedId, setAcceptedId] = useState<string>();
  useEffect(() => {
    if (acceptedId)
      void navigate({ to: '/$workspaceSlug/agent-tasks/$taskId', params: { workspaceSlug: slug, taskId: acceptedId } });
  }, [acceptedId, navigate, slug]);
  return (
    <div hidden={concealed}>
      <FormSection
        title="Run agent now"
        label="Run agent now"
        description="Tell the agent what to do to start a private task. The agent works in steps and asks before it changes rows."
      >
        <TaskComposer
          key={detail.id}
          api={api}
          workspaceId={workspaceId}
          enabled={!concealed && !!detail.activations.length}
          mode={{ kind: 'start', detail, setup }}
          accepted={setAcceptedId}
        />
      </FormSection>
    </div>
  );
}

type Mode =
  | { kind: 'start'; detail: AgentDetail; setup?: ButtonBlockerFix | undefined }
  | { kind: 'reply'; task: TaskSummary; sequence: number };
type ContextSource = Extract<TaskSources[number], { kind: 'task' | 'attachment' }>;

export function TaskComposer({
  api,
  workspaceId,
  enabled,
  mode,
  accepted,
  concealed = false,
}: {
  api: ReturnType<typeof taskApi>;
  workspaceId: string;
  enabled: boolean;
  mode: Mode;
  accepted: (id: string) => void;
  concealed?: boolean;
}) {
  const [mcpDraftId] = useState(() => crypto.randomUUID());
  const [mcp, setMcp] = useState<McpSelectionState>({ kind: 'none' });
  const [text, setText] = useState('');
  const [sources, setSources] = useState<ContextSource[]>([]);
  const files = useTaskDraftFiles(mode.kind === 'reply' ? mode.task.id : null);
  const [activationId, setActivationId] = useState('latest');
  const [scopeKey, setScopeKey] = useState('');
  const activations = mode.kind === 'start' ? mode.detail.activations : [];
  const tables = useMemo(() => tableApi(workspaceId), [workspaceId]);
  const tableNames = useTableNames(
    tables,
    activations.some(item => item.scope.length > 0),
  );
  const activation = activations.find(item => item.id === activationId);
  const scopes = new Map(
    activations.map(item => {
      const scope = item.scope
        .map(entry => ({ assetId: entry.assetId, permissions: [...entry.permissions].sort() }))
        .sort((a, b) => a.assetId.localeCompare(b.assetId));
      return [JSON.stringify(scope), scope];
    }),
  );
  const choosingScope = activationId === 'latest' && scopes.size > 1;
  const scope =
    activationId === 'latest'
      ? scopes.size === 1
        ? scopes.values().next().value
        : scopes.get(scopeKey)
      : activation?.scope;
  const [limits, setLimits] = useState(() => limitDraft(mode.kind === 'start' ? defaultTaskLimits : mode.task.limits));
  const [savedLimits, setSavedLimits] = useState(limits);
  const [limitsOpen, setLimitsOpen] = useState<boolean>();
  const [showErrors, setShowErrors] = useState(false);
  const write = useTableWrite(
    (command: TaskCommand) => api.command(command),
    receipt => {
      setText('');
      setSources([]);
      files.clear();
      setSavedLimits(limits);
      setActivationId('latest');
      setScopeKey('');
      accepted(receipt.id);
    },
  );
  const busy = write.state.kind === 'sending' || write.state.kind === 'uncertain';
  const dirty =
    !!text ||
    sources.length > 0 ||
    files.items.length > 0 ||
    activationId !== 'latest' ||
    !!scopeKey ||
    JSON.stringify(limits) !== JSON.stringify(savedLimits) ||
    busy;
  const paused = mode.kind === 'reply' && ['paused', 'failed'].includes(mode.task.status);
  const label =
    mode.kind === 'start'
      ? 'Start task'
      : mode.task.status === 'completed'
        ? 'Send follow-up'
        : paused
          ? 'Continue task'
          : 'Send answer';
  const parsedLimits = mode.kind === 'start' || paused ? parseLimits(limits, mode) : null;
  const invalidLimits = parsedLimits && !parsedLimits.ok ? parsedLimits.errors : {};
  const messageError =
    showErrors && !text.trim()
      ? mode.kind === 'start'
        ? 'Write what the agent should do.'
        : 'Write your message.'
      : undefined;
  function submitState(): ButtonState {
    if (write.state.kind === 'sending') return { kind: 'busy' };
    if (write.state.kind === 'uncertain')
      return { kind: 'blocked', reason: 'Check whether your last request went through first.' };
    if (!enabled)
      return mode.kind === 'start'
        ? {
            kind: 'blocked',
            reason: 'An agent manager must activate this agent before you can start a task.',
            fix: mode.setup,
          }
        : { kind: 'blocked', reason: 'The latest task history must load first.' };
    if (mode.kind === 'reply') return { kind: 'ready' };
    if (mcp.kind === 'unresolved')
      return { kind: 'blocked', reason: 'Save your MCP integration selection, or check it again, before starting.' };
    if (scope) return { kind: 'ready' };
    return choosingScope
      ? {
          kind: 'blocked',
          reason: 'Choose a task data scope first.',
          fix: { kind: 'jump', label: 'Go to Task data scope', target: 'task-scope' },
        }
      : {
          kind: 'blocked',
          reason: 'Choose activated instructions first.',
          fix: { kind: 'jump', label: 'Go to Activated instructions', target: 'task-activation' },
        };
  }
  const action = submitState();
  function submit() {
    if (action.kind !== 'ready') return;
    const limitsInvalid = Object.keys(invalidLimits).length > 0;
    if (!text.trim() || limitsInvalid) {
      setShowErrors(true);
      if (limitsInvalid) setLimitsOpen(true);
      return 'invalid' as const;
    }
    setShowErrors(false);
    const common = {
      requestId: crypto.randomUUID(),
      text,
      sources: [
        ...sources,
        ...files.items.map(file => ({
          kind: file.source === 'google' ? ('drive-file' as const) : ('file' as const),
          fileId: file.id,
        })),
      ],
    };
    if (mode.kind === 'start') {
      if (scope && parsedLimits?.ok)
        void write.submit({
          kind: 'start',
          input: {
            ...common,
            agentId: mode.detail.id,
            ...(activation ? { activationId: activation.id } : {}),
            scope,
            limits: parsedLimits.limits,
            ...(mcp.kind === 'selected' ? { mcpSelection: mcp.receipt } : {}),
          },
        });
    } else if (mode.task.status === 'completed')
      void write.submit({
        kind: 'reopen',
        id: mode.task.id,
        input: { ...common, expectedGeneration: mode.task.generation },
      });
    else
      void write.submit({
        kind: 'continue',
        id: mode.task.id,
        input: {
          ...common,
          expectedGeneration: mode.task.generation,
          expectedSequence: mode.sequence,
          ...(paused && parsedLimits?.ok ? { limits: parsedLimits.limits } : {}),
        },
      });
  }
  if (concealed) return <UnsavedChanges dirty={dirty} />;
  if (mode.kind === 'reply' && !['waiting-clarification', 'paused', 'failed', 'completed'].includes(mode.task.status))
    return (
      <>
        <UnsavedChanges dirty={dirty} />
        <WriteFeedback
          state={write.state}
          retry={command => void write.submit(command)}
          checkStatus={() => accepted(mode.task.id)}
        />
      </>
    );
  return (
    <Form label="Task message" disabled={!enabled || busy} onSubmit={submit}>
      <div className="grid gap-5">
        <UnsavedChanges dirty={dirty} />
        {mode.kind === 'start' && (
          <div className="grid gap-4">
            <Field
              id="task-activation"
              label="Activated instructions"
              required
              helper={
                activationId === 'latest'
                  ? 'Uses the newest active version when the task starts.'
                  : 'This task keeps the selected version even if a newer one is activated.'
              }
            >
              <Select value={activationId} onValueChange={value => setActivationId(value ?? 'latest')}>
                <SelectTrigger>
                  <SelectValue>
                    {activationId === 'latest'
                      ? 'Latest eligible activation'
                      : activation
                        ? `Pin ${activationLabel(mode.detail, activation)}`
                        : 'Choose an available activation'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="latest">Latest eligible activation</SelectItem>
                  {activations.map(item => (
                    <SelectItem key={item.id} value={item.id}>
                      Pin {activationLabel(mode.detail, item)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {choosingScope && (
              <Field
                id="task-scope"
                label="Task data scope"
                required
                helper="These versions use different data. Choose one for this task."
              >
                <Select value={scopeKey} onValueChange={value => setScopeKey(value ?? '')}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a task data scope">
                      {scopeKey && scopes.has(scopeKey) ? scopeText(scopes.get(scopeKey)!, tableNames) : undefined}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {[...scopes].map(([key, value]) => (
                      <SelectItem key={key} value={key}>
                        {scopeText(value, tableNames)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            {scope && (
              <p className="break-words text-sm text-muted-foreground">
                Data this task may use: {scopeText(scope, tableNames)}.
              </p>
            )}
          </div>
        )}
        <Field
          id="task-message"
          label={
            mode.kind === 'start'
              ? 'What should this agent do?'
              : mode.task.status === 'completed'
                ? 'Follow up on this task'
                : 'Your answer or continuation'
          }
          required
          error={messageError}
        >
          <Textarea value={text} onChange={event => setText(event.target.value)} maxLength={8000} />
        </Field>
        {files.items.length > 0 && <TaskFiles files={files.items} disabled={!enabled || busy} remove={files.remove} />}
        <TaskContext
          workspaceId={workspaceId}
          api={api}
          disabled={!enabled || busy}
          sources={sources}
          setSources={setSources}
          exclude={mode.kind === 'reply' ? mode.task.id : undefined}
          room={20 - files.items.length}
        />
        {mode.kind === 'start' && (
          <McpPrivateContext
            key={activationId}
            workspaceId={workspaceId}
            origin={{ kind: 'task-draft', id: mcpDraftId, agentId: mode.detail.id, activationId: activation?.id }}
            disabled={!enabled || busy}
            onSelection={setMcp}
          />
        )}
        {(mode.kind === 'start' || paused) && (
          <Disclosure title="Task limits" open={limitsOpen ?? paused} onOpenChange={setLimitsOpen}>
            <p className="text-sm text-muted-foreground">Limits add up across the task and never reset.</p>
            <div className="grid gap-4 sm:grid-cols-3">
              {taskLimitFields.map(field => {
                const range = limitRange(field, mode);
                return (
                  <Field
                    key={field.key}
                    id={`task-${field.key}`}
                    label={field.label}
                    required
                    error={showErrors ? invalidLimits[field.key] : undefined}
                  >
                    <Input
                      type="number"
                      min={range.min}
                      max={range.max}
                      value={limits[field.key]}
                      onChange={event => setLimits(previous => ({ ...previous, [field.key]: event.target.value }))}
                    />
                  </Field>
                );
              })}
            </div>
          </Disclosure>
        )}
        <Button type="submit" state={action} pendingLabel="Sending…">
          {label}
        </Button>
        {mode.kind === 'start' && (write.state.kind === 'uncertain' || write.state.kind === 'rejected') ? (
          <div className="grid justify-items-start gap-2">
            <Alert variant="destructive">
              <AlertDescription>{write.state.message}</AlertDescription>
            </Alert>
            {write.state.kind === 'uncertain' && (
              <Button
                variant="outline"
                onClick={() => {
                  if (write.state.kind === 'uncertain') void write.submit(write.state.input);
                }}
              >
                Retry same operation
              </Button>
            )}
          </div>
        ) : (
          <WriteFeedback
            state={write.state}
            retry={command => void write.submit(command)}
            checkStatus={() => {
              if (mode.kind === 'reply') accepted(mode.task.id);
            }}
          />
        )}
        {mode.kind === 'reply' && mode.task.status === 'completed' && (
          <p className="text-sm text-muted-foreground">
            This reopens the same private task with its starting instructions, skills, files and total cost.
          </p>
        )}
      </div>
    </Form>
  );
}

const readableTypes = ['text/plain', 'text/csv', 'text/markdown', 'application/json'];
const changedValue = (previous: readonly string[], next: readonly string[]) =>
  next.find(id => !previous.includes(id)) ?? previous.find(id => !next.includes(id));

/**
 * Files placed by Use in chat wait in this tab's draft storage under `task:<id>` until the message that carries them is sent,
 * so leaving the task page keeps them. A Google Drive file sends only its id: the server binds it to your current Google integration.
 */
function useTaskDraftFiles(taskId: string | null) {
  const scope = useFeatureScope();
  const draft =
    scope.kind === 'workspace' && taskId
      ? { owner: { workspaceId: scope.workspaceId, membershipId: scope.membershipId }, target: `task:${taskId}` }
      : null;
  const [items, setItems] = useState<FileReference[]>(() => (draft ? readDraftFiles(draft.owner, draft.target) : []));
  const save = (next: FileReference[]) => {
    setItems(next);
    if (draft) writeDraftFiles(draft.owner, draft.target, next);
  };
  return {
    items,
    remove: (file: FileReference) => save(items.filter(item => referenceKey(item) !== referenceKey(file))),
    clear: () => save([]),
  };
}

function TaskFiles({
  files,
  disabled,
  remove,
}: {
  files: readonly FileReference[];
  disabled: boolean;
  remove: (file: FileReference) => void;
}) {
  return (
    <section aria-labelledby="task-files-heading" className="space-y-2">
      <h3 id="task-files-heading" className="text-sm font-medium">
        Files to read
      </h3>
      <ul className="space-y-1">
        {files.map(file => (
          <li key={referenceKey(file)} className="flex min-w-0 flex-wrap items-center gap-2">
            <FileTypeIcon name={file.name} mediaType={file.mediaType} />
            <span className="min-w-0 flex-1 truncate text-sm" title={file.name}>
              {file.name}
            </span>
            {file.source === 'google' && <span className="shrink-0 text-xs text-muted-foreground">Google Drive</span>}
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              aria-label={`Remove ${file.name}`}
              onClick={() => remove(file)}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">
        The agent reads each file’s current content with your access when it works on this message, and again on later
        steps. Text and documents up to 16,000 characters are readable; other files pause the task.
        {files.some(file => file.source === 'google') &&
          ' Google Drive files are read through your current Google account. If you disconnect or switch accounts, the task pauses until you add the file again.'}
      </p>
    </section>
  );
}

function TaskContext({
  workspaceId,
  api,
  disabled,
  sources,
  setSources,
  exclude,
  room,
}: {
  workspaceId: string;
  api: ReturnType<typeof taskApi>;
  disabled: boolean;
  sources: ContextSource[];
  setSources: (sources: ContextSource[]) => void;
  exclude: string | undefined;
  room: number;
}) {
  const [open, setOpen] = useState(false),
    [after, setAfter] = useState<string>(),
    [chatId, setChatId] = useState('');
  const chats = useMemo(() => conversationApi(workspaceId, () => {}), [workspaceId]);
  const read = useTaskSources(api, after, exclude, open);
  const chatRead = useTaskSourceChats(chats, open);
  const files = useTaskSourceFiles(chats, chatId, open);
  const full = sources.length >= room;
  const selectedTasks = sources.flatMap(source => (source.kind === 'task' ? [source.taskId] : []));
  const selectedFiles = sources.flatMap(source => (source.kind === 'attachment' ? [source.attachmentId] : []));
  const toggle = (source: ContextSource, checked: boolean) => {
    if (disabled) return;
    const key = JSON.stringify(source);
    if (checked && full) return;
    setSources(
      checked
        ? [...sources.filter(item => JSON.stringify(item) !== key), source]
        : sources.filter(item => JSON.stringify(item) !== key),
    );
  };
  return (
    <div className="grid gap-3">
      <div className="flex flex-col items-start gap-1.5">
        <Button
          variant="outline"
          disabled={disabled}
          aria-describedby="task-context-help"
          onClick={() => setOpen(!open)}
        >
          {open ? 'Hide optional context' : 'Attach past task or chat file'}
        </Button>
        <p id="task-context-help" className="text-sm text-muted-foreground">
          Attach text, CSV, JSON, or Markdown files up to 16 KB from a past task or personal chat.
        </p>
      </div>
      {sources.length > 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {full
            ? `${room === 20 ? 'Twenty references selected.' : 'This message has twenty references with its files.'} Remove one before adding another.`
            : `${sources.length} of ${room} references selected.`}
        </p>
      )}
      {sources.length > 0 && (
        <ul aria-label="Selected task context" className="grid gap-2">
          {sources.map(source => (
            <SelectedContext
              key={JSON.stringify(source)}
              source={source}
              api={api}
              chats={chats}
              disabled={disabled}
              remove={() => toggle(source, false)}
            />
          ))}
        </ul>
      )}
      {open && (
        <>
          <AgentRead state={read.state} refresh={read.refresh}>
            {data => {
              const available = data.tasks.flatMap(task => (task.kind === 'available' ? [task] : []));
              return (
                <div className="grid gap-2">
                  {available.length ? (
                    <ChoiceGroup
                      type="checkbox"
                      legend="Past tasks"
                      optional
                      value={selectedTasks}
                      options={available.map(task => ({
                        value: task.id,
                        label: task.title.slice(0, 120),
                        disabled: full && !selectedTasks.includes(task.id),
                      }))}
                      onValueChange={next => {
                        const task = available.find(item => item.id === changedValue(selectedTasks, next));
                        if (task)
                          toggle(
                            { kind: 'task', taskId: task.id, throughSequence: task.sequence },
                            next.includes(task.id),
                          );
                      }}
                    />
                  ) : (
                    <p className="text-sm">No other accessible tasks on this page.</p>
                  )}
                  {available.length < data.tasks.length && (
                    <p className="text-sm text-muted-foreground">
                      A past task is unavailable because its source access changed. Other context can still be selected.
                    </p>
                  )}
                  {data.nextCursor && (
                    <div>
                      <Button
                        variant="outline"
                        disabled={disabled}
                        onClick={() => setAfter(data.nextCursor ?? undefined)}
                      >
                        More past tasks
                      </Button>
                    </div>
                  )}
                </div>
              );
            }}
          </AgentRead>
          <AgentRead state={chatRead.state} refresh={chatRead.refresh}>
            {data => (
              <div className="grid gap-2">
                <Field id="task-chat-files" label="Files from a personal chat" optional>
                  <Select value={chatId} onValueChange={value => setChatId(value ?? '')}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a personal chat" />
                    </SelectTrigger>
                    <SelectContent>
                      {data.chats.map(chat => (
                        <SelectItem key={chat.id} value={chat.id}>
                          {chat.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                {!data.chats.length && (
                  <p className="text-sm">
                    No personal chats with files yet. Upload a file in a personal chat, then return here.
                  </p>
                )}
              </div>
            )}
          </AgentRead>
          {chatId && (
            <AgentRead state={files.state} refresh={files.refresh}>
              {data =>
                data.length ? (
                  <ChoiceGroup
                    type="checkbox"
                    legend="Files in this chat"
                    optional
                    value={selectedFiles}
                    options={data.map(file => ({
                      value: file.id,
                      label: file.filename,
                      disabled: full && !selectedFiles.includes(file.id),
                      description:
                        file.size > 16000
                          ? 'Too large for task context. Selecting this file will pause the task.'
                          : readableTypes.includes(file.mediaType)
                            ? 'Readable task context if the file contains valid UTF-8 text.'
                            : 'Unsupported task format. Selecting this file will pause the task.',
                    }))}
                    onValueChange={next => {
                      const id = changedValue(selectedFiles, next);
                      if (id)
                        toggle({ kind: 'attachment', conversationId: chatId, attachmentId: id }, next.includes(id));
                    }}
                  />
                ) : (
                  <p className="text-sm">No files in the recent messages of this chat.</p>
                )
              }
            </AgentRead>
          )}
        </>
      )}
    </div>
  );
}

function SelectedContext({
  source,
  api,
  chats,
  disabled,
  remove,
}: {
  source: ContextSource;
  api: ReturnType<typeof taskApi>;
  chats: ReturnType<typeof conversationApi>;
  disabled: boolean;
  remove: () => void;
}) {
  const read = useFeatureRead({
    key:
      source.kind === 'task'
        ? [...taskKeys.context(source.taskId), 'name', source.throughSequence]
        : [...taskKeys.attachment(source.conversationId, source.attachmentId), 'name'],
    load: async signal =>
      source.kind === 'task'
        ? ((await api.context(source.taskId, signal))[0]?.text ?? null)
        : (await chats.attachment(source.conversationId, source.attachmentId, signal)).filename,
  });
  const name = read.state.kind === 'ready' ? read.state.data : null;
  const noun = source.kind === 'task' ? 'Task' : 'File';
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
      <ReferenceName noun={noun} name={name} state={read.state} refresh={read.refresh} />
      <Button
        variant="outline"
        disabled={disabled}
        aria-label={`Remove ${name ?? `${noun.toLowerCase()} reference`}`}
        onClick={remove}
      >
        Remove
      </Button>
    </li>
  );
}
