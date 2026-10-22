import { z } from 'zod';

export const recommendationLimit = 5;
export const recommendationPolicy = 'event-driven-v1';
export const recommendationBrandSchema = z.enum(['gmail', 'google-calendar', 'github', 'slack']);
export const recommendationSchema = z.strictObject({
  id: z.string().min(1).max(100),
  kind: z.enum(['onboarding', 'prompt']),
  label: z.string().trim().min(1).max(160),
  brands: z.array(recommendationBrandSchema).max(4),
  facts: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  action: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('prompt'), prompt: z.string().trim().min(1).max(2000) }),
    z.strictObject({
      kind: z.literal('open'),
      destination: z.enum(['integrations', 'files', 'members']),
      sourcePicker: z.enum(['github', 'slack', 'google']).optional(),
    }),
  ]),
});
export type Recommendation = z.infer<typeof recommendationSchema>;
export const recommendationItemsSchema = z
  .array(recommendationSchema)
  .max(recommendationLimit)
  .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Duplicate recommendation');
export const recommendationStatusSchema = z.enum([
  'pending',
  'running',
  'ready',
  'failed',
  'budget-paused',
  'unavailable',
]);
export const recommendationListSchema = z.strictObject({
  onboarding: z.boolean(),
  items: recommendationItemsSchema.length(recommendationLimit),
  status: recommendationStatusSchema,
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type RecommendationList = z.infer<typeof recommendationListSchema>;
export const recommendationSourceSchema = z.strictObject({
  kind: z.enum([
    'table',
    'agent',
    'skill',
    'workflow',
    'integration',
    'memory',
    'knowledge',
    'file',
    'project',
    'membership',
    'settings',
  ]),
  id: z.string().min(1).max(256),
  revision: z.string().max(256),
});
export type RecommendationSource = z.infer<typeof recommendationSourceSchema>;
export const generatedPromptSchema = recommendationSchema.extend({
  kind: z.literal('prompt'),
  action: z.strictObject({ kind: z.literal('prompt'), prompt: z.string().trim().min(1).max(2000) }),
  sources: z.array(z.string().min(1).max(300)).max(30),
});
export const generatedPromptsSchema = z.array(generatedPromptSchema).max(recommendationLimit);
export const recommendationNotificationSchema = z.strictObject({
  workspaceId: z.uuid(),
  membershipId: z.uuid(),
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  kind: z.enum(['changed', 'invalidated']),
});
export type RecommendationNotification = z.infer<typeof recommendationNotificationSchema>;
export type RecommendationStreamEvent = RecommendationNotification | { kind: 'resync' };
