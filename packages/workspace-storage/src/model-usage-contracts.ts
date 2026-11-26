import { z } from 'zod';

/** What usage can be grouped by. `day` and `week` group by time and cannot be filtered. */
export const usageDimensionSchema = z.enum([
  'model',
  'provider',
  'paidBy',
  'connection',
  'usedBy',
  'member',
  'agent',
  'activity',
  'fallback',
  'day',
  'week',
]);
export type UsageDimension = z.infer<typeof usageDimensionSchema>;
export const usageFilterDimensionSchema = usageDimensionSchema.exclude(['day', 'week']);
export type UsageFilterDimension = z.infer<typeof usageFilterDimensionSchema>;
export const usageFilterDimensions = usageFilterDimensionSchema.options;

/** What paid for a model call: workspace credits, a member's plan (ChatGPT, Claude or Copilot), or an API key. */
export const usagePaidBySchema = z.enum(['credits', 'plan', 'key']);
export type UsagePaidBy = z.infer<typeof usagePaidBySchema>;

export const usageQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  /** One or two levels; the second nests under the first. */
  group: z.array(usageDimensionSchema).min(1).max(2),
  filters: z.partialRecord(usageFilterDimensionSchema, z.array(z.string().max(300)).max(200)).default({}),
  timeZone: z.string().max(64).default('UTC'),
});
export type UsageQuery = z.infer<typeof usageQuerySchema>;

/**
 * Measures of a group. `billedUsd` is the list price of calls paid with credits or API keys; `planValueUsd` is the list
 * price of calls a member's plan answered, which the provider bills to the plan. `credits` includes any plan fee the
 * deployment charges on that value.
 */
export const usageMeasuresSchema = z.object({
  requests: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  credits: z.number().nonnegative(),
  billedUsd: z.number().nonnegative(),
  planValueUsd: z.number().nonnegative(),
  fallbacks: z.number().nonnegative(),
});
export type UsageMeasures = z.infer<typeof usageMeasuresSchema>;
export type UsageMeasure = keyof UsageMeasures;

export const usagePlanStatusSchema = z.object({
  status: z.enum(['available', 'limit-reached', 'reconnect']),
  limitedAt: z.string().nullable(),
  premiumRequests: z.object({ remaining: z.number(), entitlement: z.number() }).nullable(),
});
export type UsagePlanStatus = z.infer<typeof usagePlanStatusSchema>;

export const usageConnectionSchema = z.object({
  id: z.string(),
  provider: z.enum([
    'chatgpt',
    'claude',
    'copilot',
    'byok-anthropic',
    'byok-openai',
    'byok-google',
    'byok-xai',
    'byok-openai-compatible',
  ]),
  ownerMembershipId: z.string(),
  plan: z.string().nullable(),
  status: usagePlanStatusSchema,
});
export type UsageConnection = z.infer<typeof usageConnectionSchema>;

export const usageReportSchema = z.object({
  viewer: z.object({ membershipId: z.string(), admin: z.boolean() }),
  /** Workspace credits; null when credits are unlimited. `grace` is how far below zero it may spend, null without grace. */
  balance: z.object({
    available: z.number().nullable(),
    granted: z.number().nullable(),
    grace: z.number().nonnegative().nullable().optional(),
  }),
  /** Grouped rows: `keys` holds one value per group level. */
  rows: z.array(usageMeasuresSchema.extend({ keys: z.array(z.string()) })),
  /** Each day by the first group level, for the chart over time. */
  series: z.array(usageMeasuresSchema.extend({ date: z.string(), key: z.string() })),
  /** Every value of each filterable dimension in the range, ignoring filters, with its measures. */
  options: z.partialRecord(usageFilterDimensionSchema, z.array(usageMeasuresSchema.extend({ value: z.string() }))),
  labels: z.object({
    /** Model names, with the vendor that makes each model when the catalog knows it. */
    models: z.record(z.string(), z.object({ name: z.string(), vendor: z.string().nullable() })),
    agents: z.record(z.string(), z.string()),
    connections: z.record(z.string(), usageConnectionSchema),
  }),
  /** When chat calls started recording tokens and payment sources; null before the first one. */
  detailSince: z.string().nullable(),
  truncated: z.boolean(),
});
export type UsageReport = z.infer<typeof usageReportSchema>;
