import type { z } from 'zod';
import {
  imageSettingsCommandSchema,
  imageSettingsReceiptSchema,
  imageSettingsSchema,
} from '@tulipfarm/agents/image-settings-contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';

export type ImageSettings = z.infer<typeof imageSettingsSchema>;
export type ImageSettingsCommand = z.infer<typeof imageSettingsCommandSchema>;

const messages: Record<string, string> = {
  'image-settings-revision-conflict':
    'Another admin changed image settings. Reload the latest settings, review your choices, then save again.',
  'model-family-unavailable':
    'The chosen model can no longer read images here. Choose another model or turn it on in Access.',
  'image-model-unavailable': 'The chosen image model is unavailable. Choose another or turn it on in Access.',
  'idempotency-conflict': 'This save conflicts with an earlier save. Reload the latest settings before saving again.',
  'agent-not-found': 'Only workspace admins can change image settings, or your workspace access changed.',
  'sign-in-required': 'Your session expired. Sign in again to continue.',
  'invalid-request': 'The server rejected these values. Review your choices and try again.',
};

export function imageSettingsApi(workspaceId: string) {
  const url = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/model-policy/images`;
  async function request(signal: AbortSignal, input?: ImageSettingsCommand) {
    const response = await jsonResponse(url, { method: input ? 'PUT' : 'GET', cache: 'no-store', signal, body: input });
    const value = await readJson(response, true);
    if (!response.ok) {
      const code = responseError(value, 'image-settings-failed');
      throw new TableRequestError(
        response.status,
        code,
        messages[code] ??
          (response.status === 503
            ? 'Image settings are unavailable right now. Retry in a moment.'
            : 'Image settings could not be saved. Your choices are retained.'),
      );
    }
    return value;
  }
  return {
    read: async (signal: AbortSignal) => imageSettingsSchema.parse(await request(signal)),
    save: async (input: ImageSettingsCommand, signal: AbortSignal) => {
      const receipt = imageSettingsReceiptSchema.parse(await request(signal, imageSettingsCommandSchema.parse(input)));
      if (receipt.requestId !== input.requestId || receipt.revision !== input.expectedRevision + 1)
        throw new Error('Unconfirmed image settings receipt');
      return receipt;
    },
  };
}
