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
  imageInput: z
    .boolean()
    .default(false)
    .describe('Reads attached images directly; otherwise it reads their recognised text'),
  imageModelId: modelFamilyIdSchema
    .nullable()
    .default(null)
    .describe("Image model paired with this family; null uses the workspace's default image model"),
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

const aspectCredits = z.strictObject({
  square: z.number().nonnegative(),
  portrait: z.number().nonnegative(),
  landscape: z.number().nonnegative(),
});
export const modelCatalogImageModelSchema = z.strictObject({
  id: modelFamilyIdSchema,
  displayName: z.string().min(1),
  vendor: modelIdentifierSchema,
  provider: modelProviderSchema,
  edits: z.boolean().describe('Can edit or combine source images'),
  available: z.boolean(),
  unavailableReason: z
    .enum(['image-model-unavailable', 'image-model-paused', 'workspace-disabled'])
    .nullable()
    .describe(
      'Null when available. Not served by this deployment, paused by the operator, or disabled by the workspace.',
    ),
  creditsPerImage: z
    .strictObject({ standard: aspectCredits, high: aspectCredits })
    .nullable()
    .describe('Credits per generated image by quality and shape; null when priced by tokens or unmetered'),
  outputCreditsPerMillionTokens: z
    .number()
    .nonnegative()
    .nullable()
    .describe('Date-effective base output rate for token-priced image models; null otherwise'),
});

export const modelCatalogSchema = z.strictObject({
  families: z.array(modelCatalogFamilySchema),
  imageModels: z.array(modelCatalogImageModelSchema).default([]),
  defaultChatFamilyId: modelFamilyIdSchema
    .nullable()
    .optional()
    .describe("Family new chats and agents use unless the person chose one: the server catalog's default model"),
});
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
export type ModelCatalogFamily = z.infer<typeof modelCatalogFamilySchema>;
export type ModelCatalogImageModel = z.infer<typeof modelCatalogImageModelSchema>;
