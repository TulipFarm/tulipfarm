import { z } from 'zod';
import { sourceSchema, snippetPayloadSchema } from '@tulipfarm/workflow-snippets/protocol';
import { canonical } from '@tulipfarm/workflow-snippets/canonical';
import { githubEventIdSchema } from '@tulipfarm/github/event-contracts';
import { providerTriggerSchema } from './provider-contracts.ts';
import { outputPathIssues, stepValueEntries } from './output-fields.ts';
export {
  outputAt,
  outputChoices,
  outputPathIssues,
  sampledOutputChoices,
  stepOutputShapes,
  type OutputShape,
  type OutputTable,
} from './output-fields.ts';
export {
  providerSourceSchema,
  providerIntegrationInputSchema,
  providerIntegrationSchema,
  providerStatusSchema,
  providerUpdateSchema,
} from './provider-contracts.ts';
export {
  providerTestInputSchema,
  providerTestResultSchema,
  providerResourceInputSchema,
  providerResourceResultSchema,
  type ProviderResourceInput,
} from './provider-contracts.ts';

export const idSchema = z.uuid().transform(value => value.toLowerCase());
export const principalSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('person'), id: idSchema }),
  z.strictObject({ kind: z.literal('team'), id: idSchema }),
]);
export const sharingSchema = z.strictObject({
  principal: principalSchema,
  permissions: z.array(z.enum(['read', 'invoke', 'manage'])).max(3),
});
export const providerSharingSchema = z.strictObject({
  principal: principalSchema,
  permissions: z.array(z.enum(['use', 'manage'])).max(2),
});
export const grantsSchema = z.array(
  z.object({ membershipId: idSchema.nullable(), teamId: idSchema.nullable(), permission: z.string() }),
);
export const workflowPersonSchema = z.object({ id: idSchema, userId: z.string(), name: z.string() });
export const sharingCandidatesSchema = z.object({
  membershipId: idSchema,
  people: z.array(workflowPersonSchema),
  teams: z.array(z.object({ id: idSchema, name: z.string() })),
});
export const sponsorshipSchema = z.strictObject({
  sponsorMembershipId: idSchema,
  historyAudience: z.array(idSchema).min(1).max(100),
});
export const acceptSponsorshipSchema = z.strictObject({ expectedGeneration: z.number().int().positive() });
export const commandSchema = z.strictObject({
  commandId: idSchema,
  expectedGeneration: z.number().int().positive().max(2147483646),
});
export const activationSchema = commandSchema.extend({ revision: idSchema, enabled: z.boolean() });
export const webhookModeSchema = z.enum(['bearer', 'signed', 'github', 'stripe']);
export const webhookKeyValueSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const webhookSigningSecretSchema = z.string().min(1).max(256);
export const webhookToleranceSeconds = 300;
export const webhookGraceSeconds = { default: 86400, maximum: 7 * 86400 } as const;
export const webhookTimestampHeader = 'x-tulipfarm-timestamp';
export const webhookSignatureHeader = 'x-tulipfarm-signature';
export const webhookKeySchema = commandSchema
  .extend({
    mode: webhookModeSchema,
    secret: webhookSigningSecretSchema.optional(),
    graceSeconds: z.number().int().min(0).max(webhookGraceSeconds.maximum).default(webhookGraceSeconds.default),
  })
  .refine(input => (input.mode === 'stripe' ? input.secret !== undefined : input.secret === undefined), {
    message: 'A Stripe signing secret is required only for Stripe mode',
    path: ['secret'],
  });
export const payloadSchema = snippetPayloadSchema;
const name = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
// A parked run still holds a slot under its workflow's parked cap, so waits stay bounded.
export const maxWaitSeconds = 366 * 86400;
const instantSchema = z.union([z.iso.datetime({ offset: true }), z.iso.date().transform(date => `${date}T00:00:00Z`)]);
export const valueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('literal'), value: payloadSchema }),
  z.strictObject({ kind: z.literal('input'), path: z.array(z.string().max(100)).max(16) }),
  z.strictObject({ kind: z.literal('step'), step: name, path: z.array(z.string().max(100)).max(16) }),
]);
const requestHeaderNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
  .refine(
    header => !['authorization', 'cookie', 'proxy-authorization', 'host', 'content-length'].includes(header),
    'Restricted request header',
  );
export const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export const httpStepSchema = z
  .strictObject({
    id: name,
    kind: z.literal('http'),
    method: z.enum(httpMethods),
    url: z
      .url()
      .refine(value => !URL.canParse(value) || new URL(value).protocol === 'https:', 'HTTP steps require an HTTPS URL'),
    headers: z.record(requestHeaderNameSchema, valueSchema).default({}),
    body: valueSchema.optional(),
    credential: z
      .strictObject({ integrationId: idSchema, header: requestHeaderNameSchema.default('x-api-key') })
      .optional(),
  })
  .superRefine((step, context) => {
    if ((step.method === 'GET' || step.method === 'DELETE') && step.body)
      context.addIssue({ code: 'custom', message: 'GET and DELETE requests cannot include a body', path: ['body'] });
  });
// Table field IDs are stored lowercase, so a mapping keyed by another spelling would name no field.
const fieldIdSchema = z.uuid().refine(value => value === value.toLowerCase(), 'Use the lowercase field ID');
const rowFieldsSchema = z
  .record(fieldIdSchema, valueSchema)
  .refine(fields => Object.keys(fields).length >= 1 && Object.keys(fields).length <= 64, 'Map 1 to 64 fields');
export const rowFilterSchema = z.discriminatedUnion('op', [
  z.strictObject({ fieldId: fieldIdSchema, op: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']), value: valueSchema }),
  z.strictObject({ fieldId: fieldIdSchema, op: z.enum(['is-null', 'not-null']) }),
]);
export const maxFoundRows = 50;
export const comparisonSchema = z.discriminatedUnion('op', [
  z.strictObject({ left: valueSchema, op: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']), right: valueSchema }),
  z.strictObject({ left: valueSchema, op: z.enum(['is-empty', 'not-empty']) }),
]);
export type Comparison = z.infer<typeof comparisonSchema>;
export const agentTaskLimitsSchema = z.strictObject({
  toolCalls: z.number().int().min(1).max(1000).default(100),
  activeMilliseconds: z.number().int().min(1000).max(3600000).default(300000),
  credits: z.number().int().min(1).max(10000).default(100),
});
export const stepSchema = z.discriminatedUnion('kind', [
  // ifMet and otherwise name later steps. A listed step runs only when this condition ran and chose its branch; unlisted steps always run.
  z.strictObject({
    id: name,
    kind: z.literal('condition'),
    when: comparisonSchema,
    ifMet: z.array(name).max(31),
    otherwise: z.array(name).max(31),
  }),
  z.strictObject({
    id: name,
    kind: z.literal('transform'),
    fields: z.record(name, valueSchema).refine(fields => Object.keys(fields).length <= 32),
  }),
  z.strictObject({ id: name, kind: z.literal('delay'), seconds: z.number().int().min(1).max(maxWaitSeconds) }),
  z.strictObject({ id: name, kind: z.literal('wait-until'), at: valueSchema }),
  z.strictObject({
    id: name,
    kind: z.literal('human'),
    prompt: z.string().min(1).max(2000),
    timeoutSeconds: z.number().int().min(60).max(2592000),
  }),
  z.strictObject({
    id: name,
    kind: z.literal('code'),
    language: z.enum(['javascript', 'python']),
    source: z.string().min(1).max(32768),
    input: valueSchema,
  }),
  z.strictObject({
    id: name,
    kind: z.literal('agent'),
    agentId: idSchema,
    prompt: valueSchema,
    limits: agentTaskLimitsSchema.default({ toolCalls: 100, activeMilliseconds: 300000, credits: 100 }),
  }),
  httpStepSchema,
  z
    .strictObject({
      id: name,
      kind: z.literal('slack-message'),
      destinationId: idSchema,
      text: valueSchema,
      sender: z.enum(['user', 'app']).optional(),
    })
    .refine(
      step =>
        step.text.kind !== 'literal' ||
        (typeof step.text.value === 'string' && step.text.value.length >= 1 && step.text.value.length <= 4000),
      { path: ['text'], message: 'Slack message text must contain 1 to 4,000 characters' },
    ),
  z.strictObject({
    id: name,
    kind: z.literal('find-rows'),
    tableId: idSchema,
    filters: z.array(rowFilterSchema).max(16),
    limit: z.number().int().min(1).max(maxFoundRows),
  }),
  z.strictObject({ id: name, kind: z.literal('create-row'), tableId: idSchema, fields: rowFieldsSchema }),
  // The row value names a row and the token it was read at, so an update never overwrites a change it did not see.
  z.strictObject({
    id: name,
    kind: z.literal('update-row'),
    tableId: idSchema,
    row: valueSchema,
    fields: rowFieldsSchema,
  }),
]);
export type Step = z.infer<typeof stepSchema>;
export type TableStep = Extract<Step, { kind: 'find-rows' | 'create-row' | 'update-row' }>;
export const isTableStep = (step: Step): step is TableStep =>
  step.kind === 'find-rows' || step.kind === 'create-row' || step.kind === 'update-row';
export type AgentStep = Extract<Step, { kind: 'agent' }>;
/** Every value a step reads from the run input or earlier steps. */
export function stepValues(step: Step): z.infer<typeof valueSchema>[] {
  return stepValueEntries(step).map(entry => entry.value);
}
export type ConditionStep = Extract<Step, { kind: 'condition' }>;
/** A condition step's receipt records whether it held and the steps it ran and skipped, so history explains a run without its definition. */
export const conditionOutputSchema = z.object({
  matched: z.boolean(),
  ran: z.array(z.string()),
  skipped: z.array(z.string()),
});
/** Each condition, with the branch, that must have chosen a step for it to run, including the conditions that gate those conditions. */
export function stepGates(steps: Step[]) {
  const gates = new Map<string, Set<string>>();
  for (const step of steps) {
    const own = gates.get(step.id) ?? new Set<string>();
    gates.set(step.id, own);
    if (step.kind !== 'condition') continue;
    for (const branch of ['ifMet', 'otherwise'] as const)
      for (const target of step[branch]) {
        const targetGates = gates.get(target) ?? new Set<string>();
        for (const gate of [`${step.id}:${branch}`, ...own]) targetGates.add(gate);
        gates.set(target, targetGates);
      }
  }
  return gates;
}
/** The next step a run should take: the first without a completed receipt whose conditions all chose it. Null when the run is finished. */
export function nextStep(steps: Step[], outputs: Map<string, z.infer<typeof payloadSchema>>) {
  const chosen = new Set<string>();
  for (const step of steps) {
    if (step.kind === 'condition' && outputs.has(step.id))
      chosen.add(`${step.id}:${conditionOutputSchema.parse(outputs.get(step.id)).matched ? 'ifMet' : 'otherwise'}`);
  }
  const gates = stepGates(steps);
  for (const [index, step] of steps.entries()) {
    if (outputs.has(step.id)) continue;
    if ([...(gates.get(step.id) ?? [])].every(gate => chosen.has(gate))) return { step, index };
  }
  return null;
}
/** A row a later step can update: find-rows rows, create-row and update-row outputs, and record trigger input all carry this shape. */
export const rowReferenceSchema = z.object({ tableId: idSchema.optional(), recordId: idSchema, token: z.uuid() });
export const foundRowsSchema = z.object({
  tableId: idSchema,
  rows: z.array(z.object({ recordId: idSchema, token: z.uuid(), values: z.record(z.string(), z.unknown()) })),
  more: z.boolean(),
});
export const rowChangeSchema = z.object({
  operation: z.enum(['created', 'updated']),
  tableId: idSchema,
  recordId: idSchema,
  token: z.uuid(),
  fieldIds: z.array(z.string()),
});
// The bearer key arrives in Authorization, so credential headers can never be copied into run input.
const headerNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
  .refine(
    header => !['authorization', 'cookie', 'proxy-authorization'].includes(header),
    'Credential headers cannot be copied',
  );
export const webhookDedupeSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('header'), name: headerNameSchema }),
  z.strictObject({ source: z.literal('body'), path: z.array(z.string().min(1).max(100)).min(1).max(16) }),
  z.strictObject({ source: z.literal('hash') }),
]);
/** Signatures and secrets authenticate a delivery; readers of run history must not get a copy they could replay. */
export const isSecretHeader = (header: string) => /signature|secret|token/.test(header);
export const rawWebhookSchema = z.strictObject({
  mode: z.literal('raw'),
  dedupe: webhookDedupeSchema,
  headers: z.array(headerNameSchema).max(16).optional(),
});
const cronMacros: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
  '@weekdays': '0 0 * * 1-5',
  '@weekends': '0 0 * * 0,6',
};
const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const numbered = (field: string, names: string[], first: number) =>
  field.replace(/[a-z]+/gi, word => {
    const index = names.indexOf(word.toLowerCase());
    return index !== -1 ? String(index + first) : word.toLowerCase() === 'l' ? 'L' : word;
  });
/** Rewrites macros and month and day names to the numeric five-field form the editor and stored revisions use. */
export function normalizeCronExpression(expression: string) {
  const trimmed = expression.trim();
  const fields = (cronMacros[trimmed.toLowerCase()] ?? trimmed).split(/\s+/);
  if (fields.length !== 5) return trimmed;
  const [minute, hour, day = '', month = '', weekday = ''] = fields;
  return [minute, hour, numbered(day, [], 0), numbered(month, monthNames, 1), numbered(weekday, dayNames, 0)].join(' ');
}
const cronExpressionSchema = z
  .string()
  .max(100)
  .transform(normalizeCronExpression)
  .pipe(z.string().regex(/^[\d*,/-]+ [\d*,/-]+ [\d*,/?L-]+ [\d*,/-]+ [\d*,/?L#-]+$/));
const timezoneSchema = z.string().min(1).max(100);
export const intervalTriggerSchema = z.strictObject({
  kind: z.literal('interval'),
  minutes: z.number().int().min(1).max(525600),
});
export const cronTriggerSchema = z.strictObject({
  kind: z.literal('cron'),
  expression: cronExpressionSchema,
  timezone: timezoneSchema,
});
const directionSchema = z.enum(['before', 'after']);
const recordOffsetSeconds = { minutes: 60, hours: 3600, days: 86400, weeks: 604800 } as const;
// A date field names a calendar day, so its offset moves whole days and the run starts at a wall-clock time in a zone.
// A timestamp field names an instant, so its offset is an exact duration.
export const recordFieldScheduleSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('date'),
      fieldId: idSchema,
      offset: z.strictObject({
        direction: directionSchema,
        amount: z.number().int().min(0).max(366),
        unit: z.enum(['days', 'weeks']),
      }),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      timezone: timezoneSchema,
    }),
    z.strictObject({
      kind: z.literal('timestamp'),
      fieldId: idSchema,
      offset: z.strictObject({
        direction: directionSchema,
        amount: z.number().int().min(0).max(527040),
        unit: z.enum(['minutes', 'hours', 'days']),
      }),
    }),
  ])
  .refine(field => field.offset.amount * recordOffsetSeconds[field.offset.unit] <= maxWaitSeconds, {
    message: 'Offset cannot exceed 366 days',
    path: ['offset', 'amount'],
  });
export type RecordFieldSchedule = z.infer<typeof recordFieldScheduleSchema>;
/** Signed offset from the field value: whole days for a date field, seconds for a timestamp field. */
export function recordOffset(field: RecordFieldSchedule) {
  const sign = field.offset.direction === 'before' ? -1 : 1;
  return field.kind === 'date'
    ? { days: sign * field.offset.amount * (field.offset.unit === 'weeks' ? 7 : 1), seconds: 0 }
    : { days: 0, seconds: sign * field.offset.amount * recordOffsetSeconds[field.offset.unit] };
}
const orderedFilterValues = [
  z.strictObject({ kind: z.literal('numeric'), value: z.string().regex(/^-?\d{1,40}(\.\d{1,40})?$/) }),
  z.strictObject({ kind: z.literal('date'), value: z.iso.date() }),
  z.strictObject({ kind: z.literal('timestamp'), value: z.iso.datetime({ offset: true }) }),
] as const;
// The value kind names the field kind it compares against, as table values do, so a filter on a changed field is detectable.
export const recordFilterSchema = z.union([
  z.strictObject({
    fieldId: idSchema,
    match: z.enum(['is', 'is-not']),
    value: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('text'),
        value: z
          .string()
          .min(1)
          .max(10000)
          .refine(
            value => !value.includes('\u0000') && !/[\uD800-\uDFFF]/u.test(value),
            'Expected well-formed Unicode without null bytes',
          ),
      }),
      z.strictObject({ kind: z.literal('boolean'), value: z.boolean() }),
      z.strictObject({ kind: z.literal('single-select'), optionId: idSchema }),
      ...orderedFilterValues,
    ]),
  }),
  z.strictObject({
    fieldId: idSchema,
    match: z.enum(['lt', 'lte', 'gt', 'gte']),
    value: z.discriminatedUnion('kind', [...orderedFilterValues]),
  }),
  z.strictObject({ fieldId: idSchema, match: z.enum(['is-empty', 'is-not-empty']) }),
]);
export type RecordFilter = z.infer<typeof recordFilterSchema>;
export const recordTriggerSchema = z.strictObject({
  kind: z.literal('record'),
  tableId: idSchema,
  field: recordFieldScheduleSchema,
  filter: recordFilterSchema.optional(),
});
export const rowEventSchema = z.enum(['created', 'updated', 'deleted']);
export type RowEvent = z.infer<typeof rowEventSchema>;
// fieldIds narrows an update trigger to changes of those fields; created and deleted rows have no changed-field subset to narrow by.
export const rowTriggerSchema = z
  .strictObject({
    kind: z.literal('row'),
    tableId: idSchema,
    event: rowEventSchema,
    fieldIds: z.array(fieldIdSchema).min(1).max(64).optional(),
    filter: recordFilterSchema.optional(),
  })
  .refine(trigger => trigger.event === 'updated' || trigger.fieldIds === undefined, {
    message: 'Only an update trigger can name fields',
    path: ['fieldIds'],
  });
/** Bound scheduler work per transaction, never the number of retained row events. */
export const rowEventBatchSize = 100;
// Each GitHub webhook event a workflow can start from, with the `action` values it may narrow to. Push has no action.
export const githubTriggerEvents = {
  star: ['created', 'deleted'],
  watch: ['started'],
  issues: ['opened', 'edited', 'closed', 'reopened', 'assigned', 'unassigned', 'labeled', 'unlabeled', 'deleted'],
  pull_request: [
    'opened',
    'edited',
    'closed',
    'reopened',
    'synchronize',
    'ready_for_review',
    'converted_to_draft',
    'assigned',
    'unassigned',
    'labeled',
    'unlabeled',
    'review_requested',
  ],
  issue_comment: ['created', 'edited', 'deleted'],
  push: [],
  release: ['published', 'unpublished', 'created', 'edited', 'deleted', 'prereleased', 'released'],
} as const satisfies Record<string, readonly string[]>;
export type GitHubTriggerEvent = keyof typeof githubTriggerEvents;
export const githubTriggerSchema = z
  .strictObject({
    kind: z.literal('github'),
    repositoryId: githubEventIdSchema,
    event: z.enum(Object.keys(githubTriggerEvents) as [GitHubTriggerEvent, ...GitHubTriggerEvent[]]),
    actions: z.array(z.string()).min(1).max(16).optional(),
  })
  .refine(
    trigger =>
      trigger.actions === undefined ||
      (new Set(trigger.actions).size === trigger.actions.length &&
        trigger.actions.every(action => (githubTriggerEvents[trigger.event] as readonly string[]).includes(action))),
    { message: 'Name each action once, and only actions this event has', path: ['actions'] },
  );
export type GitHubTrigger = z.infer<typeof githubTriggerSchema>;
export const triggerSchema = z.discriminatedUnion('kind', [
  recordTriggerSchema,
  rowTriggerSchema,
  providerTriggerSchema,
  githubTriggerSchema,
  z.strictObject({ kind: z.literal('manual') }),
  z.strictObject({ kind: z.literal('webhook'), payload: rawWebhookSchema.optional() }),
  z.strictObject({ kind: z.literal('event'), name }),
  z.strictObject({ kind: z.literal('once'), at: z.iso.datetime(), timezone: timezoneSchema.optional() }),
  intervalTriggerSchema,
  cronTriggerSchema,
]);
export type Trigger = z.infer<typeof triggerSchema>;
export const definitionSchema = z
  .strictObject({
    version: z.literal(1),
    name: z.string().trim().min(1).max(100),
    trigger: triggerSchema,
    steps: z.array(stepSchema).min(1).max(32),
  })
  .superRefine((definition, context) => {
    const known = new Set<string>();
    const positions = new Map(definition.steps.map((step, index) => [step.id, index]));
    const gates = stepGates(definition.steps);
    for (const [index, step] of definition.steps.entries()) {
      if (known.has(step.id))
        context.addIssue({ code: 'custom', message: 'Duplicate step ID', path: ['steps', index, 'id'] });
      for (const value of stepValues(step)) {
        if (value.kind === 'step' && !known.has(value.step))
          context.addIssue({ code: 'custom', message: 'Reference must name an earlier step', path: ['steps', index] });
        // A step a condition can skip leaves no output, so only steps that run whenever this one runs can be read.
        else if (
          value.kind === 'step' &&
          ![...(gates.get(value.step) ?? [])].every(gate => gates.get(step.id)?.has(gate))
        )
          context.addIssue({
            code: 'custom',
            message: 'Reference must name a step that runs whenever this step runs',
            path: ['steps', index],
          });
      }
      if (step.kind === 'condition') {
        const targets = [...step.ifMet, ...step.otherwise];
        if (!targets.length)
          context.addIssue({
            code: 'custom',
            message: 'A condition must name at least one step to run or skip',
            path: ['steps', index],
          });
        if (new Set(targets).size !== targets.length)
          context.addIssue({ code: 'custom', message: 'A step can belong to only one branch', path: ['steps', index] });
        if (targets.some(target => (positions.get(target) ?? -1) <= index))
          context.addIssue({ code: 'custom', message: 'A branch must name later steps', path: ['steps', index] });
      }
      if (step.kind === 'wait-until' && step.at.kind === 'literal' && !instantSchema.safeParse(step.at.value).success)
        context.addIssue({
          code: 'custom',
          message: 'Wait time must be an ISO date or date-time',
          path: ['steps', index, 'at'],
        });
      // Each run would make the change that starts the next one.
      const { trigger } = definition;
      if (
        trigger.kind === 'row' &&
        'tableId' in step &&
        step.tableId === trigger.tableId &&
        ((step.kind === 'create-row' && trigger.event === 'created') ||
          (step.kind === 'update-row' &&
            trigger.event === 'updated' &&
            (!trigger.fieldIds || trigger.fieldIds.some(id => id in step.fields))))
      )
        context.addIssue({
          code: 'custom',
          message: 'A step cannot make the row change that triggers this workflow',
          path: ['steps', index],
        });
      known.add(step.id);
    }
  });
export type Definition = z.infer<typeof definitionSchema>;
export const authoredDefinitionSchema = definitionSchema.superRefine((definition, context) => {
  for (const issue of outputPathIssues(definition)) context.addIssue(issue);
  if (definition.trigger.kind === 'webhook')
    for (const [index, header] of (definition.trigger.payload?.headers ?? []).entries()) {
      if (isSecretHeader(header))
        context.addIssue({
          code: 'custom',
          message: 'Signature and secret headers cannot be copied',
          path: ['trigger', 'payload', 'headers', index],
        });
    }
  for (const [index, step] of definition.steps.entries()) {
    if (step.kind === 'code' && !sourceSchema.safeParse(step.source).success)
      context.addIssue({
        code: 'custom',
        message: 'Serialized source exceeds 32 KiB',
        path: ['steps', index, 'source'],
      });
  }
});
export const saveSchema = z.strictObject({
  revision: idSchema,
  expectedRevision: idSchema.nullable(),
  definition: authoredDefinitionSchema,
});
export const startSchema = z.strictObject({ requestId: idSchema, input: payloadSchema });
export const workSchema = z.strictObject({ workspaceId: idSchema, runId: idSchema });
export type Work = z.infer<typeof workSchema>;
export const statusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'completed',
  'cancelled',
  'blocked',
  'failed',
  'skipped',
]);
export const disabledReasonSchema = z.enum(['sponsor-access-lost', 'provider-backlog', 'record-field-unavailable']);
export type DisabledReason = z.infer<typeof disabledReasonSchema>;
export const rowQueueSchema = z.object({
  available: z.boolean(),
  pending: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  oldestAt: z.string().nullable(),
  blockers: z.array(
    z.object({
      reason: z.enum([
        'capacity',
        'values-too-large',
        'values-unavailable',
        'workflow-disabled',
        'revision-replaced',
        'workflow-archived',
      ]),
      count: z.number().int().positive(),
    }),
  ),
});
export const workflowSchema = z.object({
  id: idSchema,
  revision: idSchema,
  activeRevision: idSchema.nullable(),
  enabled: z.boolean(),
  generation: z.number().int().positive(),
  nextRunAt: z.string().nullable(),
  definition: definitionSchema,
  activeTrigger: triggerSchema.nullable(),
  disabledReason: disabledReasonSchema.nullable().default(null),
  webhookConfigured: z.boolean(),
  webhookMode: webhookModeSchema.nullable().default(null),
  webhookRotation: z.boolean().default(false),
  webhookPrevious: z.object({ mode: webhookModeSchema, expiresAt: z.string() }).nullable().default(null),
  capabilities: z
    .object({ read: z.boolean(), invoke: z.boolean(), manage: z.boolean() })
    .default({ read: false, invoke: false, manage: false }),
  sponsorMembershipId: idSchema.nullable().default(null),
  sponsor: workflowPersonSchema.nullable().default(null),
  sponsorshipAccepted: z.boolean().default(false),
  historyAudience: z.array(idSchema).default([]),
  upcomingRecords: z
    .array(z.object({ recordId: idSchema, dueAt: z.string() }))
    .nullable()
    .default(null),
  archivedAt: z.string().nullable().default(null),
  rowQueue: rowQueueSchema.nullable().default(null),
});
// The server returns a generated key once; a replayed command cannot show it again.
export const webhookKeyIssuedSchema = z.object({ workflow: workflowSchema, key: webhookKeyValueSchema.nullable() });
export const webhookDeliveryRetention = { count: 50, days: 30 } as const;
export const webhookOutcomeSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);
// runId is present only when the reader can open that run; runStarted still reports that the delivery started or replayed one.
export const webhookDeliverySchema = z.object({
  id: idSchema,
  receivedAt: z.string(),
  status: z.number().int(),
  outcome: webhookOutcomeSchema,
  requestId: z.string().nullable(),
  bodyBytes: z.number().int().nullable(),
  runStarted: z.boolean(),
  runId: idSchema.nullable(),
  test: z.boolean(),
});
// Workspaces below common version 6 keep no log until their storage update finishes.
export const webhookDeliveryLogSchema = z.object({
  available: z.boolean(),
  deliveries: z.array(webhookDeliverySchema),
});
export const webhookTestSchema = z.strictObject({ requestId: idSchema });
export const runSourceSchema = z.enum([
  'manual',
  'webhook',
  'schedule',
  'event',
  'provider',
  'github',
  'record',
  'row',
]);
export const runSchema = z.object({
  id: idSchema,
  workflowId: idSchema,
  revision: idSchema,
  status: statusSchema,
  source: runSourceSchema,
  input: payloadSchema,
  createdAt: z.string(),
  scheduledFor: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  finishedAt: z.string().nullable().default(null),
  error: z.string().nullable(),
});
/** Replaces a step output in history when it may carry content from sources the reader cannot open. */
export const withheldOutputSchema = z.strictObject({ withheld: z.literal('source-access') });
export const withheldOutput: z.infer<typeof withheldOutputSchema> = { withheld: 'source-access' };
export const receiptSchema = z.object({
  stepId: name,
  ordinal: z.number().int(),
  status: z.enum(['waiting', 'completed']),
  output: payloadSchema.nullable(),
  prompt: z.string().nullable(),
  dueAt: z.string().nullable().default(null),
});
export const unfinishedStatuses = ['queued', 'running', 'waiting'] as const;
export const runHistoryPageSize = 50;
export const runHistoryCursorSchema = z
  .string()
  .max(100)
  .refine(value => {
    const [createdAt, id, extra] = value.split('~');
    return extra === undefined && z.iso.datetime().safeParse(createdAt).success && idSchema.safeParse(id).success;
  });
// Without a status filter the first page also lists every unfinished run, newest first, ahead of the finished runs.
export const runHistoryQuerySchema = z.strictObject({
  status: statusSchema.optional(),
  before: runHistoryCursorSchema.optional(),
});
export type RunHistoryQuery = z.infer<typeof runHistoryQuerySchema>;
export const runHistoryPageSchema = z.object({
  runs: z.array(runSchema.extend({ steps: z.array(receiptSchema) })),
  nextCursor: runHistoryCursorSchema.nullable(),
});
export const definitionQuerySchema = z.strictObject({
  revision: z.union([z.enum(['saved', 'active']), idSchema]).default('saved'),
});
export const definitionViewSchema = z.object({
  workflowId: idSchema,
  revision: idSchema,
  savedRevision: idSchema,
  activeRevision: idSchema.nullable(),
  definition: definitionSchema,
  actor: workflowPersonSchema.nullable(),
  canManage: z.boolean(),
  archived: z.boolean(),
});
export const runDetailSchema = z.object({
  run: runSchema.extend({ steps: z.array(receiptSchema) }),
  definition: definitionSchema,
  actor: workflowPersonSchema.nullable(),
  canManage: z.boolean(),
});
export type DefinitionView = z.infer<typeof definitionViewSchema>;
export type RunDetail = z.infer<typeof runDetailSchema>;
export type Progress = { kind: 'continue' } | { kind: 'wait'; seconds: number } | { kind: 'done' };

export const businessWorkflowId = (work: Work) => `business-workflow-v1-${work.workspaceId}-${work.runId}`;
export const wakeSignal = 'wakeBusinessWorkflow';
export function waitUntilInstant(value: z.infer<typeof payloadSchema>) {
  const parsed = instantSchema.safeParse(value);
  const time = parsed.success ? Date.parse(parsed.data) : NaN;
  if (!Number.isFinite(time)) throw new Error('wait-until-invalid');
  return new Date(time);
}

export function transform(
  fields: z.infer<typeof stepSchema> & { kind: 'transform' },
  input: z.infer<typeof payloadSchema>,
  outputs: Map<string, z.infer<typeof payloadSchema>>,
) {
  return payloadSchema.parse(
    Object.fromEntries(
      Object.entries(fields.fields).map(([key, expression]) => [key, resolveValue(expression, input, outputs)]),
    ),
  );
}
export function resolveValue(
  expression: z.infer<typeof valueSchema>,
  input: z.infer<typeof payloadSchema>,
  outputs: Map<string, z.infer<typeof payloadSchema>>,
) {
  if (expression.kind === 'literal') return expression.value;
  let value = expression.kind === 'input' ? input : outputs.get(expression.step);
  for (const part of expression.path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) throw new Error('missing-value');
    value = Reflect.get(value, part);
  }
  if (value === undefined) throw new Error('missing-value');
  return payloadSchema.parse(value);
}

type Payload = z.infer<typeof payloadSchema>;
const decimalPattern = /^-?\d{1,40}(\.\d{1,40})?$/;
export class ConditionIncomparable extends Error {
  constructor() {
    super('condition-values-incomparable');
  }
}
const numericOperand = Symbol('numeric-operand');
type NumericOperand = { [numericOperand]: string };
const typedValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('numeric'), value: z.string().nullable() }),
  z.object({ kind: z.literal('single-select'), optionId: z.string().nullable() }),
  z.object({ kind: z.literal('multi-select'), optionIds: z.array(z.string()) }),
  z.object({ kind: z.enum(['text', 'boolean', 'date', 'timestamp']), value: z.unknown() }),
]);
/** Table values arrive typed, as in row trigger input and found rows, so a condition compares the value inside. A missing value is empty. */
function operand(expression: z.infer<typeof valueSchema>, input: Payload, outputs: Map<string, Payload>): unknown {
  let value: Payload;
  try {
    value = resolveValue(expression, input, outputs);
  } catch (error) {
    if (error instanceof Error && error.message === 'missing-value') return null;
    throw error;
  }
  const typed = typedValueSchema.safeParse(value);
  if (!typed.success) return value;
  switch (typed.data.kind) {
    case 'numeric':
      if (typed.data.value !== null && !decimalPattern.test(typed.data.value)) throw new ConditionIncomparable();
      return typed.data.value === null ? null : { [numericOperand]: typed.data.value };
    case 'single-select':
      return typed.data.optionId;
    case 'multi-select':
      return typed.data.optionIds;
    default:
      return typed.data.value;
  }
}
const empty = (value: unknown) => value === null || value === '' || (Array.isArray(value) && value.length === 0);
function numberDecimal(value: number) {
  const [coefficient = '', exponent] = value.toString().split(/[eE]/);
  if (exponent === undefined) return coefficient;
  const negative = coefficient.startsWith('-');
  const [whole = '', fraction = ''] = coefficient.replace('-', '').split('.');
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  const expanded =
    point <= 0
      ? `0.${'0'.repeat(-point)}${digits}`
      : point >= digits.length
        ? `${digits}${'0'.repeat(point - digits.length)}`
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return negative ? `-${expanded}` : expanded;
}
const isNumericOperand = (value: unknown): value is NumericOperand =>
  typeof value === 'object' && value !== null && numericOperand in value;
function decimal(value: unknown) {
  if (isNumericOperand(value)) return value[numericOperand];
  return typeof value === 'number' && Number.isFinite(value) ? numberDecimal(value) : null;
}
/** Compares two decimal strings exactly, so 40-digit table numbers keep their precision. */
function compareDecimals(left: string, right: string) {
  const parse = (text: string) => {
    const [whole = '', fraction = ''] = text.replace('-', '').split('.');
    const digits = { whole: whole.replace(/^0+(?=\d)/, ''), fraction: fraction.replace(/0+$/, '') };
    return { ...digits, negative: text.startsWith('-') && (digits.whole !== '0' || digits.fraction !== '') };
  };
  const a = parse(left),
    b = parse(right);
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  const width = Math.max(a.fraction.length, b.fraction.length);
  const magnitude =
    a.whole.length !== b.whole.length
      ? a.whole.length - b.whole.length
      : a.whole !== b.whole
        ? a.whole < b.whole
          ? -1
          : 1
        : a.fraction.padEnd(width, '0') < b.fraction.padEnd(width, '0')
          ? -1
          : a.fraction.padEnd(width, '0') > b.fraction.padEnd(width, '0')
            ? 1
            : 0;
  return a.negative ? -magnitude : magnitude;
}
/** Orders typed or JSON numbers by value, or two ISO dates or times as instants. Null when the pair is neither. */
function measured(left: unknown, right: unknown) {
  const leftDecimal = decimal(left),
    rightDecimal = decimal(right);
  if (leftDecimal !== null && rightDecimal !== null) return compareDecimals(leftDecimal, rightDecimal);
  if (typeof left === 'number' && typeof right === 'number' && !Number.isNaN(left - right)) return left - right;
  const leftInstant = instantSchema.safeParse(left),
    rightInstant = instantSchema.safeParse(right);
  if (leftInstant.success && rightInstant.success) return Date.parse(leftInstant.data) - Date.parse(rightInstant.data);
  return null;
}
function order(left: unknown, right: unknown) {
  const difference = measured(left, right);
  if (difference !== null) return difference;
  if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : left > right ? 1 : 0;
  throw new ConditionIncomparable();
}
const equal = (left: unknown, right: unknown) => {
  const difference = measured(left, right);
  return difference === null ? canonical(left) === canonical(right) : difference === 0;
};
/** Evaluates a condition step. Typed and JSON numbers compare by value and dates or times as instants. Ordering otherwise compares two strings as text or refuses the pair rather than guessing a branch. */
export function evaluateCondition(when: Comparison, input: Payload, outputs: Map<string, Payload>) {
  const left = operand(when.left, input, outputs);
  if (!('right' in when)) return when.op === 'is-empty' ? empty(left) : !empty(left);
  const right = operand(when.right, input, outputs);
  switch (when.op) {
    case 'eq':
      return equal(left, right);
    case 'ne':
      return !equal(left, right);
    case 'lt':
      return order(left, right) < 0;
    case 'lte':
      return order(left, right) <= 0;
    case 'gt':
      return order(left, right) > 0;
    case 'gte':
      return order(left, right) >= 0;
  }
}
/** Runs a condition step, recording the branch it chose and the steps that branch runs and skips. */
export function runCondition(
  step: ConditionStep,
  input: Payload,
  outputs: Map<string, Payload>,
): z.infer<typeof conditionOutputSchema> {
  const matched = evaluateCondition(step.when, input, outputs);
  return { matched, ran: matched ? step.ifMet : step.otherwise, skipped: matched ? step.otherwise : step.ifMet };
}
