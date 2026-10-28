import { z } from 'zod';
import { fieldSchema, decimalSchema, dateSchema } from '@tulipfarm/tables/definition';
import { assetPermissionSchema, tablePermissionSchema } from '@tulipfarm/access/contracts';
import { mcpPermissionSlotsSchema } from '@tulipfarm/workspaces/agent-document';
import { fileNameSchema } from '@tulipfarm/files/contracts';
import {
  stepSchema,
  valueSchema as workflowValueSchema,
  agentTaskLimitsSchema,
  providerSourceSchema,
  rowEventSchema,
  httpStepSchema,
  intervalTriggerSchema,
  cronTriggerSchema,
  rawWebhookSchema,
  recordFieldScheduleSchema,
  recordFilterSchema,
} from '@tulipfarm/workflows/contracts';
import { agentDefinitionSchema, taskLimitsSchema } from './contracts.ts';
import { skillPackageLimits, skillPathSchema } from './skill-package-contracts.ts';
import { skillSelectionSchema } from './skill-ids.ts';
import { agentPermissionSchema } from './saved-contracts.ts';
import { scheduleActionSchema } from './schedule-contracts.ts';

export const systemPackageSchemaId = 'https://tulipfarm.ai/schemas/system-package.v1.json';
export const packageKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const title = z.string().trim().min(1).max(120);
const reference = <T extends string>(resourceKind: T) =>
  z.strictObject({ kind: z.literal('resource'), resourceKind: z.literal(resourceKind), key: packageKeySchema });
const inputReference = <T extends string>(inputKind: T) =>
  z.strictObject({ kind: z.literal('input'), inputKind: z.literal(inputKind), key: packageKeySchema });
export const packageTableReferenceSchema = reference('table');
export const packageInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ key: packageKeySchema, kind: z.literal('team'), title }),
  z.strictObject({ key: packageKeySchema, kind: z.literal('member'), title }),
  z.strictObject({ key: packageKeySchema, kind: z.literal('integration'), title }),
  z.strictObject({ key: packageKeySchema, kind: z.literal('timezone'), title }),
  ...(['file', 'asset', 'skill', 'agent', 'connection', 'slack-destination', 'slack-channel'] as const).map(kind =>
    z.strictObject({ key: packageKeySchema, kind: z.literal(kind), title }),
  ),
]);
const timezone = z.union([z.string().min(1).max(100), inputReference('timezone')]);
const principal = z.union([inputReference('team'), inputReference('member')]);
const sharing = <T extends z.ZodType>(permission: T) =>
  z.strictObject({
    grants: z.array(z.strictObject({ team: inputReference('team'), permissions: z.array(permission) })).max(100),
    personGrants: z
      .array(z.strictObject({ member: inputReference('member'), permissions: z.array(permission) }))
      .max(100),
  });
export const packageAssetReferenceSchema = z.union([reference('file'), inputReference('file')]);
const fieldBase = { key: packageKeySchema, label: title, required: z.boolean() };
const option = z.strictObject({ key: packageKeySchema, label: title, retired: z.boolean() });
export const packageFieldSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...fieldSchema.options[0].shape, ...fieldBase }).omit({ id: true }),
  z.strictObject({ ...fieldSchema.options[1].shape, ...fieldBase }).omit({ id: true }),
  z.strictObject({ ...fieldSchema.options[2].shape, ...fieldBase }).omit({ id: true }),
  z.strictObject({ ...fieldSchema.options[3].shape, ...fieldBase }).omit({ id: true }),
  z.strictObject({ ...fieldSchema.options[4].shape, ...fieldBase }).omit({ id: true }),
  z.strictObject({ ...fieldBase, kind: z.literal('single-select'), options: z.array(option).min(1).max(256) }),
  z.strictObject({ ...fieldBase, kind: z.literal('multi-select'), options: z.array(option).min(1).max(256) }),
  z.strictObject({
    ...fieldBase,
    kind: z.literal('relationship'),
    target: packageTableReferenceSchema,
    cardinality: z.enum(['one', 'many']),
    inverseCardinality: z.enum(['one', 'many']),
    reverse: z.strictObject({ key: packageKeySchema, label: title }).nullable(),
    onDelete: z.literal('restrict'),
  }),
  z.strictObject({ ...fieldSchema.options[8].shape, ...fieldBase }).omit({ id: true }),
]);
export const packageRowValueSchema = z.union([
  z.null(),
  z.strictObject({ kind: z.literal('text'), value: z.string().max(10000) }),
  z.strictObject({ kind: z.literal('numeric'), value: decimalSchema }),
  z.strictObject({ kind: z.literal('boolean'), value: z.boolean() }),
  z.strictObject({ kind: z.literal('date'), value: dateSchema }),
  z.strictObject({ kind: z.literal('timestamp'), value: z.iso.datetime({ offset: true }) }),
  z.strictObject({ kind: z.literal('single-select'), option: packageKeySchema }),
  z.strictObject({ kind: z.literal('multi-select'), options: z.array(packageKeySchema).max(256) }),
  z.strictObject({ kind: z.literal('relationship'), rows: z.array(reference('seed-row')).max(256) }),
  z.strictObject({ kind: z.literal('file'), files: z.array(packageAssetReferenceSchema).max(256) }),
]);
const workflowName = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
const workflowPath = z.array(z.union([z.string().max(100), z.strictObject({ field: packageKeySchema })])).max(16);
export const packageWorkflowValueSchema = z.discriminatedUnion('kind', [
  workflowValueSchema.options[0],
  z.strictObject({ kind: z.literal('input'), path: workflowPath }),
  z.strictObject({ kind: z.literal('step'), step: workflowName, path: workflowPath }),
  z.strictObject({
    kind: z.literal('option'),
    table: packageTableReferenceSchema,
    field: packageKeySchema,
    option: packageKeySchema,
  }),
  z.strictObject({
    kind: z.literal('options'),
    table: packageTableReferenceSchema,
    field: packageKeySchema,
    options: z.array(packageKeySchema).max(256),
  }),
]);
export const packageWorkflowFieldValueSchema = z.union([
  packageWorkflowValueSchema,
  z.strictObject({ kind: z.literal('table-value'), value: packageRowValueSchema }),
]);
const mappings = z
  .array(z.strictObject({ field: packageKeySchema, value: packageWorkflowFieldValueSchema }))
  .min(1)
  .max(64);
export const packageWorkflowStepSchema = z.discriminatedUnion('kind', [
  stepSchema.options[0].extend({
    when: z.union([
      z.strictObject({
        left: packageWorkflowValueSchema,
        op: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']),
        right: packageWorkflowValueSchema,
      }),
      z.strictObject({ left: packageWorkflowValueSchema, op: z.enum(['is-empty', 'not-empty']) }),
    ]),
  }),
  stepSchema.options[1].extend({
    fields: z.record(workflowName, packageWorkflowValueSchema).refine(fields => Object.keys(fields).length <= 32),
  }),
  stepSchema.options[2],
  stepSchema.options[3].extend({ at: packageWorkflowValueSchema }),
  stepSchema.options[4],
  stepSchema.options[5].extend({ input: packageWorkflowValueSchema }),
  z.strictObject({
    id: workflowName,
    kind: z.literal('agent'),
    agent: z.union([reference('agent'), inputReference('agent')]),
    prompt: packageWorkflowValueSchema,
    limits: agentTaskLimitsSchema,
  }),
  z.strictObject({
    id: workflowName,
    kind: z.literal('find-rows'),
    table: packageTableReferenceSchema,
    filters: z
      .array(
        z.union([
          z.strictObject({
            field: packageKeySchema,
            op: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']),
            value: packageWorkflowValueSchema,
          }),
          z.strictObject({ field: packageKeySchema, op: z.enum(['is-null', 'not-null']) }),
        ]),
      )
      .max(16),
    limit: z.number().int().min(1).max(50),
  }),
  z.strictObject({
    id: workflowName,
    kind: z.literal('create-row'),
    table: packageTableReferenceSchema,
    fields: mappings,
  }),
  z.strictObject({
    id: workflowName,
    kind: z.literal('update-row'),
    table: packageTableReferenceSchema,
    row: packageWorkflowValueSchema,
    fields: mappings,
  }),
  z.strictObject({
    id: workflowName,
    kind: z.literal('http'),
    method: httpStepSchema.shape.method,
    url: httpStepSchema.shape.url,
    headers: z.record(httpStepSchema.shape.headers.unwrap().keyType, packageWorkflowValueSchema).default({}),
    body: packageWorkflowValueSchema.optional(),
    credential: z
      .strictObject({
        integration: inputReference('connection'),
        header: httpStepSchema.shape.credential.unwrap().shape.header,
      })
      .optional(),
  }),
  z.strictObject({
    id: workflowName,
    kind: z.literal('slack-message'),
    destination: inputReference('slack-destination'),
    text: packageWorkflowValueSchema,
    sender: z.enum(['user', 'app']).optional(),
  }),
]);
const recordFilter = z.union([
  recordFilterSchema.options[0].omit({ fieldId: true }).extend({
    field: packageKeySchema,
    value: z.discriminatedUnion('kind', [
      recordFilterSchema.options[0].shape.value.options[0],
      recordFilterSchema.options[0].shape.value.options[1],
      z.strictObject({ kind: z.literal('single-select'), option: packageKeySchema }),
      recordFilterSchema.options[0].shape.value.options[3],
      recordFilterSchema.options[0].shape.value.options[4],
      recordFilterSchema.options[0].shape.value.options[5],
    ]),
  }),
  recordFilterSchema.options[1].omit({ fieldId: true }).extend({ field: packageKeySchema }),
  recordFilterSchema.options[2].omit({ fieldId: true }).extend({ field: packageKeySchema }),
]);
const recordSchedule = z.discriminatedUnion('kind', [
  recordFieldScheduleSchema.options[0].omit({ fieldId: true }).extend({ field: packageKeySchema, timezone }),
  recordFieldScheduleSchema.options[1].omit({ fieldId: true }).extend({ field: packageKeySchema }),
]);
const portableCron = cronTriggerSchema.extend({ timezone });
export const packageWorkflowTriggerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual') }),
  z.strictObject({
    kind: z.literal('row'),
    table: packageTableReferenceSchema,
    event: rowEventSchema,
    fields: z.array(packageKeySchema).min(1).max(64).optional(),
    filter: recordFilter.optional(),
  }),
  z.strictObject({
    kind: z.literal('provider'),
    integration: reference('integration'),
    event: z.enum(['created', 'updated']),
    minutes: z.number().int().min(1).max(1440),
  }),
  z.strictObject({
    kind: z.literal('record'),
    table: packageTableReferenceSchema,
    field: recordSchedule,
    filter: recordFilter.optional(),
  }),
  z.strictObject({ kind: z.literal('webhook'), payload: rawWebhookSchema.optional() }),
  z.strictObject({ kind: z.literal('event'), name: workflowName }),
  z.strictObject({ kind: z.literal('once'), at: z.iso.datetime(), timezone: timezone.optional() }),
  intervalTriggerSchema,
  portableCron,
]);
const scope = z
  .array(
    z.union([
      z.strictObject({
        table: packageTableReferenceSchema,
        permissions: z
          .array(tablePermissionSchema.exclude(['table.create']))
          .min(1)
          .max(5),
      }),
      z.strictObject({
        asset: inputReference('asset'),
        permissions: z.array(assetPermissionSchema).min(1).max(14),
      }),
    ]),
  )
  .max(100);
const portableMcp = z
  .array(
    z.strictObject({
      id: mcpPermissionSlotsSchema.element.shape.id,
      serverIdentity: mcpPermissionSlotsSchema.element.shape.serverIdentity,
      tools: mcpPermissionSlotsSchema.element.shape.tools,
      integration: inputReference('connection').optional(),
    }),
  )
  .max(20);
export const packageResourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    key: packageKeySchema,
    kind: z.literal('table'),
    label: title,
    owningTeam: inputReference('team'),
    fields: z.array(packageFieldSchema).max(64),
    uniqueKeys: z
      .array(
        z.strictObject({
          key: packageKeySchema,
          fields: z.array(packageKeySchema).min(1).max(8),
          nulls: z.literal('distinct'),
        }),
      )
      .max(64),
    sharing: sharing(tablePermissionSchema.exclude(['table.create'])).optional(),
  }),
  z.strictObject({
    key: packageKeySchema,
    kind: z.literal('seed-row'),
    table: packageTableReferenceSchema,
    values: z.record(packageKeySchema, packageRowValueSchema),
  }),
  z.strictObject({
    key: packageKeySchema,
    kind: z.literal('skill'),
    files: z
      .array(z.strictObject({ path: skillPathSchema, asset: packageKeySchema }))
      .min(1)
      .max(skillPackageLimits.files),
    requestedState: z.enum(['saved', 'enabled']),
    sharing: sharing(z.enum(['read', 'use', 'manage'])).optional(),
  }),
  z.strictObject({
    key: packageKeySchema,
    kind: z.literal('agent'),
    definition: agentDefinitionSchema.omit({ skills: true, mcp: true }).extend({ mcp: portableMcp.optional() }),
    skills: z
      .array(
        z.union([
          reference('skill'),
          skillSelectionSchema.extend({ kind: z.literal('builtin') }),
          inputReference('skill').extend({ revision: digest }),
        ]),
      )
      .max(16),
    owningTeam: inputReference('team').nullable(),
    scope,
    taskLimits: taskLimitsSchema,
    policy: sharing(agentPermissionSchema).optional(),
    enrollment: z.array(inputReference('team')).max(100).default([]),
    limits: scope.optional(),
    slackSender: z.enum(['user', 'app']).default('user'),
    slackChannels: z
      .array(
        z.strictObject({
          channel: inputReference('slack-channel'),
          replaceAgent: inputReference('agent').nullable(),
          detach: z.boolean().optional(),
        }),
      )
      .max(100)
      .default([]),
    schedules: z
      .array(
        z.strictObject({
          key: packageKeySchema,
          trigger: z.discriminatedUnion('kind', [intervalTriggerSchema, portableCron]),
          action: scheduleActionSchema.options[1],
          sponsor: inputReference('member'),
        }),
      )
      .max(100)
      .default([]),
    requestedState: z.enum(['saved', 'active']),
  }),
  z.strictObject({
    key: packageKeySchema,
    kind: z.literal('workflow'),
    name: title,
    trigger: packageWorkflowTriggerSchema,
    steps: z.array(packageWorkflowStepSchema).min(1).max(32),
    sponsor: inputReference('member').nullable(),
    historyAudience: z.array(inputReference('member')).min(1).max(100).optional(),
    sharing: z
      .array(
        z.strictObject({
          principal,
          permissions: z.array(z.enum(['read', 'invoke', 'manage'])).max(3),
        }),
      )
      .max(200)
      .default([]),
    requestedState: z.enum(['saved', 'enabled']),
  }),
  z.strictObject({
    key: packageKeySchema,
    kind: z.literal('integration'),
    binding: inputReference('integration'),
    source: providerSourceSchema,
    capabilities: z.array(z.literal('events.read')).min(1).max(1),
  }),
  z.strictObject({
    key: packageKeySchema,
    kind: z.literal('file'),
    asset: packageKeySchema,
    name: fileNameSchema,
    mimeType: z.string().min(1).max(255),
  }),
]);
export const systemPackageSchema = z.strictObject({
  $schema: z.literal(systemPackageSchemaId).optional(),
  formatVersion: z.literal(1),
  package: z.strictObject({
    name: packageKeySchema,
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
    title,
    description: z.string().min(1).max(4000),
    license: z.string().min(1).max(100),
  }),
  requires: z.strictObject({
    platform: z.literal('tulipfarm-system-package-v1'),
    capabilities: z
      .array(z.enum(['tables', 'seed-rows', 'skills', 'agents', 'workflows', 'integration-bindings', 'files']))
      .max(7),
  }),
  inputs: z.array(packageInputSchema).max(100),
  resources: z.array(packageResourceSchema).min(1).max(100),
  assets: z
    .array(
      z.strictObject({
        key: packageKeySchema,
        path: skillPathSchema,
        encoding: z.enum(['utf8', 'base64']),
        content: z
          .string()
          .max(Math.ceil(skillPackageLimits.bytes / 3) * 4)
          .refine(
            value => !/[\uD800-\uDFFF]/u.test(value) && !value.includes('\0'),
            'Asset text must be well-formed Unicode without null bytes',
          ),
        size: z.number().int().min(0).max(skillPackageLimits.bytes),
        sha256: digest,
      }),
    )
    .max(skillPackageLimits.files),
  outputs: z
    .array(
      z.strictObject({
        key: packageKeySchema,
        resource: z.discriminatedUnion('resourceKind', [
          reference('table'),
          reference('seed-row'),
          reference('skill'),
          reference('agent'),
          reference('workflow'),
          reference('integration'),
          reference('file'),
        ]),
      }),
    )
    .max(100),
});
export type SystemPackage = z.infer<typeof systemPackageSchema>;
export type PackageResource = SystemPackage['resources'][number];
export const packageBindingsSchema = z.record(
  packageKeySchema,
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('team'), id: z.uuid() }),
    z.strictObject({ kind: z.literal('member'), id: z.uuid() }),
    z.strictObject({ kind: z.literal('integration'), id: z.uuid() }),
    z.strictObject({ kind: z.literal('timezone'), value: z.string().min(1).max(100) }),
    ...(['file', 'asset', 'skill', 'agent', 'connection', 'slack-destination'] as const).map(kind =>
      z.strictObject({ kind: z.literal(kind), id: z.uuid() }),
    ),
    z.strictObject({ kind: z.literal('slack-channel'), value: z.string().regex(/^[CG][A-Z0-9]{1,63}$/) }),
  ]),
);
export type PackageBindings = z.infer<typeof packageBindingsSchema>;
export const validateSystemPackageSchema = z.strictObject({
  package: systemPackageSchema,
  bindings: packageBindingsSchema,
});
export const importSystemPackageSchema = validateSystemPackageSchema.extend({
  requestId: z.uuid(),
  chatId: z.uuid().optional(),
});
export const packageIssueSchema = z.strictObject({
  code: z.string(),
  path: z.string(),
  message: z.string(),
});
export const packageValidationSchema = z.strictObject({
  valid: z.boolean(),
  packageDigest: digest,
  inputDigest: digest,
  issues: z.array(packageIssueSchema),
  order: z.array(packageKeySchema),
});
export const installationNodeSchema = z.strictObject({
  key: z.string(),
  kind: z.enum(['table', 'seed-row', 'skill', 'agent', 'workflow', 'integration', 'file', 'verify']),
  attempt: z.number().int().nonnegative().default(0),
  title: z.string(),
  dependsOn: z.array(z.string()),
  state: z.enum(['pending', 'waiting-review', 'running', 'saved', 'completed', 'failed', 'blocked']),
  resourceId: z.uuid().nullable(),
  revision: z.string().nullable(),
  error: z.string().nullable(),
  review: z
    .strictObject({
      digest,
      description: z.string(),
      href: z.string().nullable(),
    })
    .nullable(),
  definition: packageResourceSchema.nullable(),
});
export const systemPackageInstallationSchema = z.strictObject({
  id: z.uuid(),
  workspaceId: z.uuid(),
  chatId: z.uuid().nullable(),
  package: systemPackageSchema.shape.package,
  packageDigest: digest,
  inputDigest: digest,
  bindings: packageBindingsSchema,
  assets: systemPackageSchema.shape.assets,
  version: z.number().int().nonnegative(),
  status: z.enum(['pending', 'waiting-review', 'running', 'blocked', 'failed', 'completed']),
  nodes: z.array(installationNodeSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SystemPackageInstallation = z.infer<typeof systemPackageInstallationSchema>;
export type InstallationNode = z.infer<typeof installationNodeSchema>;
export const installationReviewSchema = z.strictObject({
  requestId: z.uuid(),
  expectedVersion: z.number().int().nonnegative(),
  key: packageKeySchema,
  digest,
  decision: z.enum(['approve', 'reject']),
});
export const installationResumeSchema = z.strictObject({ expectedVersion: z.number().int().nonnegative() });
export const installationListSchema = z.strictObject({
  installations: z.array(systemPackageInstallationSchema),
  nextCursor: z.uuid().nullable(),
});
