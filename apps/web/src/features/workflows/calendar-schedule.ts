import { normalizeCronExpression, triggerSchema, type Definition } from '@tulipfarm/workflows/contracts';
import { nextCronOccurrences } from '@tulipfarm/workflows/schedule';

export type CronTrigger = Extract<Definition['trigger'], { kind: 'cron' }>;

export const cronDayChoices = [
  ['*', 'Every day'],
  ['1-5', 'Weekdays'],
  ['1', 'Monday'],
  ['2', 'Tuesday'],
  ['3', 'Wednesday'],
  ['4', 'Thursday'],
  ['5', 'Friday'],
  ['6', 'Saturday'],
  ['0', 'Sunday'],
] as const;
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** True when day and time controls can show the expression without losing anything. */
export const ordinaryCron = (expression: string) =>
  /^\d+ \d+ \* \* (\*|1-5|[0-6])$/.test(normalizeCronExpression(expression));

export function cronParts(expression: string) {
  const [minute = '0', hour = '9', , , days = '*'] = normalizeCronExpression(expression).split(' ');
  return { minute, hour, days, time: `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}` };
}

export const cronWithDays = (expression: string, days: string) => {
  const parts = cronParts(expression);
  return `${parts.minute} ${parts.hour} * * ${days}`;
};

export function cronWithTime(expression: string, time: string) {
  const [hour, minute] = time.split(':');
  return hour && minute ? `${Number(minute)} ${Number(hour)} * * ${cronParts(expression).days}` : null;
}

export function cronSummary(trigger: CronTrigger) {
  const { days, time } = cronParts(trigger.expression);
  const when = days === '*' ? 'Every day' : days === '1-5' ? 'Every weekday' : `Every ${weekdays[Number(days)]}`;
  return `${when} at ${time} in ${trigger.timezone.replaceAll('_', ' ')}.`;
}

export function validateCron(trigger: CronTrigger) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: trigger.timezone }).format(new Date());
  } catch {
    return { field: 'timezone', problem: 'Enter a valid IANA time zone.', runs: [] as string[] };
  }
  const parsed = triggerSchema.safeParse(trigger);
  if (!parsed.success || parsed.data.kind !== 'cron')
    return { field: 'expression', problem: 'Enter a valid five-field cron expression.', runs: [] as string[] };
  try {
    return { field: null, problem: null, runs: nextCronOccurrences(parsed.data, new Date()) };
  } catch {
    return { field: 'expression', problem: 'Enter a valid five-field cron expression.', runs: [] as string[] };
  }
}

/** Mirrors the server's spacing check, which measures the first two runs after a fixed date. */
export function cronGapMinutes(trigger: CronTrigger) {
  try {
    const [first, second] = nextCronOccurrences(trigger, new Date('2024-01-01T00:00:00.000Z'));
    return first && second ? (Date.parse(second) - Date.parse(first)) / 60000 : null;
  } catch {
    return null;
  }
}

export const runTime = (run: string, timezone: string) =>
  new Date(run).toLocaleString(undefined, {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
