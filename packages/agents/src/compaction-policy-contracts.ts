import { z } from 'zod';
import { modelFamilyIdSchema } from '@tulipfarm/config/model-identifier';

// The server accepts only families its effective catalog approves for summary work.
const budgetFamilySchema = modelFamilyIdSchema;
const outputPromptSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(value => !value.includes('\0'), 'Text must be valid PostgreSQL Unicode');

const settings = {
  automatic: z.boolean(),
  triggerPercent: z.number().int().min(2).max(99),
  targetPercent: z.number().int().min(1).max(98),
  modelFamilyId: budgetFamilySchema,
  fallbackFamilyId: budgetFamilySchema.nullable(),
  outputPrompt: outputPromptSchema.nullable(),
};
function consistent<
  T extends { triggerPercent: number; targetPercent: number; modelFamilyId: string; fallbackFamilyId: string | null },
>(schema: z.ZodType<T>) {
  return schema
    .refine(value => value.targetPercent < value.triggerPercent, {
      path: ['targetPercent'],
      message: 'Target must be below the trigger',
    })
    .refine(value => value.fallbackFamilyId !== value.modelFamilyId, {
      path: ['fallbackFamilyId'],
      message: 'Fallback must differ from the summary model',
    });
}

export const compactionPolicyCommandSchema = consistent(
  z.strictObject({ requestId: z.uuid(), expectedRevision: z.number().int().nonnegative(), ...settings }),
);
export const compactionBudgetFamilySchema = z.object({
  id: budgetFamilySchema,
  name: z.string(),
  enabled: z.boolean(),
});
export const compactionPolicySchema = z.object({
  ...settings,
  revision: z.number().int().nonnegative(),
  editorMembershipId: z.uuid().nullable(),
  updatedAt: z.string().nullable(),
  budgetFamilies: z.array(compactionBudgetFamilySchema),
});
export const compactionPolicyReceiptSchema = compactionPolicySchema.extend({ requestId: z.uuid() });
export type CompactionPolicy = z.infer<typeof compactionPolicySchema>;
export type CompactionPolicyCommand = z.infer<typeof compactionPolicyCommandSchema>;
