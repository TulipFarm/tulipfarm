import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { z } from 'zod';
import type { scheduleSchema } from '@tulipfarm/agents/schedule-contracts';
import { Button, type ButtonState } from '@tulipfarm/sprout/button';
import { CheckboxField, ChoiceGroup, Field } from '@tulipfarm/sprout/field';
import { Form, FormFooter, FormSection } from '@tulipfarm/sprout/form';
import { Input } from '@tulipfarm/sprout/input';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Disclosure } from '@/components/disclosure';
import { useAgentSchedules } from './queries';
import { useTableWrite } from '@/features/tables/use-table-write';
import { WriteFeedback } from '@/features/tables/feedback';
import { AgentRead } from './feedback';
import type { agentApi, AgentDetail } from './api';
import { TablePicker } from '@/features/tables/table-picker';
import { activationLabel, scopeText } from './labels';
import { tableApi } from '@/features/tables/api';
import { useTableNames } from '@/features/tables/hooks';
import { TableName } from './reference-names';
import {
  fixSummary,
  intervalError,
  parseSchedule,
  scheduleMinimumMinutes,
  type ScheduleDraft,
  type ScheduleKind,
} from './administration';
import { useSharingCandidates } from './sharing';
import { defaultTaskLimits, limitDraft, taskLimitFields } from '@/features/tasks/limits';
import { taskStatusLabels } from '@/features/tasks/api';
import {
  cronDayChoices,
  cronParts,
  cronSummary,
  cronWithDays,
  cronWithTime,
  ordinaryCron,
  runTime,
  validateCron,
} from '@/features/workflows/calendar-schedule';

type Api = ReturnType<typeof agentApi>;
type Schedule = z.infer<typeof scheduleSchema>;
type ScheduleWrite =
  | { kind: 'activate'; id: string; tableId: string; revision: string }
  | ({ kind: 'schedule' } & Parameters<Api['schedule']>[1])
  | { kind: 'revoke'; id: string };

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const emptyDraft: ScheduleDraft = {
  kind: 'task',
  cadence: 'interval',
  text: '',
  tableId: '',
  limits: limitDraft(defaultTaskLimits),
  activationId: '',
  minutes: { task: '1440', inspect: '60' },
  cronExpression: '0 9 * * 1-5',
  timezone: browserZone(),
  sponsorConsent: false,
};
const kinds: Record<
  ScheduleKind,
  { label: string; description: string; submit: string; minutesHelper: string; note: string }
> = {
  task: {
    label: 'Run a saved prompt',
    description: 'Starts a private task with the same prompt each time.',
    submit: 'Create prompt schedule',
    minutesHelper: 'From 60 to 10,080 minutes. Prompt schedules run at most hourly; 1,440 runs once a day.',
    note: 'Each run is a private task owned by the sponsor and appears in the sponsor’s task list.',
  },
  inspect: {
    label: 'Inspect a table',
    description: 'Reads one table’s fields each time.',
    submit: 'Create inspection schedule',
    minutesHelper: 'From 1 to 10,080 minutes (one week).',
    note: 'Missed intervals are skipped; one inspection runs at a time.',
  },
};
const inspectionStatusLabels: Record<
  Extract<NonNullable<Schedule['lastRun']>, { kind: 'inspection' }>['status'],
  string
> = { pending: 'Running', completed: 'Completed', waiting: 'Waiting', blocked: 'Blocked', failed: 'Failed' };
const limitsSummary = (limits: Extract<Schedule['action'], { kind: 'task' }>['limits']) =>
  taskLimitFields
    .map(field => `${(limits[field.key] / field.storedPerShown).toLocaleString('en-US')} ${field.unit}`)
    .join(', ');
const excerpt = (text: string) => (text.length > 120 ? `${text.slice(0, 120)}…` : text);

export function AgentSchedules({
  api,
  detail,
  workspaceId,
  slug,
  teams,
  concealed,
  refresh,
}: {
  api: ReturnType<typeof agentApi>;
  detail: AgentDetail;
  workspaceId: string;
  slug: string;
  teams: { id: string; name: string }[];
  concealed: boolean;
  refresh: () => Promise<void>;
}) {
  const read = useAgentSchedules(api, detail.id, !concealed);
  const candidates = useSharingCandidates(workspaceId);
  const [draft, setDraft] = useState(emptyDraft);
  const [historyAudience, setHistoryAudience] = useState<string[]>([]);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const tables = useMemo(() => tableApi(workspaceId), [workspaceId]);
  const tableNames = useTableNames(
    tables,
    detail.activations.some(item => item.scope.length > 0),
  );
  const [checked, setChecked] = useState(false);
  const update = (change: Partial<ScheduleDraft>) => setDraft(previous => ({ ...previous, ...change }));
  const activation = detail.activations.find(item => item.id === draft.activationId);
  if (draft.activationId && !activation) update({ activationId: '' });
  const write = useTableWrite(
    async (input: ScheduleWrite) => {
      if (input.kind === 'activate') {
        const { kind: _kind, ...value } = input;
        await api.activateInspection(detail.id, value);
      } else if (input.kind === 'schedule') {
        const { kind: _kind, ...value } = input;
        await api.schedule(detail.id, value);
      } else await api.revokeSchedule(detail.id, input.id);
      return input.kind;
    },
    kind => {
      if (kind === 'schedule') {
        setDraft(previous => ({ ...emptyDraft, kind: previous.kind }));
        setHistoryAudience([]);
        setLimitsOpen(false);
        setAdvancedOpen(false);
        setChecked(false);
      }
    },
  );
  if (concealed) return null;
  const mode = kinds[draft.kind];
  const state: ButtonState =
    write.state.kind === 'sending'
      ? { kind: 'busy' }
      : write.state.kind === 'uncertain'
        ? { kind: 'blocked', reason: 'Check whether the last change went through first.' }
        : { kind: 'ready' };
  const inspectState: ButtonState =
    state.kind !== 'ready'
      ? state
      : !detail.definition.tools.includes('schema.inspect')
        ? { kind: 'blocked', reason: 'Add Inspect table fields to Permitted actions and save the agent first.' }
        : !draft.tableId
          ? {
              kind: 'blocked',
              reason: 'Choose a table to inspect first.',
              fix: { kind: 'jump', label: 'Choose a table', target: 'schedule-resource' },
            }
          : state;
  const sponsor = candidates.state.kind === 'ready' ? candidates.state.data.membershipId : null;
  const sponsorState: ButtonState =
    candidates.state.kind === 'loading'
      ? { kind: 'busy' }
      : !sponsor
        ? {
            kind: 'blocked',
            reason: 'Your sponsor details could not load.',
            fix: { kind: 'action', label: 'Try again', onClick: () => void candidates.refresh() },
          }
        : state;
  const consentState: ButtonState =
    sponsorState.kind !== 'ready' || draft.sponsorConsent
      ? sponsorState
      : {
          kind: 'blocked',
          reason: 'Check I sponsor this schedule above first.',
          fix: { kind: 'jump', label: 'Go to sponsor', target: 'schedule-sponsor' },
        };
  const parsed = parseSchedule(draft, detail.activations.length);
  const cronTrigger = { kind: 'cron' as const, expression: draft.cronExpression, timezone: draft.timezone };
  const cronAdvanced = !ordinaryCron(draft.cronExpression);
  const cron = cronParts(draft.cronExpression);
  const cronCheck = validateCron(cronTrigger);
  const errors: Partial<Record<string, string>> = checked ? parsed.errors : {};
  const summary = fixSummary(parsed.errors, 'create the schedule');
  const creating = write.state.kind === 'sending' && write.state.input.kind === 'schedule';
  const dirty =
    JSON.stringify({ ...draft, kind: emptyDraft.kind }) !== JSON.stringify(emptyDraft) || historyAudience.length > 0;
  function create(): 'invalid' | undefined {
    if (sponsorState.kind !== 'ready' || !sponsor) return;
    if (!activation || !parsed.action) {
      setChecked(true);
      if (taskLimitFields.some(field => parsed.errors[field.key])) setLimitsOpen(true);
      if (draft.cadence === 'cron' && parsed.errors.cadence) setAdvancedOpen(true);
      return 'invalid';
    }
    setChecked(false);
    void write.submit({
      kind: 'schedule',
      id: crypto.randomUUID(),
      activationId: activation.id,
      action: parsed.action,
      trigger: parsed.trigger!,
      sponsorMembershipId: sponsor,
      historyAudience: parsed.action.kind === 'task' ? [] : historyAudience,
    });
  }
  function responsor(item: Schedule) {
    if (sponsor)
      void write.submit({
        kind: 'schedule',
        id: item.id,
        activationId: item.activationId,
        action: item.action,
        trigger: item.trigger,
        sponsorMembershipId: sponsor,
        historyAudience: item.action.kind === 'task' ? [] : item.historyAudience,
      });
  }
  return (
    <FormSection
      id="agent-schedules"
      title="Scheduled trigger"
      label="Agent schedules"
      description="Start this agent with a saved prompt or table inspection on an interval or calendar schedule with an active version."
    >
      <Form disabled={state.kind !== 'ready'} onSubmit={create}>
        <div className="grid gap-5">
          <ChoiceGroup
            type="radio"
            layout="columns"
            required
            legend="What runs"
            value={draft.kind}
            onValueChange={kind => update({ kind })}
            options={(['task', 'inspect'] as const).map(value => ({
              value,
              label: kinds[value].label,
              description: kinds[value].description,
            }))}
          />
          {draft.kind === 'task' ? (
            <Field
              id="schedule-prompt"
              label="Prompt"
              required
              counter={`${draft.text.length.toLocaleString('en-US')} / 8,000`}
              error={errors.prompt}
            >
              <Textarea value={draft.text} maxLength={8000} onChange={event => update({ text: event.target.value })} />
            </Field>
          ) : (
            <>
              <TablePicker
                workspaceId={workspaceId}
                teams={teams}
                id="schedule-resource"
                label="Table to inspect"
                required
                value={draft.tableId}
                disabled={state.kind !== 'ready'}
                error={errors.resource}
                onChange={tableId => update({ tableId })}
              />
              <Button
                state={inspectState}
                variant="outline"
                onClick={() =>
                  void write.submit({
                    kind: 'activate',
                    id: crypto.randomUUID(),
                    tableId: draft.tableId,
                    revision: detail.definitionRevision,
                  })
                }
              >
                Activate saved revision for inspection
              </Button>
            </>
          )}
          <fieldset className="grid gap-5">
            <legend className="text-sm font-medium">When to run</legend>
            <div className="flex flex-wrap gap-2">
              <Button
                variant={draft.cadence === 'interval' ? 'secondary' : 'outline'}
                onClick={() => update({ cadence: 'interval' })}
              >
                Repeat interval
              </Button>
              <Button
                variant={draft.cadence === 'cron' ? 'secondary' : 'outline'}
                onClick={() => update({ cadence: 'cron' })}
              >
                Calendar schedule
              </Button>
            </div>
            {draft.cadence === 'interval' ? (
              <div className="grid gap-5 sm:grid-cols-2">
                <Field
                  id="schedule-activation"
                  label="Instructions to run"
                  required
                  disabled={!detail.activations.length}
                  helper={detail.activations.length ? undefined : 'Activate the instructions in Execution first.'}
                  error={errors.activation}
                >
                  <Select value={activation?.id ?? ''} onValueChange={value => update({ activationId: value ?? '' })}>
                    <SelectTrigger>
                      <SelectValue>
                        {activation ? activationLabel(detail, activation) : 'Choose activated instructions'}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {detail.activations.map(item => (
                        <SelectItem key={item.id} value={item.id}>
                          {activationLabel(detail, item)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field
                  id="schedule-minutes"
                  label="Interval in minutes"
                  required
                  helper={mode.minutesHelper}
                  error={errors.cadence}
                >
                  <Input
                    type="number"
                    min={scheduleMinimumMinutes[draft.kind]}
                    max={10080}
                    value={draft.minutes[draft.kind]}
                    onChange={event => update({ minutes: { ...draft.minutes, [draft.kind]: event.target.value } })}
                  />
                </Field>
              </div>
            ) : (
              <div className="grid gap-5">
                <Field
                  id="schedule-activation"
                  label="Instructions to run"
                  required
                  disabled={!detail.activations.length}
                  helper={detail.activations.length ? undefined : 'Activate the instructions in Execution first.'}
                  error={errors.activation}
                >
                  <Select value={activation?.id ?? ''} onValueChange={value => update({ activationId: value ?? '' })}>
                    <SelectTrigger>
                      <SelectValue>
                        {activation ? activationLabel(detail, activation) : 'Choose activated instructions'}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {detail.activations.map(item => (
                        <SelectItem key={item.id} value={item.id}>
                          {activationLabel(detail, item)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <div className="grid gap-5 sm:grid-cols-3">
                  {cronAdvanced ? (
                    <p className="text-sm text-muted-foreground sm:col-span-2">
                      This schedule uses a custom cron expression. Change it under Advanced schedule, or choose days and
                      a time again.
                    </p>
                  ) : (
                    <>
                      <Field id="schedule-days" label="Days" required>
                        <Select
                          value={cron.days}
                          onValueChange={value => {
                            if (value) update({ cronExpression: cronWithDays(draft.cronExpression, value) });
                          }}
                        >
                          <SelectTrigger id="schedule-days" width="full">
                            <SelectValue>
                              {cronDayChoices.find(([value]) => value === cron.days)?.[1] ?? cron.days}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {cronDayChoices.map(([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field id="schedule-time" label="Time" required>
                        <Input
                          type="time"
                          value={cron.time}
                          onChange={event => {
                            const expression = cronWithTime(draft.cronExpression, event.target.value);
                            if (expression) update({ cronExpression: expression });
                          }}
                        />
                      </Field>
                    </>
                  )}
                  <Field id="schedule-timezone" label="Time zone" required>
                    <Select
                      value={draft.timezone}
                      onValueChange={value => {
                        if (value) update({ timezone: value });
                      }}
                    >
                      <SelectTrigger id="schedule-timezone" width="full">
                        <SelectValue>{draft.timezone.replaceAll('_', ' ')}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {[...new Set([draft.timezone, 'UTC', ...Intl.supportedValuesOf('timeZone')])].map(zone => (
                          <SelectItem key={zone} value={zone}>
                            {zone.replaceAll('_', ' ')}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                {!cronCheck.problem && (
                  <div className="grid gap-1 text-sm">
                    <p>{cronAdvanced ? 'Custom schedule.' : cronSummary(cronTrigger)} Next runs:</p>
                    <ol aria-label="Next scheduled runs" className="list-inside list-decimal text-muted-foreground">
                      {cronCheck.runs.map(run => (
                        <li key={run}>
                          <time dateTime={run}>{runTime(run, draft.timezone)}</time>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                <Disclosure title="Advanced schedule" open={advancedOpen} onOpenChange={setAdvancedOpen}>
                  <Field
                    id="schedule-cron"
                    label="Cron expression"
                    required
                    helper="Five fields: minute, hour, day of month, month, and day of week. For example, 0 9 * * 1 runs Mondays at 09:00."
                    error={errors.cadence}
                  >
                    <Input
                      value={draft.cronExpression}
                      onChange={event => update({ cronExpression: event.target.value })}
                    />
                  </Field>
                  {cronAdvanced && (
                    <div>
                      <Button variant="outline" onClick={() => update({ cronExpression: emptyDraft.cronExpression })}>
                        Use days and a time
                      </Button>
                    </div>
                  )}
                </Disclosure>
              </div>
            )}
          </fieldset>
          {draft.kind === 'task' && (
            <>
              {activation && (
                <p className="break-words text-sm text-muted-foreground">
                  Data each run may use: {scopeText(activation.scope, tableNames)}.
                </p>
              )}
              <Disclosure title="Task limits for each run" open={limitsOpen} onOpenChange={setLimitsOpen}>
                <p className="text-sm text-muted-foreground">Each run stops at these limits.</p>
                <div className="grid gap-4 sm:grid-cols-3">
                  {taskLimitFields.map(field => (
                    <Field
                      key={field.key}
                      id={`schedule-${field.key}`}
                      label={field.label}
                      required
                      error={errors[field.key]}
                    >
                      <Input
                        type="number"
                        min={field.min}
                        max={field.max}
                        value={draft.limits[field.key]}
                        onChange={event => update({ limits: { ...draft.limits, [field.key]: event.target.value } })}
                      />
                    </Field>
                  ))}
                </div>
              </Disclosure>
            </>
          )}
          <CheckboxField
            id="schedule-sponsor"
            label="I sponsor this schedule using my current permissions"
            helper="Scheduled runs use your access and stop if you lose it."
            error={errors.sponsor}
            checked={draft.sponsorConsent}
            onCheckedChange={sponsorConsent => update({ sponsorConsent })}
          />
          {draft.kind === 'inspect' && (
            <AgentRead state={candidates.state} refresh={candidates.refresh}>
              {data => (
                <ChoiceGroup
                  type="checkbox"
                  layout="columns"
                  optional
                  legend="Who can see results"
                  helper="Each person needs run and data access."
                  options={data.people.map(person => ({
                    value: person.membershipId,
                    label: person.name,
                    description: person.email,
                  }))}
                  value={historyAudience}
                  onValueChange={setHistoryAudience}
                />
              )}
            </AgentRead>
          )}
          <FormFooter
            dirty={dirty}
            note={mode.note}
            error={checked ? summary : undefined}
            submit={{
              label: mode.submit,
              pendingLabel: creating ? 'Creating schedule…' : mode.submit,
              state: sponsorState,
            }}
          >
            <WriteFeedback
              state={write.state}
              checkStatus={() => {
                void read.refresh();
                void refresh();
              }}
              retry={input => void write.submit(input)}
            />
          </FormFooter>
        </div>
      </Form>
      <AgentRead state={read.state} refresh={read.refresh}>
        {items =>
          items.length ? (
            <ul aria-label="Agent schedule list" className="grid gap-3">
              {items.map(item => (
                <li key={item.id} className="grid gap-2 break-words rounded-lg border p-3">
                  <p className="text-sm font-medium text-foreground">
                    {item.revoked
                      ? 'Revoked'
                      : item.paused
                        ? 'Paused, sponsor required'
                        : item.enabled
                          ? 'Scheduled'
                          : 'Disabled'}{' '}
                    {scheduleLabel(item)}
                  </p>
                  {item.pauseReason === 'sponsor-access-lost' && (
                    <p className="text-sm text-muted-foreground">
                      The sponsor no longer has access. Resume as sponsor using your current permissions.
                    </p>
                  )}
                  {item.pauseReason === 'scheduled-call-denied' && (
                    <p className="text-sm text-muted-foreground">
                      The scheduled call was denied. Resume as sponsor after reviewing access.
                    </p>
                  )}
                  {item.action.kind === 'task' ? (
                    <>
                      <p className="whitespace-pre-wrap text-sm">Runs prompt: {excerpt(item.action.text)}</p>
                      <p className="text-sm text-muted-foreground">
                        Limits for each run: {limitsSummary(item.action.limits)}.
                      </p>
                    </>
                  ) : (
                    <p className="break-words text-sm">
                      Inspects table <TableName workspaceId={workspaceId} tableId={item.action.tableId} />
                    </p>
                  )}
                  <p className="break-all text-sm">Activated revision {item.revision}</p>
                  <p className="text-sm">Next due {formatNextRun(item)}</p>
                  <LastRun run={item.lastRun} slug={slug} />
                  <p className="text-sm text-muted-foreground">
                    {item.action.kind === 'task'
                      ? kinds.task.note
                      : 'History is visible only to the selected audience.'}
                  </p>
                  {!item.revoked && sponsor && item.trigger.kind === 'interval' && (
                    <IntervalEditor
                      key={`${item.id}-${item.trigger.minutes}`}
                      item={item}
                      consent={consentState}
                      refresh={read.refresh}
                      save={minutes =>
                        api.schedule(detail.id, {
                          id: item.id,
                          activationId: item.activationId,
                          action: item.action,
                          trigger: { kind: 'interval', minutes },
                          sponsorMembershipId: sponsor,
                          historyAudience: item.action.kind === 'task' ? [] : item.historyAudience,
                        })
                      }
                    />
                  )}
                  {!item.revoked && (
                    <div className="flex flex-wrap items-start gap-2">
                      <Button
                        state={state}
                        variant="outline"
                        onClick={() => void write.submit({ kind: 'revoke', id: item.id })}
                      >
                        Revoke schedule
                      </Button>
                      {item.action.kind === 'task' ? (
                        <Button variant="outline" state={consentState} onClick={() => responsor(item)}>
                          {item.paused ? 'Resume as sponsor' : 'Sponsor this schedule'}
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          state={
                            consentState.kind === 'ready' && draft.kind !== 'inspect'
                              ? {
                                  kind: 'blocked',
                                  reason: 'Choose Inspect a table above to pick who can see results first.',
                                  fix: {
                                    kind: 'action',
                                    label: 'Choose Inspect a table',
                                    onClick: () => update({ kind: 'inspect' }),
                                  },
                                }
                              : consentState
                          }
                          onClick={() => responsor(item)}
                        >
                          Sponsor with selected audience
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <StatePanel
              kind="empty"
              heading="h3"
              title="No schedules yet"
              description="Activate the instructions in Execution, then create an interval or calendar schedule above."
            />
          )
        }
      </AgentRead>
    </FormSection>
  );
}

function IntervalEditor({
  item,
  consent,
  save,
  refresh,
}: {
  item: Schedule;
  consent: ButtonState;
  save: (intervalMinutes: number) => Promise<unknown>;
  refresh: () => Promise<void>;
}) {
  const saved = String(item.trigger.kind === 'interval' ? item.trigger.minutes : '');
  const [minutes, setMinutes] = useState(saved);
  const [checked, setChecked] = useState(false);
  const write = useTableWrite(save, () => void refresh());
  const error = intervalError(item.action.kind, Number(minutes));
  const state: ButtonState =
    write.state.kind === 'sending'
      ? { kind: 'busy' }
      : write.state.kind === 'uncertain'
        ? { kind: 'blocked', reason: 'Check whether the last change went through first.' }
        : consent;
  function submit(): 'invalid' | undefined {
    if (state.kind !== 'ready') return;
    if (error) {
      setChecked(true);
      return 'invalid';
    }
    setChecked(false);
    void write.submit(Number(minutes));
  }
  return (
    <Form disabled={write.state.kind === 'sending'} label="Change interval" onSubmit={submit}>
      <div className="grid gap-3">
        <Field
          id={`schedule-${item.id}-minutes`}
          label="New interval in minutes"
          required
          helper={kinds[item.action.kind].minutesHelper}
          error={checked ? error : undefined}
        >
          <Input
            type="number"
            min={scheduleMinimumMinutes[item.action.kind]}
            max={10080}
            value={minutes}
            onChange={event => setMinutes(event.target.value)}
          />
        </Field>
        <FormFooter
          dirty={minutes !== saved}
          note="Saving makes you the sponsor. The next run moves to match the new interval."
          error={checked && error ? 'Fix 1 field to change the interval.' : undefined}
          submit={{ label: 'Save interval', pendingLabel: 'Saving interval…', state }}
          cancel={{
            kind: 'reset',
            label: 'Discard changes',
            onReset: () => {
              setMinutes(saved);
              setChecked(false);
            },
          }}
        >
          <WriteFeedback
            state={write.state}
            checkStatus={() => void refresh()}
            retry={value => void write.submit(value)}
          />
        </FormFooter>
      </div>
    </Form>
  );
}

function LastRun({ run, slug }: { run: Schedule['lastRun']; slug: string }) {
  if (!run) return <p className="text-sm">Last run: Not visible to you or not started</p>;
  if (run.kind === 'inspection')
    return <p className="text-sm">Last inspection: {inspectionStatusLabels[run.status]}</p>;
  if (run.kind === 'skipped')
    return (
      <p className="text-sm">
        Last scheduled start skipped:{' '}
        {run.reason === 'task-limit'
          ? 'You have 1,000 active tasks. Complete active tasks to free capacity.'
          : run.reason}{' '}
        The schedule will try again at the next occurrence.
      </p>
    );
  return (
    <p className="flex flex-wrap items-center gap-x-1 text-sm">
      Last task: {taskStatusLabels[run.status]}
      <Button
        variant="link"
        size="sm"
        role="link"
        nativeButton={false}
        render={<Link to="/$workspaceSlug/agent-tasks/$taskId" params={{ workspaceSlug: slug, taskId: run.taskId }} />}
      >
        Open last task
      </Button>
    </p>
  );
}

function scheduleLabel(item: Schedule) {
  return item.trigger.kind === 'interval'
    ? `every ${item.trigger.minutes} minutes`
    : `${item.trigger.expression} in ${item.trigger.timezone.replaceAll('_', ' ')}`;
}

function formatNextRun(item: Schedule) {
  return item.trigger.kind === 'cron'
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: item.trigger.timezone,
      }).format(new Date(item.nextRunAt))
    : item.nextRunAt;
}
