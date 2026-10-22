import { z } from 'zod';

export const googleFileIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const googleFilesSearchSchema = z.object({
  drive: googleFileIdSchema.optional().catch(undefined),
  shared: z.literal(true).optional().catch(undefined),
});
export type GoogleFilesSearch = z.infer<typeof googleFilesSearchSchema>;
