import { z } from 'zod';

export const tableProposalOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('proposal') }),
  z.object({
    kind: z.literal('blocked'),
    report: z.object({
      status: z.literal('blocked'),
      error: z.literal('invalid-transform'),
      tableId: z.uuid(),
      revision: z.string(),
      records: z
        .array(z.object({ recordId: z.uuid(), fieldId: z.uuid().nullable(), code: z.string().regex(/^[a-z-]+$/) }))
        .min(1)
        .max(100),
      total: z.int().min(1).max(100000),
      truncated: z.boolean(),
    }),
  }),
]);

const optionSchema = z.object({ id: z.uuid(), label: z.string(), retired: z.boolean() });
const fieldBase = { id: z.uuid(), label: z.string(), required: z.boolean() };
export const tableFieldSchema = z.discriminatedUnion('kind', [
  z.object({ ...fieldBase, kind: z.literal('text'), maxLength: z.number() }),
  z.object({ ...fieldBase, kind: z.literal('numeric'), precision: z.number(), scale: z.number() }),
  z.object({ ...fieldBase, kind: z.literal('boolean') }),
  z.object({ ...fieldBase, kind: z.literal('date') }),
  z.object({ ...fieldBase, kind: z.literal('timestamp'), timezone: z.literal('UTC') }),
  z.object({ ...fieldBase, kind: z.literal('single-select'), options: z.array(optionSchema) }),
  z.object({ ...fieldBase, kind: z.literal('multi-select'), options: z.array(optionSchema) }),
  z.object({
    ...fieldBase,
    kind: z.literal('relationship'),
    targetTableId: z.uuid(),
    cardinality: z.enum(['one', 'many']),
    inverseCardinality: z.enum(['one', 'many']),
    reverse: z.object({ fieldId: z.uuid(), label: z.string() }).nullable(),
    onDelete: z.literal('restrict'),
  }),
  z.object({
    ...fieldBase,
    kind: z.literal('file'),
    cardinality: z.enum(['one', 'many']),
    access: z.literal('independent'),
  }),
]);
export const tableDefinitionSchema = z.object({
  formatVersion: z.literal(2),
  id: z.uuid(),
  owningTeamId: z.uuid(),
  label: z.string(),
  fields: z.array(tableFieldSchema),
  uniqueKeys: z.array(z.object({ id: z.uuid(), fieldIds: z.array(z.uuid()), nulls: z.literal('distinct') })),
});
export const tableValueSchema = z.union([
  z.null(),
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), value: z.string() }),
    z.object({ kind: z.literal('numeric'), value: z.string() }),
    z.object({ kind: z.literal('boolean'), value: z.boolean() }),
    z.object({ kind: z.literal('date'), value: z.string() }),
    z.object({ kind: z.literal('timestamp'), value: z.string() }),
    z.object({ kind: z.literal('single-select'), optionId: z.uuid() }),
    z.object({ kind: z.literal('multi-select'), optionIds: z.array(z.uuid()) }),
    z.object({ kind: z.literal('relationship'), tableId: z.uuid(), recordIds: z.array(z.uuid()) }),
    z.object({ kind: z.literal('file'), fileIds: z.array(z.uuid()) }),
  ]),
]);
export const tableValuesSchema = z.record(z.string(), tableValueSchema);
const planBase = { tableId: z.uuid(), dependsOn: z.array(z.uuid()) };
const planSchema = z.discriminatedUnion('kind', [
  z.object({
    ...planBase,
    kind: z.literal('schema'),
    expectedRevision: z.string().nullable(),
    target: tableDefinitionSchema,
    transforms: z.object({ outputs: z.array(z.object({ fieldId: z.uuid(), expression: z.json() })) }),
  }),
  z.object({
    ...planBase,
    kind: z.literal('records'),
    expectedRevision: z.string(),
    changes: z.array(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('create'), recordId: z.uuid(), values: tableValuesSchema }),
        z.object({ kind: z.literal('update'), recordId: z.uuid(), values: tableValuesSchema }),
        z.object({ kind: z.literal('delete'), recordId: z.uuid() }),
      ]),
    ),
  }),
  z.object({
    ...planBase,
    kind: z.literal('import'),
    expectedRevision: z.string(),
    reference: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('file'), attachmentId: z.uuid(), contentDigest: z.string() }),
      z.object({ kind: z.literal('integration'), resultId: z.uuid(), contentDigest: z.string() }),
    ]),
    matchFieldIds: z.array(z.uuid()),
    mappings: z.array(z.object({ sourceColumn: z.string(), fieldId: z.uuid() })),
  }),
]);
export const reviewedPlanSchema = z.object({
  input: planSchema,
  before: tableDefinitionSchema.nullable(),
  after: tableDefinitionSchema,
  effectCount: z.number().int().nonnegative(),
  effectsDigest: z.string(),
  audience: z
    .object({
      policy: z.literal('table-permissions'),
      administrators: z.literal(true),
      teams: z.array(z.uuid()),
      members: z.array(z.uuid()),
    })
    .nullable(),
});
export const executionReceiptSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), executionId: z.uuid(), revision: z.string().nullable() }),
  z.object({ status: z.literal('failed'), executionId: z.uuid(), code: z.string() }),
]);
const importProgressSchema = z.object({
  applied: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
});
export const proposalStatusSchema = z.object({
  id: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum([
    'pending',
    'approved',
    'running',
    'rejected',
    'cancelled',
    'expired',
    'partial',
    'failed',
    'completed',
  ]),
  decision: z.enum(['approve', 'reject']).nullable(),
  cancelled: z.boolean(),
  expired: z.boolean(),
  plans: z.array(
    z.object({
      tableId: z.uuid(),
      receipt: executionReceiptSchema.nullable(),
      importProgress: importProgressSchema.nullable().default(null),
    }),
  ),
});
export const proposalViewSchema = z.discriminatedUnion('content', [
  proposalStatusSchema.extend({
    content: z.literal('available'),
    freshness: z.enum(['current', 'stale']),
    manifest: z.object({
      version: z.literal(1),
      id: z.uuid(),
      workspaceId: z.uuid(),
      requester: z.object({ kind: z.literal('human'), userId: z.string(), membershipId: z.uuid() }),
      conversationId: z.uuid(),
      turnId: z.uuid(),
      expiresAt: z.iso.datetime(),
      plans: z.array(reviewedPlanSchema),
    }),
  }),
  proposalStatusSchema.extend({
    content: z.literal('redacted'),
    freshness: z.literal('expired'),
    manifest: z.object({
      redactedAt: z.iso.datetime(),
      originalDigest: z.string(),
      createdAt: z.iso.datetime(),
      id: z.uuid(),
      workspaceId: z.uuid(),
      conversationId: z.uuid(),
      requester: z.object({ kind: z.literal('human'), userId: z.string(), membershipId: z.uuid() }),
      plans: z.array(
        z.object({
          input: z.object({ tableId: z.uuid(), kind: z.enum(['schema', 'records', 'import']) }),
          fieldIds: z.array(z.uuid()),
          effectCount: z.int(),
        }),
      ),
    }),
  }),
]);
export const proposalEffectsSchema = z.object({
  digest: z.string(),
  total: z.number().int(),
  items: z.array(
    z.object({
      ordinal: z.number().int(),
      effect: z.object({
        recordId: z.uuid(),
        kind: z.enum(['create', 'update', 'delete']),
        before: tableValuesSchema.nullable(),
        after: tableValuesSchema.nullable(),
      }),
    }),
  ),
  nextCursor: z.number().int().nullable(),
});
export type TableDefinition = z.infer<typeof tableDefinitionSchema>;
export type TableField = z.infer<typeof tableFieldSchema>;
export type TableValue = z.infer<typeof tableValueSchema>;
export type TableValues = z.infer<typeof tableValuesSchema>;
export type ReviewedPlan = z.infer<typeof reviewedPlanSchema>;
export type ProposalView = z.infer<typeof proposalViewSchema>;
export type ImportProgress = z.infer<typeof importProgressSchema>;
export type ProposalCommand = { commandId: string; digest: string } & (
  | { decision: 'approve' | 'reject' }
  | { operation: 'cancel' | 'resume' }
);
