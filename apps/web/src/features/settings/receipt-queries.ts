import { featureReadOptions } from '@/lib/query';
import { useFeatureContext } from '@/lib/query/provider';
import { modelApi } from '@/features/models/api';
import { availabilityApi } from '@/features/models/availability-api';
import { settingsApi } from './api';
import type { PendingCommand } from './command-recovery';

function useCommandReceipt<C, R>(
  workspaceId: string,
  channel: PendingCommand['channel'],
  load: (command: C, signal: AbortSignal) => Promise<R>,
) {
  const { runtime, scope } = useFeatureContext();
  return (command: C, signal: AbortSignal) =>
    runtime.client.fetchQuery({
      ...featureReadOptions(
        runtime,
        { kind: 'account', userId: scope.userId },
        {
          key: ['workspace-command-receipts', workspaceId, channel, command],
          load: async querySignal => {
            const deadline = AbortSignal.any([signal, querySignal]);
            const result = await load(command, deadline);
            deadline.throwIfAborted();
            return result;
          },
          staleTime: 0,
        },
      ),
      retry: false,
      networkMode: 'always',
    });
}

export function useSettingsReceipt(workspaceId: string) {
  return useCommandReceipt(workspaceId, 'settings', settingsApi(workspaceId).receipt);
}

export function useAvailabilityReceipt(workspaceId: string) {
  return useCommandReceipt(workspaceId, 'availability', availabilityApi(workspaceId).receipt);
}

export function useFallbackReceipt(workspaceId: string) {
  return useCommandReceipt(workspaceId, 'fallback', modelApi(workspaceId).command);
}
