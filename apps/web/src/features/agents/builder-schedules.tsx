import { useState } from 'react';
import { CalendarClock, Plus, Trash2 } from 'lucide-react';
import { Button } from '@tulipfarm/sprout/button';
import { CheckboxField, ChoiceGroup, Field } from '@tulipfarm/sprout/field';
import { FormSection } from '@tulipfarm/sprout/form';
import { Input } from '@tulipfarm/sprout/input';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Disclosure } from '@/components/disclosure';
import { defaultTaskLimits, limitDraft, taskLimitFields } from '@/features/tasks/limits';
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
import { parseSchedule, type ScheduleDraft } from './administration';

export type BuilderSchedule = ScheduleDraft & { id: string; sponsorMembershipId?: string };

export function newBuilderSchedule(): BuilderSchedule {
  return {
    id: crypto.randomUUID(),
    kind: 'task',
    activationId: '',
    tableId: '',
    text: '',
    cadence: 'cron',
    cronExpression: '0 9 * * 1',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    minutes: { task: '1440', inspect: '60' },
    limits: limitDraft(defaultTaskLimits),
    sponsorConsent: false,
  };
}

export function builderScheduleLabel(schedule: BuilderSchedule) {
  return schedule.cadence === 'interval'
    ? `Every ${schedule.minutes.task} minutes`
    : ordinaryCron(schedule.cronExpression)
      ? cronSummary({ kind: 'cron', expression: schedule.cronExpression, timezone: schedule.timezone })
      : `${schedule.cronExpression} (${schedule.timezone})`;
}

export function BuilderSchedules({
  value,
  onChange,
  disabled,
  showErrors,
  activating,
}: {
  value: BuilderSchedule[];
  onChange: (value: BuilderSchedule[]) => void;
  disabled: boolean;
  showErrors: boolean;
  activating: boolean;
}) {
  return (
    <FormSection
      title="Schedules"
      description="Give each recurring run its own task. Schedules stay off until activation."
      meta={value.length ? `${value.length} added` : undefined}
    >
      {!value.length && (
        <div className="flex items-start gap-3 text-sm">
          <CalendarClock aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <p className="text-muted-foreground">
            No scheduled work yet. Add a weekly update, a daily check, or another task that repeats.
          </p>
        </div>
      )}
      {value.map((schedule, index) => (
        <ScheduledPrompt
          key={schedule.id}
          schedule={schedule}
          index={index}
          disabled={disabled}
          showErrors={showErrors}
          activating={activating}
          onChange={change => onChange(value.map(item => (item.id === schedule.id ? { ...item, ...change } : item)))}
          onRemove={() => onChange(value.filter(item => item.id !== schedule.id))}
        />
      ))}
      <div>
        <Button variant="outline" disabled={disabled} onClick={() => onChange([...value, newBuilderSchedule()])}>
          <Plus aria-hidden="true" />
          Add schedule
        </Button>
      </div>
    </FormSection>
  );
}

function ScheduledPrompt({
  schedule,
  index,
  onChange,
  onRemove,
  disabled,
  showErrors,
  activating,
}: {
  schedule: BuilderSchedule;
  index: number;
  onChange: (change: Partial<BuilderSchedule>) => void;
  onRemove: () => void;
  disabled: boolean;
  showErrors: boolean;
  activating: boolean;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const errors = showErrors
    ? parseSchedule({ ...schedule, sponsorConsent: !activating || schedule.sponsorConsent }, 0, false).errors
    : {};
  const prefix = `builder-schedule-${schedule.id}`;
  const trigger = { kind: 'cron' as const, expression: schedule.cronExpression, timezone: schedule.timezone };
  const cron = cronParts(schedule.cronExpression);
  const custom = !ordinaryCron(schedule.cronExpression);
  const check = validateCron(trigger);
  const invalidLimits = taskLimitFields.some(field => errors[field.key]);
  return (
    <section aria-label={`Schedule ${index + 1}`} className="grid min-w-0 gap-5 border-t pt-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Schedule {index + 1}</h3>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove schedule ${index + 1}`}
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
      <Field
        id={`${prefix}-prompt`}
        label="Task prompt"
        required
        counter={`${schedule.text.length.toLocaleString()} / 8,000`}
        helper="What should this agent do each time? This is separate from its standing instructions."
        error={errors.prompt}
      >
        <Textarea
          rows={3}
          maxLength={8000}
          value={schedule.text}
          placeholder="Prepare the weekly People Ops update and list questions that need a decision."
          onChange={event => onChange({ text: event.target.value })}
        />
      </Field>
      <ChoiceGroup
        type="radio"
        layout="columns"
        legend="Repeat"
        required
        value={schedule.cadence}
        onValueChange={cadence => onChange({ cadence })}
        options={[
          { value: 'cron', label: 'Days and time' },
          { value: 'interval', label: 'Time interval' },
        ]}
      />
      {schedule.cadence === 'interval' ? (
        <Field
          id={`${prefix}-minutes`}
          label="Interval in minutes"
          required
          helper="From 60 to 10,080 minutes. These tasks run at most once an hour."
          error={errors.cadence}
        >
          <Input
            type="number"
            min={60}
            max={10080}
            value={schedule.minutes.task}
            onChange={event => onChange({ minutes: { ...schedule.minutes, task: event.target.value } })}
          />
        </Field>
      ) : (
        <>
          {!custom && (
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              <Field id={`${prefix}-days`} label="Days" required>
                <Select
                  value={cron.days}
                  onValueChange={days => {
                    if (days) onChange({ cronExpression: cronWithDays(schedule.cronExpression, days) });
                  }}
                >
                  <SelectTrigger width="full">
                    <SelectValue>{cronDayChoices.find(([day]) => day === cron.days)?.[1]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {cronDayChoices.map(([day, label]) => (
                      <SelectItem key={day} value={day}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field id={`${prefix}-time`} label="Time" required>
                <Input
                  type="time"
                  value={cron.time}
                  onChange={event => {
                    const expression = cronWithTime(schedule.cronExpression, event.target.value);
                    if (expression) onChange({ cronExpression: expression });
                  }}
                />
              </Field>
            </div>
          )}
          <Field
            id={`${prefix}-zone`}
            label="Time zone"
            required
            error={check.field === 'timezone' && showErrors ? check.problem : undefined}
          >
            <Select
              value={schedule.timezone}
              onValueChange={timezone => {
                if (timezone) onChange({ timezone });
              }}
            >
              <SelectTrigger width="full">
                <SelectValue>{schedule.timezone.replaceAll('_', ' ')}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {[...new Set([schedule.timezone, 'UTC', ...Intl.supportedValuesOf('timeZone')])].map(zone => (
                  <SelectItem key={zone} value={zone}>
                    {zone.replaceAll('_', ' ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Disclosure
            title="Advanced cron"
            open={advancedOpen || !!errors.cadence || custom}
            onOpenChange={setAdvancedOpen}
          >
            <Field
              id={`${prefix}-cron`}
              label="Cron expression"
              required
              helper="Minute, hour, day of month, month, day of week. For example, 0 9 * * 1 runs on Mondays at 09:00."
              error={errors.cadence}
            >
              <Input
                value={schedule.cronExpression}
                onChange={event => onChange({ cronExpression: event.target.value })}
              />
            </Field>
            {custom && (
              <div className="mt-3">
                <Button variant="outline" disabled={disabled} onClick={() => onChange({ cronExpression: '0 9 * * 1' })}>
                  Use days and time
                </Button>
              </div>
            )}
          </Disclosure>
          {!check.problem && (
            <div className="grid gap-2 text-sm">
              <p className="text-muted-foreground">Next runs after activation</p>
              <ol aria-label={`Next runs for schedule ${index + 1}`} className="grid gap-1">
                {check.runs.map(run => (
                  <li key={run}>
                    <time dateTime={run}>{runTime(run, schedule.timezone)}</time>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}
      <Disclosure title="Limits for each run" open={limitsOpen || invalidLimits} onOpenChange={setLimitsOpen}>
        <div className="grid gap-4 sm:grid-cols-3">
          {taskLimitFields.map(field => (
            <Field key={field.key} id={`${prefix}-${field.key}`} label={field.label} required error={errors[field.key]}>
              <Input
                type="number"
                min={field.min}
                max={field.max}
                value={schedule.limits[field.key]}
                onChange={event => onChange({ limits: { ...schedule.limits, [field.key]: event.target.value } })}
              />
            </Field>
          ))}
        </div>
      </Disclosure>
      <CheckboxField
        id={`${prefix}-sponsor`}
        label="I sponsor these runs with my current permissions"
        helper="Each result is a private task. Runs stop if you lose access."
        checked={schedule.sponsorConsent}
        onCheckedChange={sponsorConsent => onChange({ sponsorConsent })}
        error={errors.sponsor}
      />
    </section>
  );
}
