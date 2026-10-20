import { z } from 'zod';
import { createWorkspaceSchema } from './contracts.ts';

export const onboardingTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const onboardingDetailsSchema = createWorkspaceSchema
  .pick({ name: true, slug: true })
  .extend({
    accountType: z.enum(['personal', 'business']),
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .max(40)
      .default([]),
  })
  .strict();
export const saveOnboardingSchema = z
  .object({
    token: onboardingTokenSchema,
    details: onboardingDetailsSchema,
  })
  .strict();
export const resumeOnboardingSchema = z.object({ token: onboardingTokenSchema }).strict();
export const completeOnboardingSchema = resumeOnboardingSchema.extend({
  challengeToken: z.string().max(2048).optional(),
});
export const onboardingDraftSchema = z.object({
  id: z.uuid(),
  details: onboardingDetailsSchema,
  expiresAt: z.iso.datetime(),
});
export type OnboardingDetails = z.infer<typeof onboardingDetailsSchema>;
