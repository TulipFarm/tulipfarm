import { useState } from 'react';
import type { z } from 'zod';
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import {
  githubTriggerEvents,
  maxTriggers,
  triggerSchema,
  workflowSchema,
  type GitHubEventFilter,
  type GitHubTriggerEvent,
  type Trigger,
  type TriggerKind,
} from '@tulipfarm/workflows/contracts';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Switch } from '@tulipfarm/sprout/switch';
import { UnsavedChanges } from '@/features/tables/feedback';
import { workflowRequest, WorkflowRequestError } from './api';
import { describeGitHubTrigger, githubEventNames, type GitHubNames } from './definition-description';
import { defaultTriggerBody, onceInPast, TriggerSettings } from './editor-controls';
import {
  githubNames,
  useRowTableNames,
  useWorkflowGitHubRepositories,
  useWorkflowProviders,
  useWorkflowRuns,
  type WorkflowGitHubRepository,
} from './queries';
import { newTriggerId, triggerKindNames, triggerLine, type TriggerBody } from './triggers';
import { TriggerIcon } from './workflow-summary';
import { activationFailureMessage, workflowLiveMessage } from './activation-feedback';

type Workflow = z.infer<typeof workflowSchema>;
type GitHubDraft = {
  repositories: string[] | { organizationId: string; includeFuture: true };
  events: GitHubEventFilter[];
};
type Item = {
  id: string;
  kind: TriggerKind;
  label: string;
  body: TriggerBody | null;
  github?: GitHubDraft;
  invalid?: string | undefined;
};
type Failure = { message: string; triggerId: string | null };

const addOrder: TriggerKind[] = ['cron', 'interval', 'once', 'webhook', 'github', 'row', 'record', 'provider', 'event'];

const itemOf = (trigger: Trigger): Item => {
  const { id, label, ...body } = trigger;
  return {
    id,
    kind: trigger.kind,
    label: label ?? '',
    body,
    ...(trigger.kind === 'github' ? { github: { repositories: trigger.repositories, events: trigger.events } } : {}),
  };
};
const triggerOf = (item: Item): Trigger | null =>
  item.body ? { ...item.body, id: item.id, ...(item.label.trim() ? { label: item.label.trim() } : {}) } : null;
const githubBody = (draft: GitHubDraft): TriggerBody | null =>
  (Array.isArray(draft.repositories) ? draft.repositories.length : true) && draft.events.length
    ? { kind: 'github', repositories: draft.repositories, events: draft.events }
    : null;

// Saved definitions come back from jsonb with reordered keys, so compare with keys sorted.
const sameJson = (value: unknown) =>
  JSON.stringify(value, (_, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );

/** A once trigger whose time was saved unchanged; it may stay after its time passed, and never fires again. */
function keptOnce(item: Item, saved: readonly Trigger[]) {
  const body = item.body;
  return (
    body?.kind === 'once' &&
    saved.some(trigger => trigger.id === item.id && trigger.kind === 'once' && trigger.at === body.at)
  );
}

function problem(item: Item, saved: readonly Trigger[]) {
  if (item.label.trim().length > 100) return 'Keep the label to 100 characters or fewer.';
  if (item.invalid) return item.invalid;
  const trigger = triggerOf(item);
  if (!trigger) return 'Finish this trigger’s settings before saving.';
  if (onceInPast(trigger) && !keptOnce(item, saved)) return 'This time has passed. Choose a future time.';
  if (trigger.kind === 'event' && !/^[a-z][a-z0-9_]{0,47}$/.test(trigger.name))
    return 'Use lowercase letters, digits and underscores for the event name, starting with a letter.';
  return triggerSchema.safeParse(trigger).success ? null : 'Check this trigger’s settings.';
}

/** What a trigger watches, naming GitHub repositories, accounts and tables instead of their IDs. */
function summary(item: Item, names: GitHubNames, tableNames: ReadonlyMap<string, string>) {
  if (!item.body) return `${triggerKindNames[item.kind]}, not set up yet`;
  return item.body.kind === 'github' ? describeGitHubTrigger(item.body, names) : triggerLine(item.body, tableNames);
}

/** Lists, edits and saves a Workflow's triggers, and switches each active one on or off. */
export function TriggerList({
  workspaceId,
  workflow,
  blocked,
  onSaved,
  onSwitched,
  onDenied,
  onCreateKey,
}: {
  workspaceId: string;
  workflow: Workflow;
  blocked: boolean;
  onSaved: (workflow: Workflow, notice: string) => void;
  onSwitched: (workflow: Workflow) => void;
  onDenied: () => void;
  onCreateKey: (triggerId: string) => void;
}) {
  const saved = workflow.definition.triggers;
  const editable = workflow.capabilities.manage && !workflow.archivedAt;
  const [items, setItems] = useState<Item[]>(() => saved.map(itemOf)),
    [open, setOpen] = useState<string | null>(null),
    [removing, setRemoving] = useState<Item | null>(null),
    [busy, setBusy] = useState<string | null>(null),
    [failure, setFailure] = useState<Failure | null>(null);
  const repositories = useWorkflowGitHubRepositories(
    workspaceId,
    items.some(item => item.kind === 'github'),
  );
  const repositoryList = repositories.state.kind === 'ready' ? repositories.state.data : [];
  const names = githubNames(repositoryList);
  const tableNames = useRowTableNames(workspaceId, items);
  const triggers = items.map(triggerOf);
  const dirty = sameJson(triggers) !== sameJson(saved);
  const problems = new Map(items.flatMap(item => (problem(item, saved) ? [[item.id, problem(item, saved)!]] : [])));
  const full = items.length >= maxTriggers;
  const locked = blocked || busy !== null;
  const knownKinds = new Map([...saved, ...(workflow.activeTriggers ?? [])].map(trigger => [trigger.id, trigger.kind]));

  const update = (id: string, change: (item: Item) => Item) => {
    setItems(current => current.map(item => (item.id === id ? change(item) : item)));
    if (failure?.triggerId === id) setFailure(null);
  };
  const move = (index: number, by: number) =>
    setItems(current => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(index + by, 0, item!);
      return next;
    });
  const add = (kind: TriggerKind) => {
    const id = newTriggerId(kind, [...items.map(item => item.id), ...knownKinds.keys()]);
    setItems(current => [
      ...current,
      {
        id,
        kind,
        label: '',
        body: defaultTriggerBody(kind),
        ...(kind === 'github' ? { github: { repositories: [], events: [] } } : {}),
      },
    ]);
    setOpen(id);
    setFailure(null);
  };

  async function save(activate: boolean) {
    const complete = triggers.filter((trigger): trigger is Trigger => trigger !== null);
    if (complete.length !== items.length || problems.size) return;
    setBusy(activate ? 'activate' : 'save');
    setFailure(null);
    try {
      const result = await workflowRequest(`/workspaces/${workspaceId}/workflows/${workflow.id}`, 'PUT', {
        revision: crypto.randomUUID(),
        expectedRevision: workflow.revision,
        definition: { ...workflow.definition, triggers: complete },
      });
      const savedWorkflow = workflowSchema.parse(result);
      if (!activate)
        return onSaved(
          savedWorkflow,
          savedWorkflow.enabled
            ? 'Revision saved. Runs still use the active revision until you activate this one.'
            : savedWorkflow.definition.triggers.length
              ? 'Revision saved. Activate the workflow so its triggers can start runs.'
              : 'Revision saved. Activate the workflow to start runs.',
        );
      try {
        const active = await workflowRequest(`/workspaces/${workspaceId}/workflows/${workflow.id}/activation`, 'POST', {
          commandId: crypto.randomUUID(),
          expectedGeneration: savedWorkflow.generation,
          revision: savedWorkflow.revision,
          enabled: true,
        });
        const activeWorkflow = workflowSchema.parse(active);
        onSaved(activeWorkflow, workflowLiveMessage(activeWorkflow));
      } catch (error) {
        onSaved(savedWorkflow, activationFailureMessage(error, savedWorkflow, 'editor'));
      }
    } catch (error) {
      if (error instanceof WorkflowRequestError && [401, 403, 404].includes(error.status)) return onDenied();
      setFailure(saveFailure(error, items, saved, knownKinds));
    } finally {
      setBusy(null);
    }
  }
  async function toggle(id: string, enabled: boolean) {
    setBusy(id);
    setFailure(null);
    try {
      const result = await workflowRequest(
        `/workspaces/${workspaceId}/workflows/${workflow.id}/triggers/${id}/switch`,
        'POST',
        { commandId: crypto.randomUUID(), expectedGeneration: workflow.generation, enabled },
      );
      onSwitched(workflowSchema.parse(result));
    } catch (error) {
      if (error instanceof WorkflowRequestError && [401, 403, 404].includes(error.status)) return onDenied();
      setFailure({ triggerId: id, message: switchFailure(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="workflow-triggers" className="space-y-3">
      <UnsavedChanges dirty={dirty} />
      <AlertDialog open={removing !== null} onOpenChange={next => !next && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>
            Remove {removing ? removing.label.trim() || summary(removing, names, tableNames) : 'trigger'}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            It stops starting runs once you save and activate the change. A webhook loses its URL and key.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep trigger</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing) setItems(current => current.filter(item => item.id !== removing.id));
                if (open === removing?.id) setOpen(null);
                setRemoving(null);
              }}
            >
              Remove trigger
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="workflow-triggers" className="me-auto font-medium">
          Triggers
        </h2>
        {editable && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  state={
                    full
                      ? { kind: 'blocked', reason: `A workflow can have up to ${maxTriggers} triggers.` }
                      : locked
                        ? { kind: 'blocked', reason: 'Wait for the current request to finish.' }
                        : { kind: 'ready' }
                  }
                />
              }
            >
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              Add trigger
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                {addOrder.map(kind => (
                  <DropdownMenuItem key={kind} onClick={() => add(kind)}>
                    {triggerKindNames[kind]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {!items.length ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
          Runs only when started by hand.
        </p>
      ) : (
        <ol className="space-y-2">
          {items.map((item, index) => {
            const name = item.label.trim() || summary(item, names, tableNames);
            const state = workflow.triggers.find(trigger => trigger.id === item.id);
            const isSaved = saved.some(trigger => trigger.id === item.id);
            const issue = problems.get(item.id);
            const error = failure?.triggerId === item.id ? failure.message : null;
            const pastOnce = isSaved && item.body?.kind === 'once' && keptOnce(item, saved) && onceInPast(item.body);
            return (
              <li key={item.id} className="rounded-xl border border-border bg-card">
                <div className="flex flex-wrap items-center gap-3 p-3">
                  <TriggerIcon trigger={item} />
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="font-medium break-words">{name}</p>
                    {item.label.trim() && (
                      <p className="text-sm text-muted-foreground">{summary(item, names, tableNames)}</p>
                    )}
                    <p className="flex flex-wrap gap-1.5 empty:hidden">
                      {!isSaved && <Badge variant="info">Not saved</Badge>}
                      {isSaved && !state && workflow.enabled && <Badge variant="secondary">Not active yet</Badge>}
                      {state && !state.enabled && <Badge variant="warning">Off</Badge>}
                      {pastOnce && (
                        <OnceOutcome workspaceId={workspaceId} workflowId={workflow.id} triggerId={item.id} />
                      )}
                    </p>
                    {isSaved && item.kind === 'webhook' && !state?.webhook?.configured && (
                      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        <span>No key yet</span>
                        {editable && (
                          <Button variant="link" size="sm" disabled={locked} onClick={() => onCreateKey(item.id)}>
                            Set up webhook key
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                  {state && workflow.capabilities.manage && !workflow.archivedAt && (
                    <Switch
                      aria-label={`${name} on`}
                      checked={state.enabled}
                      disabled={locked}
                      aria-busy={busy === item.id}
                      onCheckedChange={enabled => void toggle(item.id, enabled)}
                    />
                  )}
                  {editable && (
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Move ${name} up`}
                        disabled={locked || index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUpIcon aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Move ${name} down`}
                        disabled={locked || index === items.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDownIcon aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost-destructive"
                        size="icon-sm"
                        aria-label={`Remove ${name}`}
                        disabled={locked}
                        onClick={() => setRemoving(item)}
                      >
                        <Trash2Icon aria-hidden="true" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-expanded={open === item.id}
                        aria-label={`${open === item.id ? 'Close' : 'Edit'} ${name}`}
                        disabled={locked}
                        onClick={() => setOpen(open === item.id ? null : item.id)}
                      >
                        {open === item.id ? 'Close' : 'Edit'}
                      </Button>
                    </div>
                  )}
                </div>
                {editable && open === item.id && (
                  <div className="space-y-3 border-t border-border p-3">
                    <div className="max-w-md space-y-1.5">
                      <Label htmlFor={`trigger-label-${item.id}`}>Label (optional)</Label>
                      <Input
                        id={`trigger-label-${item.id}`}
                        value={item.label}
                        maxLength={100}
                        placeholder={summary(item, names, tableNames)}
                        disabled={locked}
                        onChange={event => update(item.id, current => ({ ...current, label: event.target.value }))}
                      />
                    </div>
                    {item.kind === 'github' ? (
                      <GitHubSettings
                        read={repositories.state}
                        draft={item.github ?? { repositories: [], events: [] }}
                        disabled={locked}
                        onChange={github =>
                          update(item.id, current => ({ ...current, github, body: githubBody(github) }))
                        }
                      />
                    ) : item.kind === 'provider' ? (
                      <ProviderSettings
                        workspaceId={workspaceId}
                        trigger={item.body?.kind === 'provider' ? item.body : null}
                        disabled={locked}
                        onChange={body => update(item.id, current => ({ ...current, body }))}
                      />
                    ) : (
                      <TriggerSettings
                        workspaceId={workspaceId}
                        kind={item.kind}
                        trigger={item.body}
                        disabled={locked}
                        onChange={body => update(item.id, current => ({ ...current, body }))}
                        onValidityChange={(valid, reason) =>
                          update(item.id, current => ({ ...current, invalid: valid ? undefined : reason }))
                        }
                      />
                    )}
                  </div>
                )}
                {(issue || error) && (
                  <p role="alert" className="border-t border-border px-3 py-2 text-sm text-destructive">
                    {error ?? issue}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {editable && full && (
        <p className="text-sm text-muted-foreground">A workflow can have up to {maxTriggers} triggers.</p>
      )}
      {failure && failure.triggerId === null && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      )}
      {editable && dirty && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            pendingLabel={busy === 'save' ? 'Saving triggers...' : 'Saving and activating...'}
            state={
              busy === 'save' || busy === 'activate'
                ? { kind: 'busy' }
                : problems.size
                  ? { kind: 'blocked', reason: 'Fix the triggers marked above first.' }
                  : blocked
                    ? { kind: 'blocked', reason: 'Wait for the current request to finish.' }
                    : { kind: 'ready' }
            }
            onClick={() => void save(true)}
          >
            Save and activate
          </Button>
          <Button variant="outline" disabled={locked || problems.size > 0} onClick={() => void save(false)}>
            Save only
          </Button>
          <Button
            variant="ghost"
            disabled={locked}
            onClick={() => {
              setItems(saved.map(itemOf));
              setOpen(null);
              setFailure(null);
            }}
          >
            Discard changes
          </Button>
        </div>
      )}
    </section>
  );
}

function saveFailure(
  error: unknown,
  items: Item[],
  saved: readonly Trigger[],
  kinds: Map<string, TriggerKind>,
): Failure {
  if (!(error instanceof WorkflowRequestError) || error.status >= 500)
    return { triggerId: null, message: 'The triggers may not have saved. Refresh workflows before trying again.' };
  const first = (match: (item: Item) => boolean) => items.find(match)?.id ?? null;
  switch (error.code) {
    case 'too-many-triggers':
      return { triggerId: null, message: `A workflow can have up to ${maxTriggers} triggers. Remove some first.` };
    case 'trigger-kind-changed':
      return {
        triggerId: first(item => kinds.has(item.id) && kinds.get(item.id) !== item.kind),
        message: 'A trigger can’t change kind. Remove it and add a new one.',
      };
    case 'schedule-in-past':
      return {
        triggerId: first(item => !!item.body && onceInPast(item.body) && !keptOnce(item, saved)),
        message: 'This time has passed. Choose a future time.',
      };
    case 'github-repository-not-connected':
      return {
        triggerId: first(
          item =>
            item.kind === 'github' &&
            JSON.stringify(triggerOf(item)) !== JSON.stringify(saved.find(trigger => trigger.id === item.id)),
        ),
        message: 'A repository here isn’t in your GitHub Knowledge. Connect it, then save again.',
      };
    case 'record-field-unavailable':
    case 'record-source-denied':
      return {
        triggerId: first(item => item.kind === 'record' || item.kind === 'row'),
        message: 'You can’t read this table or field. Choose another.',
      };
    case 'stale-revision':
    case 'revision-conflict':
      return { triggerId: null, message: 'This workflow changed. Refresh workflows and make your changes again.' };
    default:
      return { triggerId: null, message: 'The triggers couldn’t be saved. Check each trigger and try again.' };
  }
}

function switchFailure(error: unknown) {
  if (!(error instanceof WorkflowRequestError) || error.status >= 500)
    return 'The switch may not have changed. Refresh workflows to check.';
  if (error.code === 'sponsor-required')
    return 'This trigger runs without a person. Turn the workflow on with an accepted sponsor first.';
  if (error.code === 'stale-generation') return 'This workflow changed. Refresh workflows and try again.';
  return 'The trigger couldn’t be switched. Refresh workflows and try again.';
}

/** Whether a once trigger whose time has passed started a run, judged from the runs you can see. */
function OnceOutcome({
  workspaceId,
  workflowId,
  triggerId,
}: {
  workspaceId: string;
  workflowId: string;
  triggerId: string;
}) {
  const read = useWorkflowRuns(workspaceId, workflowId, null, 1, triggerId);
  if (read.state.kind !== 'ready') return null;
  return <Badge variant="secondary">{read.state.data.runs.length ? 'Fired' : 'Missed'}</Badge>;
}

function ProviderSettings({
  workspaceId,
  trigger,
  disabled,
  onChange,
}: {
  workspaceId: string;
  trigger: Extract<TriggerBody, { kind: 'provider' }> | null;
  disabled: boolean;
  onChange: (trigger: TriggerBody) => void;
}) {
  const read = useWorkflowProviders(workspaceId);
  const [minutes, setMinutes] = useState(String(trigger?.minutes ?? 15));
  if (read.state.kind === 'loading')
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading connected apps...
      </p>
    );
  if (read.state.kind !== 'ready')
    return (
      <p role="alert" className="text-sm text-destructive">
        Connected apps could not load. Refresh the page and try again.
      </p>
    );
  const usable = read.state.data.filter(item => item.enabled && item.capabilities.use);
  if (!usable.length)
    return (
      <p className="text-sm text-muted-foreground">
        No connected apps you can use. Connect one under Workflow providers.
      </p>
    );
  const current = trigger ?? { kind: 'provider' as const, integrationId: '', event: 'created' as const, minutes: 15 };
  const change = (next: Partial<typeof current>) => {
    const merged = { ...current, ...next };
    if (merged.integrationId) onChange(merged);
  };
  return (
    <fieldset disabled={disabled} className="grid max-w-md gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="provider-integration">Connected app</Label>
        <Select value={current.integrationId} onValueChange={value => value && change({ integrationId: value })}>
          <SelectTrigger id="provider-integration">
            <SelectValue>{usable.find(item => item.id === current.integrationId)?.name ?? 'Choose an app'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {usable.map(item => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="provider-event">Start a run for</Label>
        <Select
          value={current.event}
          onValueChange={value => (value === 'created' || value === 'updated') && change({ event: value })}
        >
          <SelectTrigger id="provider-event">
            <SelectValue>{current.event === 'updated' ? 'Updated items' : 'New items'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="created">New items</SelectItem>
            <SelectItem value="updated">Updated items</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="provider-minutes">Check every, in minutes</Label>
        <Input
          id="provider-minutes"
          type="number"
          inputMode="numeric"
          min={1}
          max={1440}
          value={minutes}
          aria-invalid={!(/^\d+$/.test(minutes) && Number(minutes) >= 1 && Number(minutes) <= 1440)}
          onChange={event => {
            setMinutes(event.target.value);
            const value = Number(event.target.value);
            if (/^\d+$/.test(event.target.value) && value >= 1 && value <= 1440) change({ minutes: value });
          }}
        />
        <p className="text-xs text-muted-foreground">A whole number from 1 to 1440.</p>
      </div>
    </fieldset>
  );
}

type RepositoryRead = ReturnType<typeof useWorkflowGitHubRepositories>['state'];

function GitHubSettings({
  read,
  draft,
  disabled,
  onChange,
}: {
  read: RepositoryRead;
  draft: GitHubDraft;
  disabled: boolean;
  onChange: (draft: GitHubDraft) => void;
}) {
  const repositories: WorkflowGitHubRepository[] = read.kind === 'ready' ? read.data : [];
  const owners = [
    ...new Map(
      repositories.flatMap(item =>
        item.ownerId ? [[item.ownerId, item.fullName.split('/')[0] ?? item.fullName]] : [],
      ),
    ),
  ];
  const account = Array.isArray(draft.repositories) ? null : draft.repositories.organizationId;
  const chosen = Array.isArray(draft.repositories) ? draft.repositories : [];
  const setEvents = (events: GitHubEventFilter[]) => onChange({ ...draft, events });
  return (
    <fieldset disabled={disabled} className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Repositories</legend>
        {read.kind === 'loading' ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading your GitHub repositories...
          </p>
        ) : read.kind !== 'ready' ? (
          <p role="alert" className="text-sm text-destructive">
            Your GitHub repositories could not load. Refresh the page and try again.
          </p>
        ) : !repositories.length ? (
          <p className="text-sm text-muted-foreground">
            No GitHub repositories in your GitHub Knowledge. Connect some there first.
          </p>
        ) : (
          <>
            {owners.map(([ownerId, login]) => (
              <div key={ownerId} className="flex items-center gap-2">
                <Checkbox
                  id={`github-account-${ownerId}`}
                  checked={account === ownerId}
                  onCheckedChange={checked =>
                    onChange({
                      ...draft,
                      repositories: checked ? { organizationId: ownerId, includeFuture: true } : [],
                    })
                  }
                />
                <Label htmlFor={`github-account-${ownerId}`}>All repositories in {login}, including future ones</Label>
              </div>
            ))}
            {account === null && (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      onChange({ ...draft, repositories: repositories.slice(0, 1000).map(item => item.repositoryId) })
                    }
                  >
                    Select all
                  </Button>
                  {chosen.length > 0 && (
                    <Button variant="ghost" size="sm" onClick={() => onChange({ ...draft, repositories: [] })}>
                      Clear
                    </Button>
                  )}
                </div>
                <ul className="max-h-60 space-y-1.5 overflow-y-auto rounded-lg border border-border p-2">
                  {repositories.map(item => (
                    <li key={item.repositoryId} className="flex items-center gap-2">
                      <Checkbox
                        id={`github-repository-${item.repositoryId}`}
                        checked={chosen.includes(item.repositoryId)}
                        onCheckedChange={checked =>
                          onChange({
                            ...draft,
                            repositories: checked
                              ? [...chosen, item.repositoryId]
                              : chosen.filter(id => id !== item.repositoryId),
                          })
                        }
                      />
                      <Label htmlFor={`github-repository-${item.repositoryId}`}>{item.fullName}</Label>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Events</legend>
        <ul className="space-y-2">
          {(Object.keys(githubTriggerEvents) as GitHubTriggerEvent[]).map(event => {
            const filter = draft.events.find(item => item.event === event);
            const actions: readonly string[] = githubTriggerEvents[event];
            return (
              <li key={event} className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`github-event-${event}`}
                    checked={!!filter}
                    disabled={!filter && draft.events.length >= 8}
                    onCheckedChange={checked =>
                      setEvents(
                        checked ? [...draft.events, { event }] : draft.events.filter(item => item.event !== event),
                      )
                    }
                  />
                  <Label htmlFor={`github-event-${event}`}>{githubEventNames[event]}</Label>
                </div>
                {filter && actions.length > 0 && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5 ps-6">
                    {actions.map(action => (
                      <div key={action} className="flex items-center gap-2">
                        <Checkbox
                          id={`github-action-${event}-${action}`}
                          checked={!!filter.actions?.includes(action)}
                          onCheckedChange={checked => {
                            const next = checked
                              ? [...(filter.actions ?? []), action]
                              : (filter.actions ?? []).filter(item => item !== action);
                            setEvents(
                              draft.events.map(item =>
                                item.event === event ? { event, ...(next.length ? { actions: next } : {}) } : item,
                              ),
                            );
                          }}
                        />
                        <Label htmlFor={`github-action-${event}-${action}`}>{action.replaceAll('_', ' ')}</Label>
                      </div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-muted-foreground">
          Choose up to 8 events. Leave actions unticked to start on every action.
        </p>
      </fieldset>
    </fieldset>
  );
}
