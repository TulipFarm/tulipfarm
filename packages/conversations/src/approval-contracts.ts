import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access';
import { textPartSchema } from './contracts.ts';

export const approvalInputSchema = z.strictObject({
  producerId: uuidSchema,
  prompt: textPartSchema.shape.text,
  migrationId: uuidSchema,
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const approvalDecisionSchema = z.strictObject({
  commandId: uuidSchema,
  expectedRevision: z.number().int().positive(),
  decision: z.enum(['approve', 'reject', 'cancel']),
});
export const approvalOutcomeSchema = z.object({
  requestId: uuidSchema,
  revision: z.number().int().positive(),
  status: z.enum(['approved', 'rejected', 'cancelled', 'expired']),
  confirmationId: uuidSchema.nullable(),
});
export const approvalViewSchema = z.object({
  id: uuidSchema,
  turnId: uuidSchema,
  revision: z.number().int().positive(),
  prompt: z.string(),
  expiresAt: z.string(),
  action: z.object({
    kind: z.literal('table-migration'),
    migrationId: uuidSchema,
    tableId: uuidSchema,
    planDigest: z.string(),
    expectedAppliedRevision: z.string().nullable(),
    effect: z.unknown(),
  }),
  resolution: approvalOutcomeSchema.nullable(),
});
