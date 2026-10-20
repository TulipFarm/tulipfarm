import { CronExpressionParser } from 'cron-parser';
import type { Definition } from './contracts.ts';

export function nextOccurrence(trigger: Definition['trigger'], now: Date): string | null {
  switch (trigger.kind) {
    case 'once':
      if (trigger.timezone) new Intl.DateTimeFormat('en', { timeZone: trigger.timezone }).format(now);
      return new Date(trigger.at).toISOString();
    case 'interval':
      return new Date(now.getTime() + trigger.minutes * 60000).toISOString();
    case 'cron': {
      new Intl.DateTimeFormat('en', { timeZone: trigger.timezone }).format(now);
      return CronExpressionParser.parse(trigger.expression, { currentDate: now, tz: trigger.timezone })
        .next()
        .toDate()
        .toISOString();
    }
    case 'record':
      if (trigger.field.kind === 'date')
        new Intl.DateTimeFormat('en', { timeZone: trigger.field.timezone }).format(now);
      // The sweep reads the table when this comes due, then waits for the earliest record occurrence.
      return now.toISOString();
    // The sweep reads changes when this comes due, then every minute after.
    case 'row':
      return now.toISOString();
    case 'manual':
    case 'webhook':
    case 'event':
    case 'provider':
      return null;
    default: {
      const exhaustive: never = trigger;
      return exhaustive;
    }
  }
}

export function nextCronOccurrences(trigger: Extract<Definition['trigger'], { kind: 'cron' }>, now: Date): string[] {
  new Intl.DateTimeFormat('en', { timeZone: trigger.timezone }).format(now);
  const expression = CronExpressionParser.parse(trigger.expression, { currentDate: now, tz: trigger.timezone });
  return [expression.next().toDate(), expression.next().toDate(), expression.next().toDate()].map(date =>
    date.toISOString(),
  );
}

export function calendarOccurrences(
  trigger: Definition['trigger'],
  nextRunAt: string,
  from: string,
  to: string,
  limit = 250,
) {
  const start = Math.max(Date.parse(from), Date.parse(nextRunAt)),
    end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= Date.parse(from) || limit < 1)
    throw new Error('Invalid calendar range');
  const times: string[] = [];
  if (!['once', 'interval', 'cron'].includes(trigger.kind) || start >= end) return { times, more: false };
  if (trigger.kind === 'once') {
    const at = Date.parse(trigger.at);
    if (at >= start && at < end) times.push(new Date(at).toISOString());
    return { times, more: false };
  }
  const iterator =
    trigger.kind === 'cron'
      ? CronExpressionParser.parse(trigger.expression, { currentDate: new Date(start - 1), tz: trigger.timezone })
      : null;
  let at =
    trigger.kind === 'interval'
      ? Date.parse(nextRunAt) +
        Math.max(0, Math.ceil((start - Date.parse(nextRunAt)) / (trigger.minutes * 60000))) * trigger.minutes * 60000
      : iterator!.next().toDate().getTime();
  while (at < end && times.length < limit) {
    times.push(new Date(at).toISOString());
    at = trigger.kind === 'interval' ? at + trigger.minutes * 60000 : iterator!.next().toDate().getTime();
  }
  return { times, more: at < end };
}

export type MissedOccurrences = {
  scheduledFor: string;
  missedThrough: string;
  missedCount: number;
  missedCountCapped?: true;
};
export const missedCountLimit = 1000;

export function missedOccurrences(trigger: Definition['trigger'], due: Date, now: Date): MissedOccurrences | null {
  if (trigger.kind === 'interval') {
    const step = trigger.minutes * 60000,
      count = Math.floor((now.getTime() - due.getTime()) / step);
    return count < 1
      ? null
      : {
          scheduledFor: new Date(due.getTime() + step).toISOString(),
          missedThrough: new Date(due.getTime() + count * step).toISOString(),
          missedCount: count,
        };
  }
  if (trigger.kind !== 'cron') return null;
  const expression = CronExpressionParser.parse(trigger.expression, { currentDate: due, tz: trigger.timezone });
  const first = expression.next().toDate();
  if (first > now) return null;
  let count = 1;
  while (count <= missedCountLimit && expression.next().toDate() <= now) count++;
  const last = CronExpressionParser.parse(trigger.expression, {
    currentDate: new Date(now.getTime() + 1),
    tz: trigger.timezone,
  })
    .prev()
    .toDate();
  return {
    scheduledFor: first.toISOString(),
    missedThrough: last.toISOString(),
    ...(count > missedCountLimit ? { missedCount: missedCountLimit, missedCountCapped: true } : { missedCount: count }),
  };
}
