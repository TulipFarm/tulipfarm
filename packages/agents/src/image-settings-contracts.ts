import { z } from 'zod';
import { modelFamilyIdSchema } from '@tulipfarm/config/model-identifier';

const settings = {
  /** Null reads images with the catalog's document-vision model. */
  recognitionFamilyId: modelFamilyIdSchema.nullable(),
  /** Null generates with the catalog's default image model. */
  defaultImageModelId: modelFamilyIdSchema.nullable(),
  generationEnabled: z.boolean(),
};

export const imageSettingsCommandSchema = z.strictObject({
  requestId: z.uuid(),
  expectedRevision: z.number().int().nonnegative().max(2147483646),
  ...settings,
});
export const imageSettingsChoiceSchema = z.object({
  id: modelFamilyIdSchema,
  name: z.string(),
  /** Served, not paused, and enabled in this workspace. */
  enabled: z.boolean(),
});
export const imageSettingsSchema = z.object({
  ...settings,
  revision: z.number().int().nonnegative(),
  editorMembershipId: z.uuid().nullable(),
  updatedAt: z.string().nullable(),
  /** What applies now: the saved choice, or else the catalog default. Null when nothing resolves. */
  effective: z.object({
    recognitionFamilyId: modelFamilyIdSchema.nullable(),
    defaultImageModelId: modelFamilyIdSchema.nullable(),
  }),
  /** Families that read images, for the recognition model. */
  recognitionFamilies: z.array(imageSettingsChoiceSchema),
  imageModels: z.array(imageSettingsChoiceSchema),
});
export const imageSettingsReceiptSchema = imageSettingsSchema.extend({ requestId: z.uuid() });

export type ImageSettings = z.infer<typeof imageSettingsSchema>;
export type ImageSettingsCommand = z.infer<typeof imageSettingsCommandSchema>;
