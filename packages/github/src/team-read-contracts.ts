import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access/contracts';

export const teamGitHubReadBindingSchema = z.strictObject({
  integrationId: uuidSchema,
  generation: z.number().int().positive(),
  membershipId: uuidSchema,
  selectionVersion: z.number().int().positive(),
  origin: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('chat'), conversationId: uuidSchema, turnId: uuidSchema }),
    z.strictObject({ kind: z.literal('task'), taskId: uuidSchema, generation: z.number().int().nonnegative() }),
  ]),
});
export type TeamGitHubReadBinding = z.infer<typeof teamGitHubReadBindingSchema>;
export const teamGitHubRepositoryQuerySchema = z.strictObject({
  query: z.string().trim().max(256).optional(),
  page: z.number().int().min(1).max(100).default(1),
  perPage: z.number().int().min(1).max(30).default(10),
});
