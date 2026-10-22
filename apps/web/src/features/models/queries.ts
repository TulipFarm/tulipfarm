import { useCallback, useMemo } from 'react';
import { featureReadOptions, useFeatureChanges, useFeatureRead } from '@/lib/query';
import { useFeatureContext } from '@/lib/query/provider';
import type { modelApi, ModelPolicyCommand, ModelPolicyRule } from './api';
import type { Availability, AvailabilityCommand, availabilityApi } from './availability-api';

export const modelKeys = {
  catalog: () => ['models', 'catalog'] as const,
  membership: () => ['models', 'membership'] as const,
  availability: () => ['models', 'availability'] as const,
  availabilityReceipt: (command: AvailabilityCommand) => ['models', 'availability-receipt', command] as const,
  rules: () => ['models', 'rules'] as const,
  rule: (source: string) => ['models', 'rules', source] as const,
  receipt: (command: ModelPolicyCommand | null, accessVersion: number) =>
    ['models', 'receipt', command, accessVersion] as const,
};

export function useModelMembership(load: ReturnType<typeof modelApi>['membership']) {
  return useFeatureRead({ key: modelKeys.membership(), load });
}

export function useModelRule(source: string, load: (signal: AbortSignal) => Promise<ModelPolicyRule>, enabled = true) {
  return useFeatureRead({ key: modelKeys.rule(source), load, enabled });
}

export function useModelAvailability(
  load: (signal: AbortSignal) => Promise<{ items: Availability[] }>,
  enabled: boolean,
) {
  return useFeatureRead({ key: modelKeys.availability(), load, enabled });
}

export function useModelReceipt<T>(
  command: ModelPolicyCommand | null,
  accessVersion: number,
  load: (signal: AbortSignal) => Promise<T>,
  enabled: boolean,
) {
  return useFeatureRead({ key: modelKeys.receipt(command, accessVersion), load, enabled, staleTime: 0 });
}

export function useModelAvailabilityReceipt(api: ReturnType<typeof availabilityApi>) {
  const { runtime, scope, current } = useFeatureContext();
  const changes = useModelChanges();
  return useCallback(
    async (command: AvailabilityCommand, signal: AbortSignal) => {
      const result = await runtime.client.fetchQuery(
        featureReadOptions(
          runtime,
          scope,
          {
            key: modelKeys.availabilityReceipt(command),
            load: querySignal => api.receipt(command, AbortSignal.any([signal, querySignal])),
            staleTime: 0,
          },
          current,
        ),
      );
      void changes.policy();
      return result;
    },
    [runtime, scope, current, api, changes],
  );
}

export function useModelChanges() {
  const { change } = useFeatureChanges();
  return useMemo(
    () => ({
      policy: (source?: string) =>
        change({
          keys: [modelKeys.catalog(), modelKeys.availability(), source ? modelKeys.rule(source) : modelKeys.rules()],
        }),
      rejected: () => change({ keys: [modelKeys.catalog()] }),
    }),
    [change],
  );
}
