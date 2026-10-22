import { TZDate } from '@date-fns/tz';
import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  endOfMonth,
  endOfWeek,
  format,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { z } from 'zod';

export const calendarViews = ['day', 'week', 'month', 'agenda'] as const;
export type CalendarView = (typeof calendarViews)[number];
export const calendarKinds = ['meeting', 'task', 'agent', 'workflow'] as const;
export type CalendarKind = (typeof calendarKinds)[number];
export const kindLabels: Record<CalendarKind, string> = {
  meeting: 'Meetings',
  task: 'Tasks',
  agent: 'Agent runs',
  workflow: 'Workflow runs',
};
export const zoneSchema = z.string().refine(value => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
});
export const calendarSearchSchema = z.object({
  view: z.enum(calendarViews).optional().catch(undefined),
  date: z.iso.date().optional().catch(undefined),
  zone: zoneSchema.optional().catch(undefined),
});
export type CalendarItem = {
  id: string;
  title: string;
  kind: CalendarKind;
  source: string;
  sourceId: string;
  status: string;
  time:
    | { kind: 'timed'; start: string; end: string }
    | { kind: 'all-day'; start: string; end: string; zone?: string }
    | { kind: 'point'; at: string };
  busy: boolean;
  href?: string;
  joinUrl?: string;
  location?: string;
  tags?: string[];
};
export function dayKey(date: Date, zone: string) {
  return format(new TZDate(date, zone), 'yyyy-MM-dd');
}
export function clockTime(at: string, zone: string) {
  return format(new TZDate(at, zone), 'HH:mm');
}
export function ambiguousTime(date: Date, zone: string) {
  const label = format(new TZDate(date, zone), 'yyyy-MM-dd HH:mm');
  return [-120, -60, -30, 30, 60, 120].some(
    minutes => format(new TZDate(date.getTime() + minutes * 60000, zone), 'yyyy-MM-dd HH:mm') === label,
  );
}
export function localDate(day: string, time: string, zone: string) {
  const [year, month, date] = day.split('-').map(Number),
    [hour, minute] = time.split(':').map(Number);
  const value = new TZDate(year!, month! - 1, date!, hour!, minute!, 0, 0, zone);
  if (!Number.isFinite(value.getTime()) || format(value, 'yyyy-MM-dd HH:mm') !== `${day} ${time}`)
    throw new Error('This local time does not exist. Choose another time.');
  return value;
}
export function calendarDays(day: string, view: CalendarView, zone: string) {
  const selected = localDate(day, '12:00', zone);
  const start =
    view === 'month'
      ? startOfWeek(startOfMonth(selected), { weekStartsOn: 1 })
      : view === 'week'
        ? startOfWeek(selected, { weekStartsOn: 1 })
        : selected;
  const count =
    view === 'month'
      ? differenceInCalendarDays(endOfWeek(endOfMonth(selected), { weekStartsOn: 1 }), start) + 1
      : view === 'week'
        ? 7
        : view === 'agenda'
          ? 30
          : 1;
  return Array.from({ length: count }, (_, index) => format(addDays(start, index), 'yyyy-MM-dd'));
}
export function calendarRange(day: string, view: CalendarView, zone: string) {
  const days = calendarDays(day, view, zone);
  return {
    from: localDate(days[0]!, '00:00', zone).toISOString(),
    to: addDays(localDate(days.at(-1)!, '00:00', zone), 1).toISOString(),
  };
}
export function moveDate(day: string, view: CalendarView, direction: number, zone: string) {
  const value = localDate(day, '12:00', zone);
  return format(
    view === 'month'
      ? addMonths(value, direction)
      : addDays(value, direction * (view === 'week' ? 7 : view === 'agenda' ? 30 : 1)),
    'yyyy-MM-dd',
  );
}
export function itemOnDay(item: CalendarItem, day: string, zone: string) {
  if (item.time.kind === 'all-day') return item.time.start <= day && item.time.end > day;
  const start = localDate(day, '00:00', zone).getTime(),
    end = addDays(localDate(day, '00:00', zone), 1).getTime();
  return item.time.kind === 'point'
    ? Date.parse(item.time.at) >= start && Date.parse(item.time.at) < end
    : Date.parse(item.time.start) < end && Date.parse(item.time.end) > start;
}
export function itemTime(item: CalendarItem, zone: string) {
  if (item.time.kind === 'all-day') return 'All day';
  const formatter = new Intl.DateTimeFormat('en', { timeZone: zone, hour: 'numeric', minute: '2-digit' });
  return item.time.kind === 'point'
    ? formatter.format(new Date(item.time.at))
    : `${formatter.format(new Date(item.time.start))} – ${formatter.format(new Date(item.time.end))}`;
}
export function itemIsPast(item: CalendarItem, now: Date, zone: string) {
  return item.time.kind === 'all-day'
    ? item.time.end <= dayKey(now, item.time.zone ?? zone)
    : Date.parse(item.time.kind === 'point' ? item.time.at : item.time.end) <= now.getTime();
}
export function compactItemTime(item: CalendarItem, zone: string, startOnly = false) {
  if (item.time.kind === 'all-day') return 'All day';
  const formatter = new Intl.DateTimeFormat('en', { timeZone: zone, hour: 'numeric', minute: '2-digit' });
  const clock = (at: string) =>
    formatter.format(new Date(at)).replace(':00', '').replace(' AM', 'a').replace(' PM', 'p');
  if (item.time.kind === 'point') return clock(item.time.at);
  const start = clock(item.time.start),
    end = clock(item.time.end);
  if (startOnly) return start;
  return `${start.at(-1) === end.at(-1) ? start.slice(0, -1) : start}–${end}`;
}
export function calendarHourLabels(day: string, zone: string, secondZone: string | null) {
  const secondary =
    secondZone && secondZone !== zone
      ? new Intl.DateTimeFormat('en', { timeZone: secondZone, hour: 'numeric', minute: '2-digit', hour12: true })
      : null;
  return Array.from({ length: 24 }, (_, hour) => {
    const at = localDate(day, '12:00', zone);
    at.setHours(hour, 0, 0, 0);
    return { primary: `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`, secondary: secondary?.format(at) ?? null };
  });
}
export function itemStart(item: CalendarItem) {
  return item.time.kind === 'point' ? item.time.at : item.time.start;
}

export function calendarNowNext(items: CalendarItem[], now: Date, zone: string) {
  const at = now.getTime();
  const start = (item: CalendarItem) =>
    item.time.kind === 'all-day' ? localDate(item.time.start, '00:00', zone).getTime() : Date.parse(itemStart(item));
  const current = items
    .filter(
      item =>
        item.time.kind !== 'point' &&
        start(item) <= at &&
        (item.time.kind === 'all-day' ? localDate(item.time.end, '00:00', zone).getTime() : Date.parse(item.time.end)) >
          at,
    )
    .sort((a, b) => Number(a.time.kind === 'all-day') - Number(b.time.kind === 'all-day') || start(a) - start(b));
  const next =
    items
      .filter(item => (item.time.kind === 'point' ? start(item) >= at : start(item) > at))
      .sort((a, b) => start(a) - start(b) || a.id.localeCompare(b.id))[0] ?? null;
  return { current, next };
}

export function layoutDay(items: CalendarItem[], day: string, zone: string) {
  const midnight = localDate(day, '00:00', zone),
    tomorrow = addDays(midnight, 1);
  const minute = (at: string) => {
    const date = new TZDate(at, zone);
    return date.getHours() * 60 + date.getMinutes();
  };
  const rows = items
    .flatMap(item => {
      if (item.time.kind !== 'timed' || !itemOnDay(item, day, zone)) return [];
      const { start, end } = item.time;
      const top = Date.parse(start) <= midnight.getTime() ? 0 : minute(start);
      const bottom = Date.parse(end) >= tomorrow.getTime() ? 1440 : Math.max(top, minute(end));
      return [{ item, top, bottom: Math.min(1440, Math.max(top + 30, bottom)), column: 0, columns: 1 }];
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom || a.item.id.localeCompare(b.item.id));
  let group: typeof rows = [],
    ends: number[] = [],
    groupEnd = -1;
  const finish = () => {
    for (const row of group) row.columns = ends.length;
  };
  for (const row of rows) {
    if (row.top >= groupEnd) {
      finish();
      group = [];
      ends = [];
      groupEnd = -1;
    }
    let column = ends.findIndex(end => end <= row.top);
    if (column < 0) column = ends.length;
    ends[column] = row.bottom;
    row.column = column;
    group.push(row);
    groupEnd = Math.max(groupEnd, row.bottom);
  }
  finish();
  return rows;
}

export function layoutDayGroups(items: CalendarItem[], day: string, zone: string) {
  const rows = layoutDay(items, day, zone),
    groups: (typeof rows)[] = [];
  let end = -1;
  for (const row of rows) {
    if (row.top >= end) {
      groups.push([]);
      end = -1;
    }
    groups.at(-1)!.push(row);
    end = Math.max(end, row.bottom);
  }
  return groups;
}

export function freeSlots(items: CalendarItem[], day: string, zone: string, minutes: number, now = Date.now()) {
  const result: { start: string; end: string }[] = [];
  for (let at = 9 * 60; at + minutes <= 18 * 60; at += 30) {
    const start = localDate(
      day,
      `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`,
      zone,
    );
    const end = new Date(start.getTime() + minutes * 60000);
    if (start.getTime() < now) continue;
    const busy = items.some(item => {
      if (!item.busy || item.time.kind === 'point') return false;
      const busyStart =
        item.time.kind === 'all-day'
          ? localDate(item.time.start, '00:00', item.time.zone ?? zone).getTime()
          : Date.parse(item.time.start);
      const busyEnd =
        item.time.kind === 'all-day'
          ? localDate(item.time.end, '00:00', item.time.zone ?? zone).getTime()
          : Date.parse(item.time.end);
      return busyStart < end.getTime() && busyEnd > start.getTime();
    });
    if (!busy) result.push({ start: start.toISOString(), end: end.toISOString() });
  }
  return result;
}
