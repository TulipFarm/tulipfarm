import { queryOptions } from '@tanstack/react-query';
import { requestSignal } from '../http';
import type { FeatureClient } from './client';
import { takeEarlyRead } from './early-reads';
import { featureKey, type FeatureScope } from './scope';
import type { PollInterval } from './polling';

export type FeatureReadOptions<T> = {
  key: readonly unknown[];
  load: (signal: AbortSignal) => Promise<T>;
  pollLoad?: (data: T, signal: AbortSignal) => Promise<T>;
  enabled?: boolean;
  staleTime?: number;
  pollWhile?: (data: T) => boolean;
  interval?: PollInterval;
  maxChecks?: number;
  maxDuration?: number;
  schedule?: (signal: AbortSignal, load: () => Promise<T>) => Promise<T>;
  retry?: (failures: number, error: unknown) => boolean;
  retryDelay?: (attempt: number, error: unknown) => number;
};

export function featureReadOptions<T>(
  runtime: FeatureClient,
  scope: FeatureScope,
  input: FeatureReadOptions<T>,
  admitted: () => boolean = () => true,
) {
  const key = featureKey(scope, input.key);
  return queryOptions({
    queryKey: key,
    enabled: input.enabled !== false && runtime.isCurrent(scope) && admitted(),
    ...(input.staleTime === undefined ? {} : { staleTime: input.staleTime }),
    ...(input.retry === undefined
      ? {}
      : {
          retry: (failures: number, error: unknown) =>
            runtime.canRetry() && runtime.isCurrent(scope) && admitted() && input.retry!(failures, error),
        }),
    ...(input.retryDelay === undefined ? {} : { retryDelay: input.retryDelay }),
    queryFn: async ({ signal }) => {
      const load = async () => {
        const current = runtime.fence(scope, admitted);
        if (!current()) throw new DOMException('Authority changed', 'AbortError');
        const deadline = requestSignal(signal);
        const previous = runtime.polling.checking(key) ? runtime.client.getQueryData<T>(key) : undefined;
        const early =
          scope.kind === 'workspace' ? await takeEarlyRead<T>(runtime.identity, scope, input.key, deadline) : null;
        const data =
          previous !== undefined && input.pollLoad
            ? await input.pollLoad(previous, deadline)
            : early
              ? early.value
              : await input.load(deadline);
        deadline.throwIfAborted();
        if (!current()) throw new DOMException('Authority changed', 'AbortError');
        return data;
      };
      return input.schedule ? input.schedule(signal, load) : load();
    },
  });
}
