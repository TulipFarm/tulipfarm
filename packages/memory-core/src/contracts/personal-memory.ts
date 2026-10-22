import { z } from 'zod';

export const personalMemoryMaximumCharacters = 10000;
const content = z
  .string()
  .refine(
    value =>
      !value.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value),
    'Invalid text',
  )
  .refine(
    value => Array.from(value).length <= personalMemoryMaximumCharacters,
    'Personal memory exceeds 10000 characters',
  );
const revision = z.number().int().min(0).max(2147483647);
export const personalMemorySchema = z.strictObject({ content: z.string(), revision });
export const savePersonalMemorySchema = z.strictObject({ content, expectedRevision: revision.max(2147483646) });
export const deletePersonalMemorySchema = savePersonalMemorySchema.omit({ content: true });
export type PersonalMemory = z.infer<typeof personalMemorySchema>;
