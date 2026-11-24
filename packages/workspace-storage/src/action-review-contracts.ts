import { z } from 'zod';

export const reviewActionSchema = z.enum([
  'create-table',
  'create-agent',
  'create-skill',
  'create-workflow',
  'create-row',
  'update-row',
  'delete-row',
]);
export type ReviewAction = z.infer<typeof reviewActionSchema>;
export const reviewPolicySchema = z.object({
  mode: z.enum(['legacy', 'auto', 'ask']),
  revision: z.number().int().nonnegative(),
  rule: z.string().min(1).nullable(),
  interpretation: z.string().min(1).nullable(),
  actions: z.array(reviewActionSchema),
});
export type ReviewPolicy = z.infer<typeof reviewPolicySchema>;
