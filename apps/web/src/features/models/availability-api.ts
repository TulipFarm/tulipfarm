import { z } from 'zod';
import {
  modelAvailabilitySchema,
  modelAvailabilityCommandSchema,
  modelAvailabilityReceiptSchema,
  modelAvailabilityListSchema,
} from '@tulipfarm/agents/model-policy-contracts';
import { settingsRequest } from '@/features/settings/api';

export type Availability = z.infer<typeof modelAvailabilitySchema>;
export type AvailabilityCommand = z.infer<typeof modelAvailabilityCommandSchema>;

export function availabilityApi(workspaceId: string) {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/model-policy/availability`;
  function receipt(value: unknown, input: AvailabilityCommand) {
    const result = modelAvailabilityReceiptSchema.parse(value);
    if (
      result.requestId !== input.requestId ||
      result.familyId !== input.familyId ||
      result.enabled !== input.enabled ||
      result.revision !== input.expectedRevision + 1
    )
      throw new Error('Unconfirmed model availability receipt');
    return result;
  }
  return {
    read: async (signal: AbortSignal) => modelAvailabilityListSchema.parse(await settingsRequest(base, signal)),
    save: async (input: AvailabilityCommand, signal: AbortSignal) =>
      receipt(await settingsRequest(base, signal, 'PUT', modelAvailabilityCommandSchema.parse(input)), input),
    receipt: async (input: AvailabilityCommand, signal: AbortSignal) =>
      receipt(
        await settingsRequest(
          `/workspace-settings/${encodeURIComponent(workspaceId)}/model-availability/commands/${encodeURIComponent(input.requestId)}`,
          signal,
        ),
        input,
      ),
  };
}
