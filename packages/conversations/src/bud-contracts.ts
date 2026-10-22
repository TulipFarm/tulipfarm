import { z } from 'zod';

export const budGreeting = "Hey, I'm Bud, your personal assistant. What would you like to get done?";
export const budPersona =
  "You are Bud, the user's built-in personal assistant in this workspace. Be warm, brief, and helpful. Ask one question at a time. Guide the user's goal, not a fixed checklist. Proactively suggested business changes need the user's acceptance and all normal permissions and approvals. After guiding an integration setup, recheck the integration with its existing tools when the user returns; navigation and consent alone are not success. Personal preferences never grant authority.";
export const budPreferenceTopic = z.enum(['reply-style', 'role', 'goals']);
const question = z.string().trim().min(1).max(500);
const value = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(text => !text.includes('\0'));
export const budPreferenceAskSchema = z.strictObject({
  tool: z.literal('bud.preference.ask'),
  topic: budPreferenceTopic,
  question,
});
export const budPreferenceProposeSchema = z.strictObject({
  tool: z.literal('bud.preference.propose'),
  topic: budPreferenceTopic,
  question,
  value,
});
export const budPreferenceSchema = z.strictObject({
  id: z.uuid(),
  conversationId: z.uuid(),
  topic: budPreferenceTopic,
  question,
  value: value.nullable(),
  status: z.enum(['asking', 'proposed', 'saved', 'dismissed', 'undone']),
  expectedRevision: z.number().int().nonnegative(),
  savedRevision: z.number().int().nullable(),
});
export const budNudgeSchema = z.strictObject({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  suggestionId: z.string(),
  question: z.string(),
  presented: z.boolean(),
  action: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('prompt'), prompt: z.string() }),
    z.strictObject({
      kind: z.literal('open'),
      destination: z.enum(['integrations', 'files', 'members']),
      sourcePicker: z.enum(['github', 'slack', 'google']).optional(),
    }),
  ]),
});
export const budStateSchema = z.strictObject({
  conversationId: z.uuid().nullable(),
  onboarding: z.enum(['active', 'completed', 'skipped', 'ineligible']),
  bubblesEnabled: z.boolean(),
  snoozedUntil: z.string().nullable(),
  nudge: budNudgeSchema.nullable(),
  preferences: z.array(budPreferenceSchema),
});
export type BudState = z.infer<typeof budStateSchema>;
export type BudPreference = z.infer<typeof budPreferenceSchema>;
export const budCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('bootstrap') }),
  z.strictObject({ kind: z.literal('sync') }),
  z.strictObject({ kind: z.literal('open') }),
  z.strictObject({ kind: z.literal('skip') }),
  z.strictObject({
    kind: z.literal('settings'),
    enabled: z.boolean().optional(),
    snoozedUntil: z.iso.datetime().nullable().optional(),
  }),
  z.strictObject({ kind: z.literal('present'), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ kind: z.literal('open-nudge'), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ kind: z.literal('dismiss'), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ kind: z.literal('answer-preference'), id: z.uuid(), value }),
  z.strictObject({ kind: z.literal('accept-preference'), id: z.uuid() }),
  z.strictObject({ kind: z.literal('dismiss-preference'), id: z.uuid() }),
  z.strictObject({ kind: z.literal('undo-preference'), id: z.uuid() }),
]);
