// Browser-safe compaction shapes shared by the API, worker, and web client.
import { z } from 'zod';

export const compactionStateSchema = z.enum(['compacted', 'cleaned', 'unchanged', 'failed']);
export const compactionTriggerSchema = z.enum(['manual', 'automatic', 'handoff-retry', 'inactivity']);
export const handoffStatusSchema = z.enum(['pending', 'completed', 'failed']);
export const compactionPartSchema = z.strictObject({
  kind: z.literal('compaction'),
  compactionId: z.uuid(),
  trigger: compactionTriggerSchema,
  state: compactionStateSchema,
  beforeTokens: z.number().int().nullable(),
  afterTokens: z.number().int().nullable(),
  windowTokens: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  handoffStatus: handoffStatusSchema.nullable(),
});
export const compactCommandPartSchema = z.strictObject({
  kind: z.literal('compact'),
  prompt: z.string().nullable(),
  compactionId: z.uuid().nullable(),
});
export const compactionDetailSchema = z.object({
  id: z.uuid(),
  trigger: compactionTriggerSchema,
  state: compactionStateSchema,
  createdAt: z.string(),
  coveredThrough: z.number().int().nullable().default(null),
  beforeTokens: z.number().int().nullable(),
  afterTokens: z.number().int().nullable(),
  windowTokens: z.number().int().nullable(),
  triggerPercent: z.number().int(),
  targetPercent: z.number().int(),
  modelFamilyId: z.string().nullable(),
  fallbackFromFamilyId: z.string().nullable(),
  errorCode: z.string().nullable(),
  cleanedMessages: z.number().int(),
  handoff: z
    .object({
      status: handoffStatusSchema,
      text: z.string().nullable(),
      prompt: z.string().nullable(),
      modelFamilyId: z.string().nullable(),
      fallbackFromFamilyId: z.string().nullable(),
      errorCode: z.string().nullable(),
      attempts: z.number().int(),
    })
    .nullable(),
});
export type CompactionDetail = z.infer<typeof compactionDetailSchema>;
