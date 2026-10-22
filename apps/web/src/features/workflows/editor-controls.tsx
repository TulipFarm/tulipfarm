import { useMemo, useState } from 'react';
import type { z } from 'zod';
import {
  maxWaitSeconds,
  normalizeCronExpression,
  rawWebhookSchema,
  type ConditionStep,
  type Definition,
  type valueSchema,
} from '@tulipfarm/workflows/contracts';
import { tableApi, type TableDefinition } from '@/features/tables/api';
import { useTablePicker } from '@/features/tables/hooks';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Disclosure } from '@/components/disclosure';
import { Field } from '@tulipfarm/sprout/field';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Link } from '@tanstack/react-router';
import { workspaceRoute } from '@/router';
import { fromZonedInput, zonedInput } from './zoned-time';
import { cronDayChoices, ordinaryCron, validateCron } from './calendar-schedule';
import { OutputPathControl } from './output-picker';

export function stepTitle(step: Definition['steps'][number]) {
  switch (step.kind) {
    case 'agent':
      return 'Run an agent task';
    case 'slack-message':
      return 'Send a Slack message';
    case 'human':
      return 'Ask for a decision';
    case 'delay':
      return 'Wait before continuing';
    case 'wait-until':
      return 'Wait until a date';
    case 'code':
      return `Run ${step.language === 'javascript' ? 'JavaScript' : 'Python'} code`;
    case 'http':
      return `Send ${step.method} request`;
    case 'transform':
      return step.id === 'request'
        ? 'Collect the request'
        : step.id === 'result'
          ? 'Save the result'
          : 'Prepare information';
    case 'find-rows':
      return 'Find table rows';
    case 'create-row':
      return 'Add a table row';
    case 'update-row':
      return 'Update a table row';
    case 'condition':
      return 'Check a condition';
  }
}

export function valueDescription(value: z.infer<typeof valueSchema>, steps: Definition['steps']) {
  if (value.kind === 'literal') return `the fixed value ${JSON.stringify(value.value)}`;
  const source =
    value.kind === 'input' ? 'the workflow input' : `step ${steps.findIndex(step => step.id === value.step) + 1}`;
  return value.path.length ? `${source}, field ${value.path.join(' / ')}` : source;
}

export { comparisonWords, filterPhrase, recordScheduleDescription } from './definition-description';
import { comparisonWords, filterPhrase, recordScheduleDescription } from './definition-description';

/** Describes a condition and its two branches. An empty branch skips the other branch's steps, so it names those. */
export function conditionDescription(step: ConditionStep, steps: Definition['steps']) {
  const { when } = step;
  const condition = `If ${valueDescription(when.left, steps)} ${comparisonWords[when.op]}${'right' in when ? ` ${valueDescription(when.right, steps)}` : ''}`;
  const named = (ids: string[]) => {
    const parts = ids.map(id => {
      const index = steps.findIndex(item => item.id === id);
      const target = steps[index];
      return `step ${index + 1}${target ? ` (${stepTitle(target)})` : ''}`;
    });
    return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts.join('');
  };
  const branch = (lead: string, own: string[], other: string[]) =>
    own.length ? `${lead} runs ${named(own)}.` : `${lead} skips ${named(other)}.`;
  return {
    condition,
    ifMet: branch('Then', step.ifMet, step.otherwise),
    otherwise: branch('Otherwise', step.otherwise, step.ifMet),
  };
}

export function WorkflowTrigger({
  workspaceId,
  trigger,
  disabled,
  onChange,
  onProvider,
  onValidityChange,
}: {
  workspaceId: string;
  trigger: Definition['trigger'];
  disabled: boolean;
  onChange: (trigger: Definition['trigger']) => void;
  onProvider: () => void;
  onValidityChange?: (valid: boolean, problem?: string) => void;
}) {
  const [intervalText, setIntervalText] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(
    () =>
      trigger.kind === 'webhook' ||
      trigger.kind === 'event' ||
      (trigger.kind === 'cron' && !ordinaryCron(trigger.expression)),
  );
  // A record trigger needs a table and field, so the choice stays local until both exist and the saved trigger is left untouched.
  const [recordPending, setRecordPending] = useState(false);
  const [rowPending, setRowPending] = useState(false);
  const choose = (next?: Definition['trigger']) => {
    setRecordPending(false);
    setRowPending(false);
    setAdvancedOpen(
      !!next &&
        (next.kind === 'webhook' || next.kind === 'event' || (next.kind === 'cron' && !ordinaryCron(next.expression))),
    );
    onValidityChange?.(true);
    if (next) onChange(next);
  };
  const recordShown = recordPending || trigger.kind === 'record';
  const rowShown = rowPending || trigger.kind === 'row';
  const tableTriggerShown = recordShown || rowShown;
  const expression = trigger.kind === 'cron' ? normalizeCronExpression(trigger.expression) : '';
  const parts = expression.split(' ');
  const ordinary = trigger.kind === 'cron' && ordinaryCron(trigger.expression);
  const intervalShown = trigger.kind === 'interval' ? (intervalText ?? String(trigger.minutes)) : '';
  const intervalValid =
    trigger.kind !== 'interval' ||
    (/^\d+$/.test(intervalShown) && Number(intervalShown) >= 1 && Number(intervalShown) <= 525600);
  const cronFeedback = trigger.kind === 'cron' ? validateCron(trigger) : null;
  const updateCron = (next: Extract<Definition['trigger'], { kind: 'cron' }>) => {
    const feedback = validateCron(next);
    onValidityChange?.(!feedback.problem, feedback.problem ?? undefined);
    onChange(next);
  };
  const changeWebhookPayload = (payload: Extract<Definition['trigger'], { kind: 'webhook' }>['payload']) => {
    if (trigger.kind !== 'webhook') return;
    const valid = payload === undefined || rawWebhookSchema.safeParse(payload).success;
    onValidityChange?.(
      valid,
      valid ? undefined : 'Complete the webhook payload and deduplication settings before saving.',
    );
    onChange(payload ? { ...trigger, payload } : { kind: 'webhook' });
  };
  return (
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="text-sm font-medium">When should it start?</legend>
      <div className="flex flex-wrap gap-2">
        <Button
          variant={!tableTriggerShown && trigger.kind === 'manual' ? 'secondary' : 'outline'}
          onClick={() => choose({ kind: 'manual' })}
        >
          Manual only
        </Button>
        <Button
          variant={!tableTriggerShown && trigger.kind === 'once' ? 'secondary' : 'outline'}
          onClick={() =>
            choose({
              kind: 'once',
              at: new Date(Math.ceil((Date.now() + 3600000) / 60000) * 60000).toISOString(),
              timezone: browserZone(),
            })
          }
        >
          One time
        </Button>
        <Button
          variant={!tableTriggerShown && trigger.kind === 'interval' ? 'secondary' : 'outline'}
          onClick={() => {
            setIntervalText(null);
            choose({ kind: 'interval', minutes: 60 });
          }}
        >
          Repeat
        </Button>
        <Button
          variant={!tableTriggerShown && trigger.kind === 'cron' ? 'secondary' : 'outline'}
          onClick={() => choose({ kind: 'cron', expression: '0 9 * * 1-5', timezone: browserZone() })}
        >
          Weekly schedule
        </Button>
        <Button
          variant={recordShown ? 'secondary' : 'outline'}
          onClick={() => {
            if (trigger.kind !== 'record') {
              setRowPending(false);
              setRecordPending(true);
              onValidityChange?.(false, recordIncomplete);
            }
          }}
        >
          Record date
        </Button>
        <Button
          variant={rowShown ? 'secondary' : 'outline'}
          onClick={() => {
            if (trigger.kind !== 'row') {
              setRecordPending(false);
              setRowPending(true);
              onValidityChange?.(false, rowIncomplete);
            }
          }}
        >
          Row change
        </Button>
        <Button
          variant={!tableTriggerShown && trigger.kind === 'provider' ? 'secondary' : 'outline'}
          onClick={() => {
            choose();
            onProvider();
          }}
        >
          Connected service
        </Button>
      </div>
      {recordShown ? (
        <RecordDate
          workspaceId={workspaceId}
          trigger={trigger.kind === 'record' ? trigger : null}
          onChange={next => {
            setRecordPending(false);
            onChange(next);
          }}
          onValidityChange={onValidityChange}
        />
      ) : (
        <>
          {trigger.kind === 'manual' && (
            <p className="text-sm text-muted-foreground">You start each run. No integration or schedule is needed.</p>
          )}
          {trigger.kind === 'interval' && (
            <>
              <Label htmlFor="interval">Repeat every, in minutes</Label>
              <Input
                id="interval"
                type="number"
                inputMode="numeric"
                min={1}
                max={525600}
                value={intervalShown}
                disabled={disabled}
                aria-invalid={!intervalValid}
                aria-describedby="interval-help"
                onChange={event => {
                  const value = event.target.value,
                    minutes = Number(value);
                  if (/^\d+$/.test(value) && minutes >= 1 && minutes <= 525600) {
                    onValidityChange?.(true);
                    setIntervalText(null);
                    onChange({ kind: 'interval', minutes });
                  } else {
                    onValidityChange?.(false, 'Enter repeat minutes from 1 to 525600 before saving.');
                    setIntervalText(value);
                  }
                }}
              />
              <p id="interval-help" className="text-sm text-muted-foreground">
                Runs every {trigger.minutes} minutes after activation. Enter a whole number from 1 to 525600.
              </p>
              {!intervalValid && (
                <p role="alert">
                  Enter repeat minutes from 1 to 525600. The workflow keeps its last valid interval of {trigger.minutes}{' '}
                  minutes.
                </p>
              )}
            </>
          )}
          {trigger.kind === 'once' && <OnceTime trigger={trigger} onChange={onChange} />}
          {ordinary && trigger.kind === 'cron' && !advancedOpen && (
            <>
              <Label htmlFor="schedule-days">Days</Label>
              <Select
                value={parts[4]}
                onValueChange={value => {
                  if (value) onChange({ ...trigger, expression: `${parts[0]} ${parts[1]} * * ${value}` });
                }}
              >
                <SelectTrigger id="schedule-days">
                  <SelectValue>{cronDayChoices.find(([option]) => option === parts[4])?.[1] ?? parts[4]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {cronDayChoices.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Label htmlFor="schedule-time">Time</Label>
              <Input
                id="schedule-time"
                type="time"
                value={`${parts[1]?.padStart(2, '0')}:${parts[0]?.padStart(2, '0')}`}
                onChange={event => {
                  const [hour, minute] = event.target.value.split(':');
                  if (hour && minute)
                    onChange({ ...trigger, expression: `${Number(minute)} ${Number(hour)} * * ${parts[4]}` });
                }}
              />
              <TimeZone
                id="schedule-zone"
                value={trigger.timezone}
                onChange={timezone => onChange({ ...trigger, timezone })}
              />
              <p className="text-sm text-muted-foreground">
                {parts[4] === '*'
                  ? 'Every day'
                  : parts[4] === '1-5'
                    ? 'Every weekday'
                    : `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][Number(parts[4])]}`}{' '}
                at {parts[1]?.padStart(2, '0')}:{parts[0]?.padStart(2, '0')} in {trigger.timezone.replaceAll('_', ' ')}.
              </p>
            </>
          )}
          {rowShown && (
            <RowChange
              workspaceId={workspaceId}
              trigger={trigger.kind === 'row' ? trigger : null}
              onChange={next => {
                setRowPending(false);
                onChange(next);
              }}
              onValidityChange={onValidityChange}
            />
          )}
          {(trigger.kind === 'once' || trigger.kind === 'interval' || trigger.kind === 'cron') && (
            <p className="text-sm text-muted-foreground">
              Each scheduled run starts with the input {'{ "scheduledFor": "<scheduled time>" }'}. Steps read it as the
              workflow input, field scheduledFor.
            </p>
          )}
        </>
      )}
      <Disclosure title="Advanced triggers" open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <div className="space-y-3">
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => choose({ kind: 'webhook' })}>
              Webhook
            </Button>
            <Button variant="outline" onClick={() => choose({ kind: 'event', name: 'request_submitted' })}>
              App event
            </Button>
          </div>
          {trigger.kind === 'event' && (
            <>
              <Label htmlFor="event">Event name</Label>
              <Input
                id="event"
                value={trigger.name}
                onChange={event => onChange({ ...trigger, name: event.target.value })}
              />
            </>
          )}
          {trigger.kind === 'cron' && cronFeedback && (
            <>
              <Label htmlFor="cron">Cron expression</Label>
              <Input
                id="cron"
                value={trigger.expression}
                aria-invalid={cronFeedback.field === 'expression'}
                aria-describedby="cron-help"
                onChange={event => updateCron({ ...trigger, expression: event.target.value })}
              />
              <Label htmlFor="timezone">IANA time zone</Label>
              <Input
                id="timezone"
                value={trigger.timezone}
                aria-invalid={cronFeedback.field === 'timezone'}
                aria-describedby="cron-help"
                onChange={event => updateCron({ ...trigger, timezone: event.target.value })}
              />
              {cronFeedback.problem ? (
                <p id="cron-help" role="alert">
                  {cronFeedback.problem}
                </p>
              ) : (
                <>
                  <p id="cron-help" className="text-sm text-muted-foreground">
                    Next three runs in {trigger.timezone.replaceAll('_', ' ')}:
                  </p>
                  <ol className="list-inside list-decimal space-y-1 text-sm">
                    {cronFeedback.runs.map(run => (
                      <li key={run}>
                        <time dateTime={run}>
                          {new Date(run).toLocaleString(undefined, {
                            timeZone: trigger.timezone,
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                            timeZoneName: 'short',
                          })}
                        </time>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </>
          )}
          {trigger.kind === 'webhook' && (
            <fieldset className="space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="webhook-raw"
                  checked={!!trigger.payload}
                  onCheckedChange={checked =>
                    changeWebhookPayload(checked ? { mode: 'raw', dedupe: { source: 'hash' } } : undefined)
                  }
                />
                <Label htmlFor="webhook-raw">Use the provider payload as the workflow input</Label>
              </div>
              {trigger.payload && (
                <>
                  <p className="text-sm text-muted-foreground">
                    Raw mode passes the request body to the workflow without the TulipFarm request envelope. Choose how
                    retries identify the same event.
                  </p>
                  <Label htmlFor="webhook-dedupe">Retry identity</Label>
                  <Select
                    value={trigger.payload.dedupe.source}
                    onValueChange={source => {
                      const dedupe =
                        source === 'header'
                          ? { source, name: 'x-github-delivery' }
                          : source === 'body'
                            ? { source, path: ['id'] }
                            : { source: 'hash' as const };
                      changeWebhookPayload({ ...trigger.payload, mode: 'raw', dedupe });
                    }}
                  >
                    <SelectTrigger id="webhook-dedupe">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="header">Request header</SelectItem>
                      <SelectItem value="body">Body field</SelectItem>
                      <SelectItem value="hash">Identical body</SelectItem>
                    </SelectContent>
                  </Select>
                  {trigger.payload.dedupe.source === 'header' && (
                    <>
                      <Label htmlFor="webhook-dedupe-header">Header name</Label>
                      <Input
                        id="webhook-dedupe-header"
                        value={trigger.payload.dedupe.name}
                        aria-invalid={!rawWebhookSchema.safeParse(trigger.payload).success}
                        onChange={event =>
                          changeWebhookPayload({
                            ...trigger.payload,
                            mode: 'raw',
                            dedupe: { source: 'header', name: event.target.value.trim().toLowerCase() },
                          })
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        For GitHub, use x-github-delivery. The same value makes a provider retry return its original
                        run.
                      </p>
                    </>
                  )}
                  {trigger.payload.dedupe.source === 'body' && (
                    <>
                      <Label htmlFor="webhook-dedupe-path">Body field path</Label>
                      <Input
                        id="webhook-dedupe-path"
                        value={trigger.payload.dedupe.path.join('.')}
                        aria-invalid={!rawWebhookSchema.safeParse(trigger.payload).success}
                        onChange={event =>
                          changeWebhookPayload({
                            ...trigger.payload,
                            mode: 'raw',
                            dedupe: { source: 'body', path: event.target.value.split('.').map(part => part.trim()) },
                          })
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        Use periods between field names, such as id or data.object.id for a Stripe event.
                      </p>
                    </>
                  )}
                </>
              )}
            </fieldset>
          )}
        </div>
      </Disclosure>
    </fieldset>
  );
}

const localInput = (time: number) =>
  new Date(time - new Date(time).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function TimeZone({ id, value, onChange }: { id: string; value: string; onChange: (zone: string) => void }) {
  return (
    <>
      <Label htmlFor={id}>Time zone</Label>
      <Select
        value={value}
        onValueChange={next => {
          if (next) onChange(next);
        }}
      >
        <SelectTrigger id={id}>
          <SelectValue>{value.replaceAll('_', ' ')}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {[...new Set([value, 'UTC', ...Intl.supportedValuesOf('timeZone')])].map(zone => (
            <SelectItem key={zone} value={zone}>
              {zone.replaceAll('_', ' ')}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}

type RecordTrigger = Extract<Definition['trigger'], { kind: 'record' }>;
type RecordField = RecordTrigger['field'];
const recordIncomplete = 'Choose a table and a date or timestamp field for the record date trigger before saving.';
const recordUnits = { date: ['days', 'weeks'], timestamp: ['minutes', 'hours', 'days'] } as const;
const recordUnitMax = { minutes: 527040, hours: 8784, days: 366, weeks: 52 } as const;
type TableField = TableDefinition['definition']['fields'][number];
const dateLike = (field: TableField): field is Extract<TableField, { kind: RecordField['kind'] }> =>
  field.kind === 'date' || field.kind === 'timestamp';
const recordDefault = (kind: RecordField['kind'], fieldId: string): RecordField =>
  kind === 'date'
    ? {
        kind,
        fieldId,
        offset: { direction: 'before', amount: 1, unit: 'days' },
        time: '09:00',
        timezone: browserZone(),
      }
    : { kind, fieldId, offset: { direction: 'before', amount: 1, unit: 'hours' } };

function withOffset(
  field: RecordField,
  change: { direction?: 'before' | 'after'; amount?: number; unit?: string },
): RecordField | null {
  const offset = {
      direction: change.direction ?? field.offset.direction,
      amount: change.amount ?? field.offset.amount,
    },
    wanted = change.unit ?? field.offset.unit;
  if (field.kind === 'date') {
    const unit = recordUnits.date.find(item => item === wanted);
    return unit ? { ...field, offset: { ...offset, unit } } : null;
  }
  const unit = recordUnits.timestamp.find(item => item === wanted);
  return unit ? { ...field, offset: { ...offset, unit } } : null;
}

type RecordFilter = NonNullable<RecordTrigger['filter']>;
type FilterValue = Extract<RecordFilter, { value: unknown }>['value'];
type FilterValueField = Extract<TableField, { kind: FilterValue['kind'] }>;
type ValueFilter = Extract<RecordFilter, { value: unknown }>;
const hasValue = (filter: RecordFilter): filter is ValueFilter => 'value' in filter;
const hasFilterValue = (field: TableField): field is FilterValueField =>
  field.kind === 'text' ||
  field.kind === 'numeric' ||
  field.kind === 'boolean' ||
  field.kind === 'date' ||
  field.kind === 'timestamp' ||
  (field.kind === 'single-select' && field.options.some(option => !option.retired));
const filterDefault = (field: FilterValueField): FilterValue =>
  field.kind === 'text'
    ? { kind: 'text', value: '' }
    : field.kind === 'numeric'
      ? { kind: 'numeric', value: '0' }
      : field.kind === 'boolean'
        ? { kind: 'boolean', value: true }
        : field.kind === 'date'
          ? { kind: 'date', value: new Date().toISOString().slice(0, 10) }
          : field.kind === 'timestamp'
            ? { kind: 'timestamp', value: new Date().toISOString() }
            : { kind: 'single-select', optionId: field.options.find(option => !option.retired)?.id ?? '' };
const filterForField = (field: TableField): RecordFilter =>
  hasFilterValue(field)
    ? { fieldId: field.id, match: 'is', value: filterDefault(field) }
    : { fieldId: field.id, match: 'is-empty' };
function filterUsable(fields: TableField[], filter: RecordFilter) {
  const field = fields.find(item => item.id === filter.fieldId);
  if (!field || !('value' in filter)) return !!field;
  const { value } = filter;
  return (
    field.kind === value.kind &&
    (value.kind !== 'single-select' ||
      (field.kind === 'single-select' && field.options.some(option => option.id === value.optionId && !option.retired)))
  );
}
const filterUnusable =
  'The saved filter’s field or value is no longer in this table. Choose another filter, or run for all records.';
const numericFilterValue = /^-?\d{1,40}(\.\d{1,40})?$/;
const dateFilterValue = (value: string) => {
  const time = Date.parse(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(time) && new Date(time).toISOString().startsWith(value);
};
function filterProblem(fields: TableField[], filter: RecordFilter | undefined) {
  if (!filter) return undefined;
  if (!filterUsable(fields, filter)) return filterUnusable;
  if (!hasValue(filter)) return undefined;
  if (filter.value.kind === 'text' && filter.value.value === '')
    return 'Enter the text the record filter matches before saving.';
  if (filter.value.kind === 'numeric' && !numericFilterValue.test(filter.value.value))
    return 'Enter a number the record filter matches before saving.';
  if (filter.value.kind === 'date' && !dateFilterValue(filter.value.value))
    return 'Enter a date the record filter matches before saving.';
  return undefined;
}
function filterValueLabel(field: TableField | undefined, filter: RecordFilter) {
  if (!('value' in filter)) return null;
  const { value } = filter;
  switch (value.kind) {
    case 'text':
      return `“${value.value}”`;
    case 'boolean':
      return value.value ? 'Yes' : 'No';
    case 'single-select':
      return field?.kind === 'single-select'
        ? (field.options.find(option => option.id === value.optionId)?.label ?? 'an unavailable option')
        : 'an unavailable option';
    default:
      return value.value;
  }
}
function valueFilter(fieldId: string, match: string, value: FilterValue): ValueFilter {
  if (match === 'is' || match === 'is-not') return { fieldId, match, value };
  if (
    (match === 'lt' || match === 'lte' || match === 'gt' || match === 'gte') &&
    (value.kind === 'numeric' || value.kind === 'date' || value.kind === 'timestamp')
  )
    return { fieldId, match, value };
  throw new Error('Unsupported record filter comparison');
}
function RecordFilterControls({
  fields,
  filter,
  onChange,
}: {
  fields: TableField[];
  filter: RecordFilter | undefined;
  onChange: (filter: RecordFilter | undefined) => void;
}) {
  const [edited, setEdited] = useState(false);
  const usable = !filter || filterUsable(fields, filter);
  const field = fields.find(item => item.id === filter?.fieldId);
  const value = filter && hasValue(filter) ? filter.value : undefined;
  const valueError = filterProblem(fields, filter);
  const changeValue = (value: FilterValue) => {
    if (!filter || !hasValue(filter)) throw new Error('Record filter has no value');
    onChange(valueFilter(filter.fieldId, filter.match, value));
  };
  if (!filter && !fields.length)
    return (
      <p className="text-sm text-muted-foreground">
        Runs for every record. Add a field to this table to limit which records run.
      </p>
    );
  const matches =
    field && hasFilterValue(field)
      ? field.kind === 'numeric' || field.kind === 'date' || field.kind === 'timestamp'
        ? [
            ['is', 'Is'],
            ['is-not', 'Is not'],
            ['lt', 'Is less than'],
            ['lte', 'Is at most'],
            ['gt', 'Is greater than'],
            ['gte', 'Is at least'],
            ['is-empty', 'Is empty'],
            ['is-not-empty', 'Is not empty'],
          ]
        : [
            ['is', 'Is'],
            ['is-not', 'Is not'],
            ['is-empty', 'Is empty'],
            ['is-not-empty', 'Is not empty'],
          ]
      : [
          ['is-empty', 'Is empty'],
          ['is-not-empty', 'Is not empty'],
        ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field id="record-filter-field" label="Only records where" optional>
          <Select
            value={field ? field.id : ''}
            onValueChange={value => {
              const next = fields.find(item => item.id === (value ?? ''));
              setEdited(false);
              onChange(next ? filterForField(next) : undefined);
            }}
          >
            <SelectTrigger>
              <SelectValue>{field?.label ?? 'All records'}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">All records</SelectItem>
              {fields.map(item => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {filter && field && (
          <>
            <Field id="record-filter-match" label="Match" required>
              <Select
                value={filter.match}
                onValueChange={next => {
                  const match = next ?? '';
                  if (match === 'is-empty' || match === 'is-not-empty') onChange({ fieldId: filter.fieldId, match });
                  else if (hasFilterValue(field))
                    onChange(
                      valueFilter(
                        filter.fieldId,
                        match,
                        value && value.kind === field.kind ? value : filterDefault(field),
                      ),
                    );
                }}
              >
                <SelectTrigger>
                  <SelectValue>{matches.find(([match]) => match === filter.match)?.[1] ?? filter.match}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {matches.map(([match, label]) => (
                    <SelectItem key={match} value={match}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {value && field.kind === 'text' && value.kind === 'text' && (
              <Field
                id="record-filter-value"
                label="Value"
                required
                error={edited && value.value === '' ? 'Enter the text to match.' : undefined}
              >
                <Input
                  value={value.value}
                  maxLength={field.maxLength}
                  onChange={event => {
                    setEdited(true);
                    changeValue({ kind: 'text', value: event.target.value });
                  }}
                />
              </Field>
            )}
            {value && field.kind === 'boolean' && value.kind === 'boolean' && (
              <Field id="record-filter-value" label="Value" required>
                <Select
                  value={value.value ? 'yes' : 'no'}
                  onValueChange={next => {
                    if (next) changeValue({ kind: 'boolean', value: next === 'yes' });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue>{value.value ? 'Yes' : 'No'}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="yes">Yes</SelectItem>
                    <SelectItem value="no">No</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}
            {value && field.kind === 'single-select' && value.kind === 'single-select' && (
              <Field id="record-filter-value" label="Value" required>
                <Select
                  value={value.optionId}
                  onValueChange={optionId => {
                    if (optionId) changeValue({ kind: 'single-select', optionId });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue>
                      {field.options.find(option => option.id === value.optionId)?.label ?? value.optionId}
                      {field.options.find(option => option.id === value.optionId)?.retired ? ' (retired)' : ''}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {field.options
                      .filter(option => !option.retired || option.id === value.optionId)
                      .map(option => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.label}
                          {option.retired ? ' (retired)' : ''}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            {value && field.kind === 'numeric' && value.kind === 'numeric' && (
              <Field id="record-filter-value" label="Value" required error={edited ? valueError : undefined}>
                <Input
                  inputMode="decimal"
                  value={value.value}
                  onChange={event => {
                    setEdited(true);
                    changeValue({ kind: 'numeric', value: event.target.value });
                  }}
                />
              </Field>
            )}
            {value && field.kind === 'date' && value.kind === 'date' && (
              <Field id="record-filter-value" label="Value" required error={edited ? valueError : undefined}>
                <Input
                  type="date"
                  value={value.value}
                  onChange={event => {
                    setEdited(true);
                    changeValue({ kind: 'date', value: event.target.value });
                  }}
                />
              </Field>
            )}
            {value && field.kind === 'timestamp' && value.kind === 'timestamp' && (
              <Field id="record-filter-value" label="Value" required>
                <Input
                  type="datetime-local"
                  value={zonedInput(Date.parse(value.value), browserZone())}
                  onChange={event => {
                    const time = new Date(event.target.value).getTime();
                    if (Number.isFinite(time)) changeValue({ kind: 'timestamp', value: new Date(time).toISOString() });
                  }}
                />
              </Field>
            )}
          </>
        )}
      </div>
      {!usable && (
        <>
          <Alert variant="destructive">
            <AlertDescription>{filterUnusable}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={() => onChange(undefined)}>
            Run for all records
          </Button>
        </>
      )}
      {filter && field && value && usable && (
        <p className="text-sm text-muted-foreground">
          Runs only for records where {field.label} {filterPhrase(filter, filterValueLabel(field, filter))}.
          {filter.match === 'is-not' ? ` Records with no ${field.label} also run.` : ''}
        </p>
      )}
    </div>
  );
}

function RecordDate({
  workspaceId,
  trigger,
  onChange,
  onValidityChange,
}: {
  workspaceId: string;
  trigger: RecordTrigger | null;
  onChange: (trigger: RecordTrigger) => void;
  onValidityChange?: ((valid: boolean, problem?: string) => void) | undefined;
}) {
  const api = useMemo(() => tableApi(workspaceId), [workspaceId]);
  const read = useTablePicker(api);
  const { workspace } = workspaceRoute.useRouteContext();
  const [pendingTable, setPendingTable] = useState('');
  const [amountText, setAmountText] = useState<string | null>(null);
  const tables =
    read.state.kind === 'ready' ? read.state.data.filter(item => item.definition.fields.some(dateLike)) : [];
  const tableId = trigger?.tableId ?? pendingTable;
  const table = tables.find(item => item.id === tableId);
  const fields = table?.definition.fields.filter(dateLike) ?? [];
  const field = trigger?.field,
    chosen = fields.find(item => item.id === field?.fieldId);
  const max = field ? recordUnitMax[field.offset.unit] : 0;
  const amountShown = amountText ?? String(field?.offset.amount ?? '');
  const amountValid = /^\d+$/.test(amountShown) && Number(amountShown) <= max;
  const keptFilter = trigger?.filter ? { filter: trigger.filter } : {};
  const tableFields = table?.definition.fields ?? [];
  const report = (problem: string | undefined) => onValidityChange?.(!problem, problem);
  const update = (next: RecordField | null) => {
    if (!next) return;
    setAmountText(null);
    report(filterProblem(tableFields, trigger?.filter));
    onChange({ kind: 'record', tableId, field: next, ...keptFilter });
  };
  const chooseTable = (id: string) => {
    const next = tables.find(item => item.id === id)?.definition.fields.filter(dateLike);
    const kept = next?.find(item => item.kind === field?.kind) ?? next?.[0];
    setPendingTable(id);
    setAmountText(null);
    // Once saved as a record trigger, the draft stays complete by moving to a matching field of the new table.
    if (trigger && kept) {
      report(undefined);
      onChange({
        kind: 'record',
        tableId: id,
        field: field && kept.kind === field.kind ? { ...field, fieldId: kept.id } : recordDefault(kept.kind, kept.id),
      });
    }
  };
  const chooseField = (id: string) => {
    const next = fields.find(item => item.id === id);
    if (next) update(field && field.kind === next.kind ? { ...field, fieldId: id } : recordDefault(next.kind, id));
  };
  const chooseFilter = (filter: RecordFilter | undefined) => {
    if (!trigger) return;
    report(
      amountValid
        ? filterProblem(tableFields, filter)
        : `Enter a record offset from 0 to ${max} ${trigger.field.offset.unit} before saving.`,
    );
    onChange({ kind: 'record', tableId: trigger.tableId, field: trigger.field, ...(filter ? { filter } : {}) });
  };
  const explanation = (
    <p className="text-sm text-muted-foreground">
      Each run starts with the input {'{ "tableId", "recordId", "token", "scheduledFor", "values" }'}, where values
      holds the record’s fields by field ID and token lets an update step change this record. It runs once per record
      occurrence. Editing a record’s date reschedules its run, deleted records drop out, and only occurrences after
      activation run. An occurrence held back more than a day, for example by run limits, is recorded as missed and does
      not run.
    </p>
  );
  if (read.state.kind === 'loading')
    return (
      <StatePanel
        kind="loading"
        heading="h3"
        title="Loading tables"
        description="Finding tables with a date or timestamp field."
      />
    );
  if (read.state.kind === 'unavailable')
    return (
      <StatePanel
        kind="unavailable"
        heading="h3"
        title="Tables unavailable"
        description="You cannot list tables in this workspace. A workspace admin can grant table access. Choose another trigger meanwhile."
      />
    );
  if (read.state.kind === 'error')
    return (
      <StatePanel
        kind="error"
        heading="h3"
        title="We couldn’t load tables"
        description="The record date trigger needs your table list. Your draft is retained."
      >
        <Button variant="outline" onClick={() => void read.refresh()}>
          Retry table choices
        </Button>
      </StatePanel>
    );
  if (!tables.length)
    return (
      <StatePanel
        kind="empty"
        heading="h3"
        title="No tables with a date or timestamp field are available to you"
        description="Add a date field to a table in chat, or ask an admin for table access."
      >
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link to="/$workspaceSlug/tables" params={{ workspaceSlug: workspace.slug }} />}
        >
          Open tables
        </Button>
      </StatePanel>
    );
  return (
    <div className="space-y-3">
      <Field
        id="record-table"
        label="Table"
        required
        helper="Only tables you can read that have a date or timestamp field are listed."
      >
        <Select
          value={table ? tableId : ''}
          onValueChange={id => {
            if (id) chooseTable(id);
          }}
        >
          <SelectTrigger>
            <SelectValue>{table?.definition.label ?? 'Choose a table'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="" disabled>
              Choose a table
            </SelectItem>
            {tables.map(item => (
              <SelectItem key={item.id} value={item.id}>
                {item.definition.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {trigger && (!table || !chosen) && (
        <Alert variant="destructive">
          <AlertDescription>
            The saved table or field is no longer available to you or changed kind. Choose another table and field.
          </AlertDescription>
        </Alert>
      )}
      {table && (
        <Field id="record-field" label="Date field" required>
          <Select
            value={chosen ? chosen.id : ''}
            onValueChange={id => {
              if (id) chooseField(id);
            }}
          >
            <SelectTrigger>
              <SelectValue>
                {chosen ? `${chosen.label} (${chosen.kind === 'date' ? 'date' : 'date and time'})` : 'Choose a field'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="" disabled>
                Choose a field
              </SelectItem>
              {fields.map(item => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label} ({item.kind === 'date' ? 'date' : 'date and time'})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      {!trigger && (
        <p className="text-sm text-muted-foreground">
          Choose a table and a date or timestamp field to use this trigger. The workflow keeps its previous trigger
          until then.
        </p>
      )}
      {field && (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-28">
              <Field id="record-amount" label="Offset" required error={amountValid ? undefined : `Enter 0 to ${max}.`}>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={max}
                  step={1}
                  value={amountShown}
                  onChange={event => {
                    const value = event.target.value,
                      amount = Number(value);
                    if (/^\d+$/.test(value) && amount <= max) update(withOffset(field, { amount }));
                    else {
                      onValidityChange?.(
                        false,
                        `Enter a record offset from 0 to ${max} ${field.offset.unit} before saving.`,
                      );
                      setAmountText(value);
                    }
                  }}
                />
              </Field>
            </div>
            <Field id="record-unit" label="Unit" required>
              <Select
                value={field.offset.unit}
                onValueChange={value => {
                  const unit = recordUnits[field.kind].find(item => item === value);
                  if (unit)
                    update(
                      withOffset(field, {
                        unit,
                        amount: Math.min(amountValid ? Number(amountShown) : 1, recordUnitMax[unit]),
                      }),
                    );
                }}
              >
                <SelectTrigger>
                  <SelectValue>
                    {field.offset.unit[0]?.toUpperCase()}
                    {field.offset.unit.slice(1)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {recordUnits[field.kind].map(unit => (
                    <SelectItem key={unit} value={unit}>
                      {unit[0]?.toUpperCase()}
                      {unit.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="record-direction" label="Before or after" required>
              <Select
                value={field.offset.direction}
                onValueChange={value => {
                  if (value === 'before' || value === 'after') update(withOffset(field, { direction: value }));
                }}
              >
                <SelectTrigger>
                  <SelectValue>{field.offset.direction === 'before' ? 'Before' : 'After'}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="before">Before</SelectItem>
                  <SelectItem value="after">After</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          {field.kind === 'date' && (
            <>
              <Field id="record-time" label="Time" required>
                <Input
                  type="time"
                  value={field.time}
                  onChange={event => {
                    if (/^\d\d:\d\d$/.test(event.target.value)) update({ ...field, time: event.target.value });
                  }}
                />
              </Field>
              <TimeZone id="record-zone" value={field.timezone} onChange={timezone => update({ ...field, timezone })} />
            </>
          )}
          <p className="text-sm text-muted-foreground">
            Runs {recordScheduleDescription(field, chosen?.label).replace(/^./, letter => letter.toLowerCase())}. The
            longest offset is 366 days.
            {amountValid
              ? ''
              : ` Until you enter a whole number from 0 to ${max}, the trigger keeps its last valid offset of ${field.offset.amount} ${field.offset.unit}.`}
          </p>
          {table && trigger && (
            <RecordFilterControls fields={table.definition.fields} filter={trigger.filter} onChange={chooseFilter} />
          )}
        </>
      )}
      {explanation}
    </div>
  );
}

type RowTrigger = Extract<Definition['trigger'], { kind: 'row' }>;
const rowIncomplete = 'Choose a table for the row change trigger before saving.';

function RowChange({
  workspaceId,
  trigger,
  onChange,
  onValidityChange,
}: {
  workspaceId: string;
  trigger: RowTrigger | null;
  onChange: (trigger: RowTrigger) => void;
  onValidityChange?: ((valid: boolean, problem?: string) => void) | undefined;
}) {
  const api = useMemo(() => tableApi(workspaceId), [workspaceId]);
  const read = useTablePicker(api);
  const [pendingTable, setPendingTable] = useState('');
  if (read.state.kind === 'loading')
    return (
      <StatePanel
        kind="loading"
        heading="h3"
        title="Loading tables"
        description="Finding a table for this row change trigger."
      />
    );
  if (read.state.kind === 'unavailable')
    return (
      <StatePanel
        kind="unavailable"
        heading="h3"
        title="Tables unavailable"
        description="You cannot list tables in this workspace. A workspace admin can grant table access. Choose another trigger meanwhile."
      />
    );
  if (read.state.kind === 'error')
    return (
      <StatePanel
        kind="error"
        heading="h3"
        title="We couldn’t load tables"
        description="The row change trigger needs your table list. Your draft is retained."
      >
        <Button variant="outline" onClick={() => void read.refresh()}>
          Retry table choices
        </Button>
      </StatePanel>
    );
  const tables = read.state.data;
  if (!tables.length)
    return (
      <p className="text-sm text-muted-foreground">
        No tables are available to watch. Add a table in chat or ask an admin for table access.
      </p>
    );
  const tableId = trigger?.tableId ?? pendingTable;
  const table = tables.find(item => item.id === tableId);
  const fields = table?.definition.fields ?? [];
  const event = trigger?.event ?? 'updated';
  const chooseTable = (id: string) => {
    const table = tables.find(item => item.id === id);
    if (!table) return;
    setPendingTable(id);
    onValidityChange?.(true);
    onChange({ kind: 'row', tableId: table.id, event });
  };
  const update = (change: Partial<RowTrigger>) => {
    if (!trigger) return;
    const next = { ...trigger, ...change };
    if (next.event !== 'updated') delete next.fieldIds;
    if (next.fieldIds?.length === 0) delete next.fieldIds;
    const problem = filterProblem(fields, next.filter);
    onValidityChange?.(!problem, problem);
    onChange(next);
  };
  const watched = new Set(trigger?.fieldIds ?? []);
  const toggleField = (fieldId: string, checked: boolean) => {
    const next = new Set(watched);
    if (checked) next.add(fieldId);
    else next.delete(fieldId);
    update({ fieldIds: [...next] });
  };
  const label = (fieldId: string) => fields.find(item => item.id === fieldId)?.label ?? `field ${fieldId.slice(0, 8)}`;
  return (
    <section aria-label="Row change trigger" className="space-y-3">
      <Field id="row-table" label="Table" required>
        <Select
          value={table ? tableId : ''}
          onValueChange={id => {
            if (id) chooseTable(id);
          }}
        >
          <SelectTrigger>
            <SelectValue>{table?.definition.label ?? 'Choose a table'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="" disabled>
              Choose a table
            </SelectItem>
            {tables.map(item => (
              <SelectItem key={item.id} value={item.id}>
                {item.definition.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {trigger && !table && (
        <Alert variant="destructive">
          <AlertDescription>The saved table is no longer available to you. Choose another table.</AlertDescription>
        </Alert>
      )}
      {table && trigger && (
        <>
          <Field id="row-event" label="Event" required>
            <Select
              value={trigger.event}
              onValueChange={value => {
                if (value === 'created' || value === 'updated' || value === 'deleted') update({ event: value });
              }}
            >
              <SelectTrigger>
                <SelectValue>
                  {trigger.event === 'created'
                    ? 'A row is created'
                    : trigger.event === 'updated'
                      ? 'A row is updated'
                      : 'A row is deleted'}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="created">A row is created</SelectItem>
                <SelectItem value="updated">A row is updated</SelectItem>
                <SelectItem value="deleted">A row is deleted</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {event === 'updated' && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">
                Watched fields <span className="font-normal text-muted-foreground">(optional)</span>
              </legend>
              <p className="text-sm text-muted-foreground">Leave all fields unchecked to run for every update.</p>
              {fields.map(field => (
                <Label key={field.id}>
                  <Checkbox
                    checked={watched.has(field.id)}
                    onCheckedChange={checked => toggleField(field.id, checked === true)}
                  />
                  {field.label}
                </Label>
              ))}
            </fieldset>
          )}
          <RecordFilterControls
            fields={fields}
            filter={trigger.filter}
            onChange={filter => update(filter ? { filter } : { filter: undefined })}
          />
          <p className="text-sm text-muted-foreground">
            Runs within about a minute after a row of “{table.definition.label}” is {trigger.event}
            {trigger.fieldIds ? `, when ${trigger.fieldIds.map(label).join(' or ')} changed` : ''}. Each run starts with
            the input{' '}
            {trigger.event === 'deleted'
              ? '{ "event", "tableId", "recordId", "changedAt", "values" }'
              : '{ "event", "tableId", "recordId", "token", "changedAt", "values" }'}
            {trigger.event === 'updated' ? ', plus "changedFieldIds" and "previousValues"' : ''}.
          </p>
        </>
      )}
      {!trigger && (
        <p className="text-sm text-muted-foreground">
          Choose a table to use this trigger. The workflow keeps its previous trigger until then.
        </p>
      )}
    </section>
  );
}

export function onceInPast(trigger: Definition['trigger']) {
  return trigger.kind === 'once' && Date.parse(trigger.at) <= Date.now();
}

function OnceTime({
  trigger,
  onChange,
}: {
  trigger: Extract<Definition['trigger'], { kind: 'once' }>;
  onChange: (trigger: Definition['trigger']) => void;
}) {
  const time = Date.parse(trigger.at);
  const known = Number.isFinite(time);
  const past = known && time <= Date.now();
  const local = browserZone();
  const zone = trigger.timezone ?? local;
  const spoken = (timeZone: string) =>
    new Date(time).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short', timeZone });
  const choose = (value: string, timezone: string) => {
    const next = fromZonedInput(value, timezone);
    if (Number.isFinite(next)) onChange({ kind: 'once', at: new Date(next).toISOString(), timezone });
  };
  return (
    <>
      <Label htmlFor="once">Date and time</Label>
      <Input
        id="once"
        type="datetime-local"
        min={zonedInput(Date.now(), zone)}
        value={known ? zonedInput(time, zone) : ''}
        aria-invalid={past}
        aria-describedby="once-instant"
        onChange={event => choose(event.target.value, zone)}
      />
      <TimeZone
        id="once-zone"
        value={zone}
        onChange={timezone => (known ? choose(zonedInput(time, zone), timezone) : onChange({ ...trigger, timezone }))}
      />
      {known && (
        <p id="once-instant" className="text-sm text-muted-foreground">
          {zone === local
            ? `Runs once on ${spoken(zone)} in your time zone, ${zone.replaceAll('_', ' ')}.`
            : `Runs once on ${spoken(zone)} in ${zone.replaceAll('_', ' ')}. That is ${spoken(local)} in your time zone, ${local.replaceAll('_', ' ')}.`}{' '}
          Saved as {new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC.
        </p>
      )}
      {past && <p role="alert">This time has passed. Choose a future date and time before saving.</p>}
    </>
  );
}

const unitSeconds = { days: 86400, hours: 3600, minutes: 60, seconds: 1 } as const;
type DelayUnit = keyof typeof unitSeconds;
const delayUnits: DelayUnit[] = ['seconds', 'minutes', 'hours', 'days'];
const largestFirst: DelayUnit[] = ['days', 'hours', 'minutes', 'seconds'];
const maxDelaySeconds = maxWaitSeconds;
const fittingUnit = (seconds: number) => largestFirst.find(unit => seconds % unitSeconds[unit] === 0) ?? 'seconds';

export function delayDescription(seconds: number) {
  let rest = seconds;
  const parts = [];
  for (const unit of largestFirst) {
    const count = Math.floor(rest / unitSeconds[unit]);
    rest -= count * unitSeconds[unit];
    if (count) parts.push(`${count} ${count === 1 ? unit.slice(0, -1) : unit}`);
  }
  return parts.join(' ');
}

export function DelayDuration({
  id,
  seconds,
  disabled,
  onChange,
  onValidityChange,
}: {
  id: string;
  seconds: number;
  disabled: boolean;
  onChange: (seconds: number) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const [chosen, setChosen] = useState<DelayUnit>(() => fittingUnit(seconds));
  const [text, setText] = useState<string | null>(null);
  const unit = seconds % unitSeconds[chosen] === 0 ? chosen : fittingUnit(seconds);
  const max = Math.floor(maxDelaySeconds / unitSeconds[unit]);
  const shown = text ?? String(seconds / unitSeconds[unit]);
  const valid = /^\d+$/.test(shown) && Number(shown) >= 1 && Number(shown) <= max;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-32 space-y-1">
          <Label htmlFor={`delay-${id}`}>Wait length</Label>
          <Input
            id={`delay-${id}`}
            type="number"
            inputMode="numeric"
            min={1}
            max={max}
            step={1}
            value={shown}
            disabled={disabled}
            aria-invalid={!valid}
            aria-describedby={`delay-help-${id}`}
            onChange={event => {
              const value = event.target.value,
                amount = Number(value);
              if (/^\d+$/.test(value) && amount >= 1 && amount <= max) {
                onValidityChange?.(true);
                setChosen(unit);
                setText(null);
                onChange(amount * unitSeconds[unit]);
              } else {
                onValidityChange?.(false);
                setText(value);
              }
            }}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`delay-unit-${id}`}>Unit</Label>
          <Select
            value={unit}
            disabled={disabled}
            onValueChange={value => {
              const next = delayUnits.find(item => item === value);
              if (!next) return;
              const amount = Math.min(Math.floor(maxDelaySeconds / unitSeconds[next]), valid ? Number(shown) : 1);
              onValidityChange?.(true);
              setChosen(next);
              setText(null);
              onChange(amount * unitSeconds[next]);
            }}
          >
            <SelectTrigger id={`delay-unit-${id}`}>
              <SelectValue>
                {unit[0]?.toUpperCase()}
                {unit.slice(1)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {delayUnits.map(item => (
                <SelectItem key={item} value={item}>
                  {item[0]?.toUpperCase()}
                  {item.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <p id={`delay-help-${id}`} className="text-sm text-muted-foreground">
        Waits {delayDescription(seconds)} before the next step. The longest wait is {delayDescription(maxDelaySeconds)}.
      </p>
      {!valid && (
        <p role="alert">
          Enter a whole number from 1 to {max}. The step keeps its last valid wait of {delayDescription(seconds)}.
        </p>
      )}
    </div>
  );
}

type WaitUntilStep = Extract<Definition['steps'][number], { kind: 'wait-until' }>;

export function waitUntilTooFar(at: WaitUntilStep['at'], now = Date.now()) {
  return at.kind === 'literal' && typeof at.value === 'string' && Date.parse(at.value) - now > maxWaitSeconds * 1000;
}

export function WaitUntil({
  step,
  earlier,
  disabled,
  onChange,
}: {
  step: WaitUntilStep;
  earlier: Definition['steps'];
  disabled: boolean;
  onChange: (at: WaitUntilStep['at']) => void;
}) {
  const at = step.at;
  const sources = earlier.filter(previous => previous.kind !== 'delay' && previous.kind !== 'wait-until');
  const source = at.kind === 'step' ? `step:${at.step}` : at.kind;
  const fixed = at.kind === 'literal' && typeof at.value === 'string' ? Date.parse(at.value) : NaN;
  const known = Number.isFinite(fixed);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll('_', ' ');
  const number = earlier.length + 1;
  const choose = (value: string) => {
    const kept = at.kind === 'literal' ? [] : at.path;
    if (value === 'literal')
      onChange({ kind: 'literal', value: new Date(Math.ceil((Date.now() + 86400000) / 60000) * 60000).toISOString() });
    else if (value === 'input') onChange({ kind: 'input', path: kept });
    else onChange({ kind: 'step', step: value.slice('step:'.length), path: kept });
  };
  return (
    <div className="space-y-3">
      <Field id={`wait-until-source-${step.id}`} label={`Date source for step ${number}`} required disabled={disabled}>
        <Select
          value={source}
          onValueChange={value => {
            if (value) choose(value);
          }}
        >
          <SelectTrigger>
            <SelectValue>
              {at.kind === 'literal'
                ? 'A fixed date and time'
                : at.kind === 'input'
                  ? 'The workflow input'
                  : `The output of ${at.step.replaceAll('_', ' ')}`}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="literal">A fixed date and time</SelectItem>
            <SelectItem value="input">The workflow input</SelectItem>
            {sources.map(previous => (
              <SelectItem key={previous.id} value={`step:${previous.id}`}>
                The output of {previous.id.replaceAll('_', ' ')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {at.kind === 'literal' ? (
        <Field
          id={`wait-until-${step.id}`}
          label={`Date and time for step ${number}`}
          required
          disabled={disabled}
          error={
            waitUntilTooFar(at)
              ? `Choose a date and time within ${delayDescription(maxDelaySeconds)} from now.`
              : undefined
          }
          helper={
            known
              ? `Continues on ${new Date(fixed).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })} in your time zone, ${zone}. Saved as ${new Date(fixed).toISOString().slice(0, 16).replace('T', ' ')} UTC.${fixed <= Date.now() ? ' This time has passed, so runs continue at once.' : ''}`
              : 'Choose the date and time when runs continue.'
          }
        >
          <Input
            type="datetime-local"
            value={known ? localInput(fixed) : ''}
            onChange={event => {
              const date = new Date(event.target.value);
              if (Number.isFinite(date.getTime())) onChange({ kind: 'literal', value: date.toISOString() });
            }}
          />
        </Field>
      ) : (
        <>
          <OutputPathControl
            key={source}
            id={`wait-until-${step.id}`}
            label={`Date field for step ${number}`}
            value={at}
            earlier={earlier}
            disabled={disabled}
            onChange={onChange}
          />
          <p className="text-sm text-muted-foreground">
            Use an ISO date or a date and time with a time zone. A missing or invalid date fails the run. The longest
            wait is {delayDescription(maxDelaySeconds)}.
          </p>
        </>
      )}
    </div>
  );
}
