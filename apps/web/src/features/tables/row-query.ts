import { useEffect, useState } from 'react';

export const rowFilterOps = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'is-null', 'not-null'] as const;

const pad = (value: number) => String(value).padStart(2, '0');
/** A `datetime-local` value in the browser's zone for a stored UTC timestamp. */
export function localDateTime(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function utcTimestamp(local: string) {
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().replace('.000Z', 'Z');
}

export function rowTotal(total: string, filtered: boolean) {
  const count = Number.parseInt(total, 10);
  const number = `${Number.isNaN(count) ? total : count.toLocaleString('en-US')}${total.endsWith('+') ? '+' : ''}`;
  return `${number} ${filtered ? 'matching ' : ''}${total === '1' ? 'row' : 'rows'}`;
}

/** Text typed into a URL-backed control. It writes 250ms after the last keystroke and follows outside URL changes. */
export function useUrlDraft(current: string, commit: (draft: string) => void) {
  const [draft, setDraft] = useState(current);
  useEffect(() => {
    setDraft(current);
  }, [current]);
  useEffect(() => {
    if (draft === current) return;
    const timer = setTimeout(() => commit(draft), 250);
    return () => clearTimeout(timer);
  }, [draft]);
  return [draft, setDraft] as const;
}
