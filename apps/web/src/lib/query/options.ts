import { queryOptions } from '@tanstack/react-query';
import { requestSignal } from '../http';
import type { FeatureClient } from './client';
import { featureKey, type FeatureScope } from './scope';
import type { PollInterval } from './polling';

export type FeatureReadOptions<T> = {
  key: readonly unknown[];
  load: (signal: AbortSignal) => Promise<T>;
  enabled?: boolean;
  staleTime?: number;
  pollWhile?: (data: T) => boolean;
  interval?: PollInterval;
  maxChecks?: number;
};

export function featureReadOptions<T>(
  runtime: FeatureClient,
  scope: FeatureScope,
  input: FeatureReadOptions<T>,
  admitted: () => boolean = () => true,
) {
  return queryOptions({
    queryKey: featureKey(scope, input.key),
    enabled: input.enabled !== false && runtime.isCurrent(scope) && admitted(),
    ...(input.staleTime === undefined ? {} : { staleTime: input.staleTime }),
    queryFn: async ({ signal }) => {
      const current = runtime.fence(scope, admitted);
      if (!current()) throw new DOMException('Authority changed', 'AbortError');
      const deadline = requestSignal(signal);
      const data = await input.load(deadline);
      deadline.throwIfAborted();
      if (!current()) throw new DOMException('Authority changed', 'AbortError');
      return data;
    },
  });
}
