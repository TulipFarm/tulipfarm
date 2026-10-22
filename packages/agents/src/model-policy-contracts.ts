import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access/contracts';
import { modelFamilyIdSchema } from '@tulipfarm/config/model-identifier';

export { modelFamilyIdSchema };
export const modelPolicyCommandSchema = z
  .strictObject({
    requestId: uuidSchema,
    sourceFamilyId: modelFamilyIdSchema,
    targetFamilyId: modelFamilyIdSchema.nullable(),
    expectedRevision: z.number().int().nonnegative().max(2147483646),
  })
  .refine(value => value.sourceFamilyId !== value.targetFamilyId);
export const modelPolicyRuleSchema = z.object({
  sourceFamilyId: modelFamilyIdSchema,
  targetFamilyId: modelFamilyIdSchema.nullable(),
  revision: z.number().int().nonnegative(),
  editorMembershipId: uuidSchema.nullable(),
  updatedAt: z.iso.datetime().nullable(),
});
export const modelPolicyReceiptSchema = modelPolicyRuleSchema.extend({ requestId: uuidSchema });

export const modelAvailabilitySchema = z.strictObject({
  familyId: modelFamilyIdSchema,
  enabled: z.boolean(),
  revision: z.number().int().nonnegative(),
});
export const modelAvailabilityListSchema = z.strictObject({ items: z.array(modelAvailabilitySchema) });
export const modelAvailabilityCommandSchema = z.strictObject({
  requestId: uuidSchema,
  familyId: modelFamilyIdSchema,
  enabled: z.boolean(),
  expectedRevision: z.number().int().nonnegative().max(2147483646),
});
export const modelAvailabilityReceiptSchema = modelAvailabilitySchema.extend({ requestId: uuidSchema });

export type ModelFamilyEligibility = (input: {
  workspaceId: string;
  modelFamilyId: string;
  fallbackFor?: string;
}) => boolean | Promise<boolean>;
