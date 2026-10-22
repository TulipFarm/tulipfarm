import { z } from 'zod';
import { modelProviderSchema } from './model-capabilities.ts';
import { modelFamilyIdSchema, modelIdentifierSchema } from './model-identifier.ts';

const family = z.strictObject({
  id: modelFamilyIdSchema,
  displayName: z.string().min(1),
  vendor: modelIdentifierSchema.describe(
    'Who makes the model, from the catalog entry; clients use it for branding and show a neutral logo when unknown',
  ),
  currentVersion: z
    .string()
    .min(1)
    .nullable()
    .describe('Active registry model ID, including restricted routes; null when no active mapping exists'),
  provider: modelProviderSchema,
  inputCreditsPerMillionTokens: z
    .number()
    .nonnegative()
    .nullable()
    .describe(
      'Date-effective base-context input rate, before aggregate rounding; null when unknown or the family is unmetered',
    ),
  outputCreditsPerMillionTokens: z
    .number()
    .nonnegative()
    .nullable()
    .describe(
      'Date-effective base-context output rate, before aggregate rounding; null when unknown or the family is unmetered',
    ),
});

export const modelCatalogFamilySchema = z.discriminatedUnion('available', [
  family.extend({
    available: z.literal(true),
    unavailableReason: z.null(),
    mappingRevision: modelIdentifierSchema,
    pricingRevision: modelIdentifierSchema,
    fallbackFor: z.array(modelFamilyIdSchema).describe('Source families for which this family is an eligible fallback'),
  }),
  family.extend({
    available: z.literal(false),
    unavailableReason: z
      .enum(['model-family-unavailable', 'model-family-paused', 'workspace-disabled'])
      .describe(
        'Platform unavailability takes precedence over a platform pause, and a pause over workspace disablement. A paused family is served for existing agents and chats but cannot be chosen for new ones. Workspace enabled state is reported by model-policy/availability.',
      ),
    mappingRevision: modelIdentifierSchema.nullable(),
    pricingRevision: modelIdentifierSchema.nullable(),
    fallbackFor: z.array(modelFamilyIdSchema).max(0),
  }),
]);

export const modelCatalogSchema = z.strictObject({
  families: z.array(modelCatalogFamilySchema),
  defaultChatFamilyId: modelFamilyIdSchema
    .nullable()
    .optional()
    .describe("Family new chats and agents use unless the person chose one: the server catalog's default model"),
});
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
export type ModelCatalogFamily = z.infer<typeof modelCatalogFamilySchema>;
