import { z } from 'zod';

export const uuidSchema = z.uuid();
export const sourceRow = z.object({
  id: uuidSchema,
  provider: z.enum(['note', 'file', 'google', 'slack', 'github', 'confluence', 'jira', 'conversation']),
  owner_membership_id: uuidSchema,
  account_namespace: z.string(),
  selection: z.string(),
  state: z.enum(['active', 'paused', 'disconnected', 'removed']),
  access_epoch: z.number().int().positive(),
});
export const documentRow = z.object({
  id: uuidSchema,
  source_id: uuidSchema,
  native_id: z.string(),
  observed_revision_id: uuidSchema.nullable(),
  lexical_publication_id: uuidSchema.nullable(),
  vector_publication_id: uuidSchema.nullable(),
  tombstoned_at: z.date().nullable(),
});
export type ExternalSource = z.infer<typeof sourceRow>;
export type KnowledgeDocument = z.infer<typeof documentRow>;
export type Principal = { kind: 'human'; userId: string; membershipId: string };
export type Actor = Principal | { kind: 'agent'; runId: string };
