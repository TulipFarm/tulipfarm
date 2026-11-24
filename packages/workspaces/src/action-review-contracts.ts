import { z } from 'zod';
import { reviewActionSchema, reviewPolicySchema } from '@tulipfarm/workspace-storage/action-review-contracts';

const revision = z.number().int().nonnegative();
const rule = z.string().trim().min(1).max(500);
const confirmation = z.string().regex(/^[a-f0-9]{64}$/);
export const actionReviewSettingsSchema = reviewPolicySchema.extend({ canManage: z.boolean() });
export const previewReviewSchema = z.strictObject({ rule });
export const reviewPreviewSchema = z.object({
  revision,
  interpretation: z.string(),
  actions: z.array(reviewActionSchema),
  confirmation,
});
export const saveReviewSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('auto'), expectedRevision: revision }),
  z.strictObject({ mode: z.literal('ask'), expectedRevision: revision, rule, confirmation }),
]);
