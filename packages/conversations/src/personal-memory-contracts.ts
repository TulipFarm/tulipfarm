import { z } from 'zod';
import { personalMemorySchema } from '@tulipfarm/memory-core/personal-memory-contracts';
export * from '@tulipfarm/memory-core/personal-memory-contracts';

/** One edit that background learning suggests for the member's memory. Nothing changes until they confirm it. */
export const memoryProposalSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(['add', 'change', 'remove']),
  /** The memory text the edit changes or removes; null for an addition. */
  before: z.string().nullable(),
  /** The new text; null for a removal. */
  after: z.string().nullable(),
  /** The member's own words the suggestion is based on. */
  quote: z.string(),
  conversationId: z.uuid(),
  conversationTitle: z.string(),
  createdAt: z.string(),
  /** The memory changed since the suggestion was made, so it cannot be confirmed as it is. */
  outdated: z.boolean(),
});
export type MemoryProposal = z.infer<typeof memoryProposalSchema>;
export const memoryProposalsSchema = z.strictObject({
  memory: personalMemorySchema,
  proposals: z.array(memoryProposalSchema),
});
export type MemoryProposals = z.infer<typeof memoryProposalsSchema>;
