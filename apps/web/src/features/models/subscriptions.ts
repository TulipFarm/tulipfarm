import { z } from 'zod';

const grantSchema = z.object({
  grantee: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('member'), membershipId: z.uuid() }),
    z.object({ kind: z.literal('team'), teamId: z.uuid() }),
    z.object({ kind: z.literal('workspace') }),
  ]),
  role: z.enum(['use', 'manage']),
});
/** A plan account connected to the workspace, as the Models page lists it. */
export const subscriptionSchema = z.object({
  connectionId: z.uuid(),
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
  ownerMembershipId: z.uuid(),
  account: z.string().nullable(),
  endpoint: z.string().nullable().optional().default(null),
  state: z.enum(['connected', 'plan-disabled', 'reconnect-required', 'signed-out']),
  mine: z.boolean(),
  models: z.array(z.object({ slug: z.string(), label: z.string() })),
  disabledModels: z.array(z.string()),
  canShare: z.boolean(),
  grants: z.array(grantSchema).nullable(),
  plan: z.string().nullable(),
  useForChat: z.boolean(),
  useForCoding: z.boolean(),
  createdAt: z.string(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;
