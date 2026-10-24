import { z } from 'zod';
import { imageAspects, imageQualities } from '@tulipfarm/config/model-catalog-file';
import { imagePresetNames } from '@tulipfarm/media/presets';

/** Most images one turn or run may generate, across all of its calls. */
export const imagesPerOrigin = 8;
const maximumSources = 4;

export const generateImagesCallSchema = z.strictObject({
  tool: z.literal('images.generate'),
  prompt: z.string().min(1).max(4000).describe('What to draw, or for an edit, what to change in the sources'),
  count: z.number().int().min(1).max(4).default(1).describe('How many images, 1 to 4'),
  aspect: z.enum(imageAspects).optional().describe('square, portrait or landscape; square when neither is given'),
  preset: z.enum(imagePresetNames).optional().describe('A named destination such as instagram-feed, instead of aspect'),
  quality: z.enum(imageQualities).default('standard'),
  name: z.string().min(1).max(120).optional().describe('File name without extension'),
  folderId: z.uuid().optional().describe('Files folder to save into'),
  sources: z
    .array(z.uuid())
    .max(maximumSources)
    .optional()
    .describe('attachment-id or file-id of images to edit or combine; makes this call an edit'),
});
