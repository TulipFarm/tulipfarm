import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access/contracts';
import { agentDefinitionSchema, definitionRevisionSchema, scopeSchema, taskLimitsSchema } from './contracts.ts';
import { agentPolicySchema, soulRevisionSchema } from './saved-contracts.ts';
import { agentTaskLimitsSchema, triggerVariantSchema, type TriggerVariant } from '@tulipfarm/workflows/contracts';

/** Adds the fewest of the caller's granting teams for this table, retaining their explicit enrollment choices. */
export function tableAccessEnrollment(
  teams: readonly {
    id: string;
    canAssign?: boolean | undefined;
    tableScope?: z.infer<typeof scopeSchema> | undefined;
  }[],
  entry: z.infer<typeof scopeSchema>[number],
  enrolled: readonly string[],
) {
  const permissions = entry.permissions.filter(permission => permission.startsWith('table.row.'));
  if (!permissions.length) return [...enrolled];
  const mask = (team: (typeof teams)[number]) =>
    permissions.reduce(
      (bits, permission, index) =>
        team.tableScope?.some(grant => grant.assetId === entry.assetId && grant.permissions.includes(permission))
          ? bits | (1 << index)
          : bits,
      0,
    );
  const existing = teams.filter(team => enrolled.includes(team.id)).reduce((bits, team) => bits | mask(team), 0);
  const choices = new Map<number, string[]>([[existing, []]]);
  for (const team of teams.filter(team => team.canAssign && !enrolled.includes(team.id)))
    for (const [covered, ids] of choices) {
      const next = covered | mask(team);
      if (!choices.has(next) || choices.get(next)!.length > ids.length + 1) choices.set(next, [...ids, team.id]);
    }
  const selected = choices.get((1 << permissions.length) - 1);
  return selected ? [...enrolled, ...selected] : [...enrolled];
}

export function tableAccessProblem(
  teams: readonly {
    id: string;
    name: string;
    canAssign?: boolean | undefined;
    tableScope?: z.infer<typeof scopeSchema> | undefined;
  }[],
  scope: z.infer<typeof scopeSchema>,
  enrolled: readonly string[],
  previous?: { scope: z.infer<typeof scopeSchema>; enrollment: readonly string[] } | undefined,
) {
  const managerMessage = (names: string[]) =>
    `You need a manager of ${new Intl.ListFormat('en').format(names)} to give this agent access.`;
  const unassignable = teams.filter(
    team => enrolled.includes(team.id) && !previous?.enrollment.includes(team.id) && !team.canAssign,
  );
  if (unassignable.length) return managerMessage(unassignable.map(team => team.name));
  for (const entry of scope) {
    const missing = entry.permissions.filter(
      permission =>
        permission.startsWith('table.row.') &&
        !(
          previous?.enrollment.some(id => enrolled.includes(id)) &&
          previous.scope.some(bound => bound.assetId === entry.assetId && bound.permissions.includes(permission))
        ) &&
        !teams.some(
          team =>
            enrolled.includes(team.id) &&
            team.tableScope?.some(grant => grant.assetId === entry.assetId && grant.permissions.includes(permission)),
        ),
    );
    if (
      !missing.length ||
      enrolled.some(id => previous?.enrollment.includes(id) && !teams.some(team => team.id === id))
    )
      continue;
    const blocked = teams.filter(
      team =>
        !team.canAssign &&
        team.tableScope?.some(
          grant =>
            grant.assetId === entry.assetId && missing.some(permission => grant.permissions.includes(permission)),
        ),
    );
    return blocked.length
      ? managerMessage(blocked.map(team => team.name))
      : 'Choose a team that grants every selected table permission.';
  }
  return null;
}

/** Any Workflow trigger kind, without the ID and label the setup trigger gives it. */
export const agentTriggerSchema = triggerVariantSchema;
export type AgentTrigger = TriggerVariant;
/** One trigger of the agent's linked Workflow; every trigger runs the setup's one prompt. */
export const agentSetupTriggerSchema = z.strictObject({
  id: uuidSchema,
  label: z.string().trim().min(1).max(100).optional(),
  trigger: agentTriggerSchema,
});
export type AgentSetupTrigger = z.infer<typeof agentSetupTriggerSchema>;
/** Event triggers start only when a member runs them, so only the other kinds need a sponsor. */
export const unattendedTrigger = (trigger: AgentTrigger) => trigger.kind !== 'event';
/** The linked Workflow's ID for a setup trigger: `t_` and the UUID's 32 hex digits. */
export const agentWorkflowTriggerId = (setupTriggerId: string) =>
  `t_${uuidSchema.parse(setupTriggerId).replaceAll('-', '').toLowerCase()}`;

type LegacyEntry = { id?: unknown; trigger?: unknown; prompt?: unknown; limits?: unknown };
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const sameJson = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
// Earlier setups kept a prompt and limits on each trigger, or a `schedules` list, and stored Workflow IDs on triggers.
function legacyEntries(value: Record<string, unknown>): LegacyEntry[] | null {
  if ('schedules' in value && !('triggers' in value) && Array.isArray(value.schedules))
    return value.schedules.map(schedule =>
      record(schedule)
        ? {
            id: schedule.id,
            trigger: schedule.trigger,
            prompt: record(schedule.action) ? schedule.action.text : undefined,
            limits: record(schedule.action) ? schedule.action.limits : undefined,
          }
        : {},
    );
  if (!Array.isArray(value.triggers)) return null;
  const legacy = value.triggers.some(
    item =>
      record(item) &&
      ('prompt' in item || 'limits' in item || (record(item.trigger) && item.trigger.kind === 'manual')),
  );
  return legacy ? (value.triggers as LegacyEntry[]) : null;
}
/** Whether a stored setup predates the single prompt, and whether its triggers' prompts or limits disagreed. */
export function legacySetupState(value: unknown): 'current' | 'legacy' | 'prompts-differ' {
  if (!record(value)) return 'current';
  const entries = legacyEntries(value);
  if (!entries) return 'current';
  const [first] = entries;
  return entries.every(entry => sameJson(entry.prompt, first?.prompt) && sameJson(entry.limits, first?.limits))
    ? 'legacy'
    : 'prompts-differ';
}
const triggerSettings = (trigger: unknown) => {
  if (!record(trigger)) return trigger;
  const { id: _id, label: _label, ...settings } = trigger;
  return settings;
};
/** Reads a legacy setup as one prompt from its first entry; manual entries are dropped but their prompt counts. */
function readLegacySetup(value: unknown) {
  if (!record(value)) return value;
  const entries = legacyEntries(value);
  if (!entries) return value;
  const { schedules: _schedules, ...rest } = value;
  const [first] = entries;
  return {
    ...rest,
    ...(first && first.prompt !== undefined && rest.prompt === undefined ? { prompt: first.prompt } : {}),
    ...(first && first.limits !== undefined && rest.runLimits === undefined ? { runLimits: first.limits } : {}),
    triggers: entries
      .filter(entry => !(record(entry.trigger) && entry.trigger.kind === 'manual'))
      .map(entry => ({ id: entry.id, trigger: triggerSettings(entry.trigger) })),
  };
}
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
  /** What the agent does on every run of its linked Workflow; the trigger that started a run is passed with it. */
  prompt: z.string().trim().min(1).max(8000).optional(),
  runLimits: agentTaskLimitsSchema.optional(),
  triggers: z.array(agentSetupTriggerSchema).max(20),
});
const promptRequired = (setup: { prompt?: string | undefined; triggers: unknown[] }, context: z.RefinementCtx) => {
  if (setup.triggers.length && setup.prompt === undefined)
    context.addIssue({ code: 'custom', path: ['prompt'], message: 'Triggers need a prompt.' });
};
export const agentSetupDetailsSchema = z.preprocess(
  readLegacySetup,
  agentSetupDetailsObject.superRefine(promptRequired),
);
export const agentSetupSchema = z.preprocess(
  readLegacySetup,
  agentSetupDetailsObject
    .extend({
      definition: agentDefinitionSchema,
      owningTeamId: uuidSchema.nullable(),
    })
    .superRefine((setup, context) => {
      promptRequired(setup, context);
      for (const [field, values] of [
        ['slackChannels', setup.slackChannels.map(item => item.channel)],
        ['triggers', setup.triggers.map(item => item.id.toLowerCase())],
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
  /** The linked Workflow as reviewed, or null when the agent had none. */
  expectedWorkflowRevision: uuidSchema.nullable(),
  expectedWorkflowGeneration: z.number().int().positive().nullable(),
};
export const saveAgentSetupDraftSchema = z.strictObject({
  requestId: uuidSchema,
  expectedVersion: z.number().int().nonnegative(),
  ...expectedSetup,
  setup: agentSetupSchema,
});
/** A stored draft; ones saved before the linked Workflow binding lack it and must be saved again to publish. */
export const storedAgentSetupDraftSchema = saveAgentSetupDraftSchema.extend({
  expectedWorkflowRevision: expectedSetup.expectedWorkflowRevision.optional(),
  expectedWorkflowGeneration: expectedSetup.expectedWorkflowGeneration.optional(),
});
export const agentSetupDraftSchema = z.object({
  agentId: uuidSchema,
  version: z.number().int().positive(),
  digest: definitionRevisionSchema,
  commandId: uuidSchema.nullable().optional(),
  ...expectedSetup,
  expectedWorkflowRevision: expectedSetup.expectedWorkflowRevision.default(null),
  expectedWorkflowGeneration: expectedSetup.expectedWorkflowGeneration.default(null),
  /** `legacy` and `prompts-differ` drafts were saved in an earlier shape; saving again creates a version to review. */
  legacy: z.enum(['current', 'legacy', 'prompts-differ']).default('current'),
  setup: agentSetupSchema,
});
// Commands stored before one sponsor flag list the consented triggers; they count only when they cover every one.
export const agentSetupConsentSchema = z.preprocess(
  value => {
    if (!record(value) || 'sponsor' in value) return value;
    const { sponsorScheduleIds, sponsorTriggerIds, ...rest } = value;
    return { ...rest, sponsor: false, sponsorTriggerIds: sponsorTriggerIds ?? sponsorScheduleIds ?? [] };
  },
  z.strictObject({
    /** The reviewer sponsors every unattended trigger: the linked Workflow runs as, and is billed to, the reviewer. */
    sponsor: z.boolean(),
    replaceChannels: z.array(z.string().regex(/^[CG][A-Z0-9]{1,63}$/)),
    sponsorTriggerIds: z.array(uuidSchema).optional(),
  }),
);
export type AgentSetupConsent = z.infer<typeof agentSetupConsentSchema>;
/** Whether the consent sponsors every unattended trigger of the setup. */
export const sponsorConsented = (consent: AgentSetupConsent, triggers: readonly AgentSetupTrigger[]) =>
  consent.sponsor ||
  triggers
    .filter(item => unattendedTrigger(item.trigger))
    .every(item => consent.sponsorTriggerIds?.some(id => id.toLowerCase() === item.id.toLowerCase()) ?? false);
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
  /** The agent's linked Workflow, once an active setup has one. */
  workflowId: uuidSchema.nullable().default(null),
});
/** The agent's linked Workflow as a new setup binds it, and its older trigger Workflows still to be combined. */
export const agentLinkedWorkflowSchema = z.object({
  workflowId: uuidSchema,
  revision: uuidSchema.nullable(),
  generation: z.number().int().positive().nullable(),
  archived: z.boolean(),
  /** Unarchived Workflows of this agent that the next activated setup combines into the linked one. */
  separateWorkflowIds: z.array(uuidSchema),
});
export type AgentLinkedWorkflow = z.infer<typeof agentLinkedWorkflowSchema>;
export type AgentSetup = z.infer<typeof agentSetupSchema>;
export type SaveAgentSetupDraft = z.infer<typeof saveAgentSetupDraftSchema>;
export type StoredAgentSetupDraft = z.infer<typeof storedAgentSetupDraftSchema>;
export type AgentSetupDraft = z.infer<typeof agentSetupDraftSchema>;
export type PublishAgentSetup = z.infer<typeof publishAgentSetupSchema>;
export type AgentSetupReceipt = z.infer<typeof agentSetupReceiptSchema>;
