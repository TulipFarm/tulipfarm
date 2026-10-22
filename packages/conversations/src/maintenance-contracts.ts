import { z } from 'zod';

export const maintenanceStateSchema = z.enum([
  'queued',
  'running',
  'publishing',
  'ready',
  'blocked',
  'failed',
  'stale',
]);
export const maintenanceViewSchema = z.object({
  maintenance: z
    .object({
      id: z.uuid(),
      generation: z.number().int(),
      coveredThrough: z.number().int().nullable(),
      state: maintenanceStateSchema,
      errorCode: z.string().nullable(),
      retryAt: z.string().nullable(),
      compactionId: z.uuid().nullable(),
      embeddingStatus: z.string().nullable(),
    })
    .nullable(),
});
export type MaintenanceView = z.infer<typeof maintenanceViewSchema>;
export const maintenanceWorkSchema = z.object({
  workspaceId: z.uuid(),
  conversationId: z.uuid(),
  jobId: z.uuid(),
  generation: z.number().int().nonnegative(),
});
export const maintenanceFenceSchema = maintenanceWorkSchema.extend({
  kind: z.literal('maintenance'),
  epoch: z.number().int().positive(),
});
export type MaintenanceWork = z.infer<typeof maintenanceWorkSchema>;
export type MaintenanceFence = z.infer<typeof maintenanceFenceSchema>;
