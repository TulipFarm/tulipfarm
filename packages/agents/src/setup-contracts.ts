import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access/contracts';
import { agentDefinitionSchema, definitionRevisionSchema, scopeSchema, taskLimitsSchema } from './contracts.ts';
import { agentPolicySchema, soulRevisionSchema } from './saved-contracts.ts';
import { scheduleActionSchema, scheduleTriggerSchema } from './schedule-contracts.ts';

export const agentSetupDetailsSchema = z.strictObject({
  policy: agentPolicySchema.pick({ grants: true, personGrants: true }),
  enrollment: z.array(uuidSchema).max(100),
  scope: scopeSchema,
  limits: scopeSchema,
  taskLimits: taskLimitsSchema,
  slackSender: z.enum(['user', 'app']),
  slackChannels: z.array(
    z.strictObject({
      channel: z.string().regex(/^[CG][A-Z0-9]{1,63}$/),
      expectedVersion: z.number().int().nonnegative(),
      replaceAgentId: uuidSchema.nullable(),
      detach: z.boolean().optional(),
    }),
  ),
  schedules: z
    .array(
      z.strictObject({
        id: uuidSchema,
        trigger: scheduleTriggerSchema,
        action: scheduleActionSchema.options[1],
        sponsorMembershipId: uuidSchema,
      }),
    )
    .max(100),
});
export const agentSetupSchema = agentSetupDetailsSchema
  .extend({
    definition: agentDefinitionSchema,
    owningTeamId: uuidSchema.nullable(),
  })
  .superRefine((setup, context) => {
    for (const [field, values] of [
      ['slackChannels', setup.slackChannels.map(item => item.channel)],
      ['schedules', setup.schedules.map(item => item.id)],
      ['enrollment', setup.enrollment],
    ] as const) {
      if (new Set(values).size !== values.length)
        context.addIssue({ code: 'custom', path: [field], message: 'Selections must be unique.' });
    }
  });

const expectedSetup = {
  expectedSoulRevision: soulRevisionSchema,
  expectedSavedRevision: soulRevisionSchema.nullable(),
  expectedPolicyVersion: z.number().int().nonnegative(),
  expectedActivationIds: z.array(uuidSchema),
};
export const saveAgentSetupDraftSchema = z.strictObject({
  requestId: uuidSchema,
  expectedVersion: z.number().int().nonnegative(),
  ...expectedSetup,
  setup: agentSetupSchema,
});
export const agentSetupDraftSchema = z.object({
  agentId: uuidSchema,
  version: z.number().int().positive(),
  digest: definitionRevisionSchema,
  commandId: uuidSchema.nullable().optional(),
  ...expectedSetup,
  setup: agentSetupSchema,
});
export const agentSetupConsentSchema = z.strictObject({
  sponsorScheduleIds: z.array(uuidSchema),
  replaceChannels: z.array(z.string().regex(/^[CG][A-Z0-9]{1,63}$/)),
});
export const publishAgentSetupSchema = z.strictObject({
  requestId: uuidSchema,
  version: z.number().int().positive(),
  digest: definitionRevisionSchema,
  decision: z.enum(['save', 'activate']),
  consent: agentSetupConsentSchema,
});
export const agentSetupReceiptSchema = z.object({
  commandId: uuidSchema,
  agentId: uuidSchema,
  version: z.number().int().positive(),
  digest: definitionRevisionSchema,
  status: z.enum(['preparing', 'saved', 'active', 'blocked', 'conflict', 'failed']),
  savedRevision: soulRevisionSchema.nullable(),
  activationId: uuidSchema.nullable(),
  error: z.string().nullable(),
});
export type AgentSetup = z.infer<typeof agentSetupSchema>;
export type SaveAgentSetupDraft = z.infer<typeof saveAgentSetupDraftSchema>;
export type AgentSetupDraft = z.infer<typeof agentSetupDraftSchema>;
export type PublishAgentSetup = z.infer<typeof publishAgentSetupSchema>;
export type AgentSetupReceipt = z.infer<typeof agentSetupReceiptSchema>;
