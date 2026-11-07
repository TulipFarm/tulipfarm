import { useCallback } from 'react';
import type { QueryKey } from '@tanstack/react-query';
import { useFeatureContext } from './provider';
import { featureKey, scopeKey } from './scope';

/** Restores every read an optimistic update changed. */
export type UndoOptimistic = () => void;

/**
 * Shows a write's expected result at once in every cached read under each feature-local key prefix.
 * `update` receives the cached data and the read's feature-local key; returning the same value leaves
 * that read alone. Call the returned undo when the write fails, then report the change as usual so
 * the reads revalidate against the server.
 */
export function useOptimisticUpdate() {
  const { runtime, scope } = useFeatureContext();
  return useCallback(
    async (keys: readonly QueryKey[], update: (data: unknown, key: readonly unknown[]) => unknown) => {
      const prefixes = keys.map(key => featureKey(scope, key));
      const scoped = scopeKey(scope).length;
      // A read already in flight started before the write, so its result would hide the update.
      await Promise.all(prefixes.map(queryKey => runtime.client.cancelQueries({ queryKey })));
      const snapshots = prefixes.flatMap(queryKey => runtime.client.getQueriesData({ queryKey }));
      const changed: (typeof snapshots)[number][] = [];
      for (const snapshot of snapshots) {
        const [queryKey, data] = snapshot;
        if (data === undefined || changed.some(([key]) => key === queryKey)) continue;
        const next = update(data, queryKey.slice(scoped));
        if (next === data) continue;
        runtime.client.setQueryData(queryKey, next);
        changed.push(snapshot);
      }
      return () => {
        for (const [queryKey, data] of changed) runtime.client.setQueryData(queryKey, data);
      };
    },
    [runtime, scope],
  );
}

/**
 * Replaces the entry with `id` in a cached list with `edit`'s result, or drops it when `edit` returns
 * null. Returns `list` itself when it isn't an array or has no such entry, leaving that read alone.
 */
export function editListed(
  list: unknown,
  id: string,
  edit: (item: Record<string, unknown>) => Record<string, unknown> | null,
): unknown {
  const matches = (item: unknown): item is Record<string, unknown> =>
    !!item && typeof item === 'object' && 'id' in item && item.id === id;
  if (!Array.isArray(list) || !list.some(matches)) return list;
  return list.flatMap((item: unknown) => (matches(item) ? (edit(item) ?? []) : [item]));
}

/** Applies `edit` to `data[field]` with {@link editListed}, keeping `data` itself when nothing changed. */
export function editListedIn(
  data: unknown,
  field: string,
  id: string,
  edit: (item: Record<string, unknown>) => Record<string, unknown> | null,
): unknown {
  if (!data || typeof data !== 'object' || !(field in data)) return data;
  const list = (data as Record<string, unknown>)[field];
  const next = editListed(list, id, edit);
  return next === list ? data : { ...data, [field]: next };
}
