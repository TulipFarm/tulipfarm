import { z } from 'zod';
import { imageAspects, imageQualities } from '@tulipfarm/config/model-catalog-file';
import { channelImageProblemCodes, imageChannels, imagePresetNames } from '@tulipfarm/media/presets';

/** Most images one turn or run may generate, across all of its calls. */
export const imagesPerOrigin = 8;
const maximumSources = 4;

export const generateImagesCallSchema = z.strictObject({
  tool: z.literal('images.generate'),
  prompt: z.string().min(1).max(4000),
  count: z.number().int().min(1).max(4).default(1),
  aspect: z.enum(imageAspects).optional().describe('Default: square.'),
  preset: z.enum(imagePresetNames).optional().describe('Instead of aspect'),
  channel: z.enum(imageChannels).optional().describe('Channel preset by default; checks media rules.'),
  quality: z.enum(imageQualities).default('standard'),
  name: z.string().min(1).max(120).optional().describe('Name without extension.'),
  folderId: z.uuid().optional(),
  sources: z.array(z.uuid()).max(maximumSources).optional().describe('Attachment/file IDs to edit or combine.'),
});

/** Each image moves from `pending` to exactly one final state. Only `failed` and `cancelled` images are tried again. */
export const imageStates = ['pending', 'saved', 'refused', 'failed', 'cancelled'] as const;
export const imageFailures = [
  'content-refused',
  'credits-exhausted',
  'task-credits',
  'generation-failed',
  'in-progress',
  'size',
  'quota',
  'busy',
  'conflict',
] as const;
/** Why a call generated nothing, decided in this order before any credits are held. */
export const imageCallErrors = [
  'invalid-request',
  'image-model-unavailable',
  'image-limit-exceeded',
  'image-edit-unsupported',
  'source-unreadable',
  'destination-required',
] as const;
export const generatedImageSchema = z.strictObject({
  index: z.number().int().min(0).max(3),
  /** Also the id of the saved file. */
  id: z.uuid(),
  state: z.enum(imageStates),
  file: z
    .strictObject({
      id: z.uuid(),
      name: z.string(),
      mediaType: z.string(),
      size: z.number().int().nonnegative(),
      parentId: z.uuid().nullable(),
    })
    .optional(),
  failure: z.enum(imageFailures).optional(),
  /** For a call naming a channel: whether the saved image meets the channel's media rules, and which it breaks. */
  channel: z
    .strictObject({
      name: z.enum(imageChannels),
      usable: z.boolean(),
      problems: z.array(z.enum(channelImageProblemCodes)),
    })
    .optional(),
});
/** What an `images.generate` call returns to the model, and what runs store as the call's result. */
export const imageOutputResultSchema = z.union([
  z.strictObject({
    images: z.array(generatedImageSchema).min(1).max(4),
    instruction: z.string(),
    error: z.literal('content-refused').optional(),
  }),
  z.strictObject({
    error: z.enum(imageCallErrors),
    instruction: z.string(),
    alternativeFamilyId: z.string().nullable().optional(),
    remaining: z.number().int().nonnegative().optional(),
  }),
]);
