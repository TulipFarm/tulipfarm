import { useEffect, useEffectEvent, useState } from 'react';
import type { GrantInput } from '@tulipfarm/workspaces/governance-contracts';

type Target = GrantInput['target'];
export type QueuedGrant = { key: string; holder: string; holderName: string; target: Target; granted: boolean };

const grantKey = (holder: string, target: Target) => `${holder}:${target.kind}:${target.id}:${target.permission}`;

export const savingStatus = (label: string, waiting: number) =>
  `Saving ${label}…${waiting ? ` ${waiting === 1 ? '1 more change' : `${waiting} more changes`} waiting.` : ''}`;
export const waitingStatus = (waiting: number) => `${waiting} ${waiting === 1 ? 'change' : 'changes'} waiting to save…`;
export const othersNotSaved = (count: number) =>
  count === 1 ? '1 other change was not saved.' : `${count} other changes were not saved.`;
export const changesNotSaved = (count: number) =>
  count === 1
    ? '1 change was not saved. Reload access, then make it again.'
    : `${count} changes were not saved. Reload access, then make them again.`;

/**
 * Grant checkboxes save one change at a time. Clicks made while a change saves wait here instead of being
 * dropped, and each waits until `wait` clears so it is sent against freshly loaded grants.
 */
export function useGrantQueue({
  saved,
  save,
  wait,
  stale,
  settled,
}: {
  saved: (holder: string, target: Target) => boolean;
  save: (entry: QueuedGrant) => Promise<boolean>;
  wait: boolean;
  stale: boolean;
  settled: (result: { entry: QueuedGrant; ok: boolean; dropped: number } | { entry: null; dropped: number }) => void;
}) {
  const [queue, setQueue] = useState<QueuedGrant[]>([]);
  const [saving, setSaving] = useState<QueuedGrant | null>(null);
  const saveNext = useEffectEvent(() => {
    const [next, ...rest] = queue;
    if (saving || !next) return;
    if (stale) {
      setQueue([]);
      settled({ entry: null, dropped: queue.length });
      return;
    }
    if (wait) return;
    setSaving(next);
    setQueue(rest);
    void save(next).then(ok => finish(next, ok));
  });
  const finish = useEffectEvent((entry: QueuedGrant, ok: boolean) => {
    setSaving(null);
    if (!ok) setQueue([]);
    settled({ entry, ok, dropped: ok ? 0 : queue.length });
  });
  useEffect(() => {
    saveNext();
  }, [queue, saving, wait, stale]);
  const pending = [...(saving ? [saving] : []), ...queue];
  return {
    saving,
    waiting: queue.length,
    pending: pending.length > 0,
    checked: (holder: string, target: Target) => {
      const key = grantKey(holder, target);
      return (
        queue.find(entry => entry.key === key)?.granted ??
        (saving?.key === key ? saving.granted : saved(holder, target))
      );
    },
    toggle: (holder: string, holderName: string, target: Target, granted: boolean) => {
      const key = grantKey(holder, target);
      const base = saving?.key === key ? saving.granted : saved(holder, target);
      setQueue(previous => [
        ...previous.filter(entry => entry.key !== key),
        ...(granted === base ? [] : [{ key, holder, holderName, target, granted }]),
      ]);
    },
    tablePending: (holder: string, tableId: string) =>
      pending.some(entry => entry.holder === holder && entry.target.kind === 'table' && entry.target.id === tableId),
  };
}
