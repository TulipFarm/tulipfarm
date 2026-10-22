import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { hashKey, useQuery, type QueryKey } from '@tanstack/react-query';
import type { FeatureChange } from './client';
import { readState } from './policy';
import { useFeatureContext } from './provider';
import { featureKey } from './scope';
import { featureReadOptions, type FeatureReadOptions } from './options';

export function useFeatureRead<T>(input: FeatureReadOptions<T>) {
  const { runtime, scope, current } = useFeatureContext();
  useSyncExternalStore(runtime.subscribeAuthority, runtime.authoritySnapshot, runtime.authoritySnapshot);
  const options = featureReadOptions(runtime, scope, input, current);
  const result = useQuery(options);
  const hash = hashKey(options.queryKey);
  const key = useMemo(() => options.queryKey, [hash]);
  const latest = useRef({ input, result });
  latest.current = { input, result };
  useEffect(
    () =>
      runtime.polling.register(key, {
        enabled: () => latest.current.input.enabled !== false && current(),
        pending: () => {
          const { input, result } = latest.current;
          return (
            input.enabled !== false &&
            current() &&
            result.data !== undefined &&
            !result.error &&
            !!input.pollWhile?.(result.data)
          );
        },
        interval: input.interval ?? 2000,
        maxChecks: input.maxChecks ?? 30,
      }),
    [runtime, key, current, input.interval, input.maxChecks],
  );
  useEffect(() => {
    runtime.polling.sync();
  }, [runtime, result.data, result.error, result.fetchStatus, input.enabled]);
  const delayed = useSyncExternalStore(
    runtime.polling.subscribe,
    () => runtime.polling.delayed(key),
    () => false,
  );
  const refresh = useCallback(async () => {
    if (input.enabled === false || !current()) return;
    runtime.polling.reset(key);
    await result.refetch({ cancelRefetch: false });
  }, [runtime, key, current, input.enabled, result.refetch]);
  const restart = useCallback(() => {
    runtime.polling.reset(key);
  }, [runtime, key]);
  return {
    state: current() ? readState(result) : readState<T>({ data: undefined, error: { status: 403 }, isFetching: false }),
    refresh,
    delayed,
    restart,
  };
}

export function useFeatureChanges(): { change: (input: FeatureChange) => Promise<void> } {
  const { runtime, scope } = useFeatureContext();
  return useMemo(() => ({ change: (input: FeatureChange) => runtime.change(scope, input) }), [runtime, scope]);
}

/** Call alongside the catalog read and pass the result as its enabled flag. */
export function useCatalogRestoration(key: QueryKey): boolean {
  const { runtime, scope, current } = useFeatureContext();
  const hash = hashKey(featureKey(scope, key));
  const [restored, setRestored] = useState<string | null>(null);
  useEffect(() => {
    if (scope.kind !== 'workspace') throw new Error('Catalog persistence requires workspace membership admission.');
    let mounted = true;
    void runtime.prepareCatalog(scope, key, current).then(() => {
      if (mounted && current()) setRestored(hash);
    });
    return () => {
      mounted = false;
    };
  }, [runtime, hash, current]);
  return restored === hash && current();
}
