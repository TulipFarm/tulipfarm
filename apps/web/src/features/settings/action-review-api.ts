import { z } from 'zod';
import { actionReviewSettingsSchema, reviewPreviewSchema } from '@tulipfarm/workspaces/action-review-contracts';
import { TableRequestError } from '@/features/tables/request-state';
import { settingsRequest } from './api';

export type ReviewSettings = z.infer<typeof actionReviewSettingsSchema>;
export type ReviewPreview = z.infer<typeof reviewPreviewSchema> & { ok: true };

export function actionReviewApi(workspaceId: string) {
  const path = `/workspaces/${encodeURIComponent(workspaceId)}/settings/action-review`;
  return {
    read: async (signal: AbortSignal) => actionReviewSettingsSchema.parse(await settingsRequest(path, signal)),
    async preview(rule: string): Promise<ReviewPreview | { ok: false; message: string }> {
      try {
        // oxlint-disable-next-line tulipfarm/product-copy -- API route, not displayed copy.
        const value = await settingsRequest(`${path}/preview`, AbortSignal.timeout(30000), 'POST', { rule });
        return { ...reviewPreviewSchema.parse(value), ok: true };
      } catch (error) {
        if (error instanceof TableRequestError && [400, 422].includes(error.status))
          return {
            ok: false,
            message:
              'Which actions should Bud ask about? Name the objects to create or the row changes to review. Your current rule has not changed.',
          };
        throw error;
      }
    },
    async save(saved: ReviewSettings, mode: 'auto' | 'ask', rule: string, preview: ReviewPreview | null) {
      if (mode === 'ask' && (!preview || preview.revision !== saved.revision)) throw new Error('Rule out of date');
      const input =
        mode === 'auto'
          ? { mode, expectedRevision: saved.revision }
          : { mode, expectedRevision: saved.revision, rule, confirmation: preview?.confirmation };
      return actionReviewSettingsSchema.parse(await settingsRequest(path, AbortSignal.timeout(30000), 'PUT', input));
    },
  };
}
