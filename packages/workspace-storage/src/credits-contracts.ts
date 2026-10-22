import { z } from 'zod';

export const creditActivitySchema = z.enum([
  'chat',
  'agent',
  'other',
  'table-search',
  'knowledge-ingestion',
  'knowledge-query',
  'knowledge-reindex',
]);

// Workspace scope reports all usage, including agent identities, to admins. Personal scope covers only
// usage from the caller's own flows and omits workspace-wide totals other than the balance.
export const creditUsageScopeSchema = z.enum(['workspace', 'personal']);

export const creditSummarySchema = z.object({
  scope: creditUsageScopeSchema.optional(),
  // Null when no billing extension keeps a balance: credits are unlimited.
  available: z.number().nonnegative().nullable(),
  granted: z.number().nonnegative().nullable(),
  used: z.number().nonnegative(),
  held: z.number().nonnegative(),
  unfunded: z.number().nonnegative().optional(),
  days: z.array(z.object({ date: z.string(), credits: z.number().nonnegative() })),
  breakdown: z.array(
    z.object({
      modelId: z.string(),
      agentId: z.string().nullable(),
      agentName: z.string().nullable().optional(),
      activity: creditActivitySchema,
      credits: z.number().nonnegative(),
      calls: z.number().int().nonnegative(),
    }),
  ),
  // Daily credits and calls per model, agent, and activity. Days without calls are omitted.
  series: z.array(
    z.object({
      date: z.string(),
      modelId: z.string(),
      agentId: z.string().nullable(),
      agentName: z.string().nullable().optional(),
      activity: creditActivitySchema,
      credits: z.number().nonnegative(),
      calls: z.number().int().nonnegative(),
    }),
  ),
});
export type CreditSummary = z.infer<typeof creditSummarySchema>;
