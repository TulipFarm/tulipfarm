import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access/contracts';
import { agentDefinitionSchema, definitionRevisionSchema, scopeSchema, taskLimitsSchema } from './contracts.ts';
import { agentPolicySchema, soulRevisionSchema } from './saved-contracts.ts';
import { agentTaskLimitsSchema, triggerSchema, type Trigger } from '@tulipfarm/workflows/contracts';

/** Setup creates one Workflow per trigger: the trigger, then one step that runs this agent with the prompt. */
export const agentSetupTriggerSchema = z.strictObject({
  id: uuidSchema,
  trigger: triggerSchema,
  prompt: z.string().trim().min(1).max(8000),
  limits: agentTaskLimitsSchema.optional(),
});
export type AgentSetupTrigger = z.infer<typeof agentSetupTriggerSchema>;
/** Manual and event triggers start only when a member runs them, so only the other kinds need a sponsor. */
export const unattendedTrigger = (trigger: Trigger) => trigger.kind !== 'manual' && trigger.kind !== 'event';

// Setups saved before triggers moved to Workflows carry task schedules; read each as the trigger it becomes.
const legacySchedulesAsTriggers = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('schedules' in value)) return value;
  const { schedules, ...rest } = value as { schedules: unknown };
  if ('triggers' in rest || !Array.isArray(schedules)) return value;
  return {
    ...rest,
    triggers: schedules.map(schedule =>
      schedule && typeof schedule === 'object'
        ? {
            id: (schedule as { id?: unknown }).id,
            trigger: (schedule as { trigger?: unknown }).trigger,
            prompt: (schedule as { action?: { text?: unknown } }).action?.text,
            limits: (schedule as { action?: { limits?: unknown } }).action?.limits,
          }
        : schedule,
    ),
  };
};
const agentSetupDetailsObject = z.strictObject({
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
  triggers: z.array(agentSetupTriggerSchema).max(20),
});
export const agentSetupDetailsSchema = z.preprocess(legacySchedulesAsTriggers, agentSetupDetailsObject);
export const agentSetupSchema = z.preprocess(
  legacySchedulesAsTriggers,
  agentSetupDetailsObject
    .extend({
      definition: agentDefinitionSchema,
      owningTeamId: uuidSchema.nullable(),
    })
    .superRefine((setup, context) => {
      for (const [field, values] of [
        ['slackChannels', setup.slackChannels.map(item => item.channel)],
        ['triggers', setup.triggers.map(item => item.id)],
        ['enrollment', setup.enrollment],
      ] as const) {
        if (new Set(values).size !== values.length)
          context.addIssue({ code: 'custom', path: [field], message: 'Selections must be unique.' });
      }
    }),
);

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
// Commands stored before triggers moved to Workflows name the consented schedules sponsorScheduleIds.
export const agentSetupConsentSchema = z.preprocess(
  value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('sponsorScheduleIds' in value)) return value;
    const { sponsorScheduleIds, ...rest } = value as { sponsorScheduleIds: unknown };
    return 'sponsorTriggerIds' in rest ? value : { ...rest, sponsorTriggerIds: sponsorScheduleIds };
  },
  z.strictObject({
    /** Unattended triggers the reviewer agrees to sponsor: their Workflows run as, and are billed to, the reviewer. */
    sponsorTriggerIds: z.array(uuidSchema),
    replaceChannels: z.array(z.string().regex(/^[CG][A-Z0-9]{1,63}$/)),
  }),
);
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
  /** The Workflow each trigger created, once the setup is active. */
  workflows: z.array(z.strictObject({ triggerId: uuidSchema, workflowId: uuidSchema })).default([]),
});
export type AgentSetup = z.infer<typeof agentSetupSchema>;
export type SaveAgentSetupDraft = z.infer<typeof saveAgentSetupDraftSchema>;
export type AgentSetupDraft = z.infer<typeof agentSetupDraftSchema>;
export type PublishAgentSetup = z.infer<typeof publishAgentSetupSchema>;
export type AgentSetupReceipt = z.infer<typeof agentSetupReceiptSchema>;
