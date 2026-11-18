import { useCallback } from 'react';
import { featureReadOptions, type FeatureReadOptions } from './options';
import { freshness } from './policy';
import { useFeatureContext } from './provider';

// Pointer and focus intent repeat as people scan a list; a read this recent is not fetched again for it.
const intentFreshness = 10_000;

/**
 * Starts a read before its page opens, under the key the page reads. A failed read is dropped, so
 * opening the page reads again and shows the usual denial or error.
 */
export function usePrefetchRead() {
  const { runtime, scope, current } = useFeatureContext();
  return useCallback(
    <T>(input: FeatureReadOptions<T>) => {
      const options = featureReadOptions(runtime, scope, input, current);
      if (!options.enabled) return;
      const staleTime = Math.max(input.staleTime ?? freshness.ordinary, intentFreshness);
      void runtime.client.prefetchQuery({ ...options, staleTime }).then(() => {
        if (runtime.client.getQueryState(options.queryKey)?.status === 'error')
          runtime.client.removeQueries({ queryKey: options.queryKey, exact: true });
      });
    },
    [runtime, scope, current],
  );
}
