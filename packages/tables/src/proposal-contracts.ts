import { z } from 'zod';
import { humanActorSchema, sourceDependenciesSchema } from '@tulipfarm/access';
import { definitionSchema, tableDefinitionRules, valueSchema, valuesSchema, type TableRule } from './definition.ts';
import { transformsSchema, transformErrorSchema } from './transforms.ts';

export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const recordChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('create'), recordId: z.uuid(), values: valuesSchema }),
  z.strictObject({ kind: z.literal('update'), recordId: z.uuid(), values: valuesSchema }),
  z.strictObject({ kind: z.literal('delete'), recordId: z.uuid() }),
]);
export const importReferenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), attachmentId: z.uuid(), contentDigest: digestSchema }),
  z.strictObject({ kind: z.literal('integration'), resultId: z.uuid(), contentDigest: digestSchema }),
]);
export const importSnapshotSchema = z.strictObject({
  contentDigest: digestSchema,
  sources: sourceDependenciesSchema,
  rows: z.array(z.record(z.string().min(1).max(120), valueSchema)).max(100000),
});
export const tableProposalMessages = {
  planOrder: 'Plans must have unique table identities and depend only on earlier plans',
  targetMismatch: 'Target table identity mismatch',
  duplicateRow: 'Duplicate row identity',
  duplicateImportField: 'Duplicate import mapping or match field',
} as const;
export const tableProposalRules: readonly TableRule[] = [
  ...tableDefinitionRules,
  {
    message: tableProposalMessages.planOrder,
    rule: 'Each plan must have a unique tableId, and dependsOn may only list tableIds of earlier plans.',
  },
  { message: tableProposalMessages.targetMismatch, rule: 'A schema plan target.id must equal its tableId.' },
  { message: tableProposalMessages.duplicateRow, rule: 'A records plan must not change the same recordId twice.' },
  {
    message: tableProposalMessages.duplicateImportField,
    rule: 'An import plan must not repeat a matchFieldIds entry or map two source columns to the same fieldId.',
  },
];
const base = { tableId: z.uuid(), dependsOn: z.array(z.uuid()).max(20) };
export const proposalPlanSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...base,
    kind: z.literal('schema'),
    expectedRevision: z.string().nullable(),
    target: definitionSchema,
    transforms: transformsSchema,
  }),
  z.strictObject({
    ...base,
    kind: z.literal('records'),
    expectedRevision: z.string().regex(/^[a-f0-9]{40}$/),
    changes: z.array(recordChangeSchema).min(1).max(1000),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('import'),
    expectedRevision: z.string().regex(/^[a-f0-9]{40}$/),
    reference: importReferenceSchema,
    matchFieldIds: z.array(z.uuid()).min(1).max(8),
    mappings: z
      .array(z.strictObject({ sourceColumn: z.string().min(1).max(120), fieldId: z.uuid() }))
      .min(1)
      .max(64),
  }),
  z.strictObject({ ...base, kind: z.literal('archive'), expectedRevision: z.string().regex(/^[a-f0-9]{40}$/) }),
  z.strictObject({ ...base, kind: z.literal('restore'), expectedRevision: z.string().regex(/^[a-f0-9]{40}$/) }),
]);
export const proposeTableSchema = z
  .strictObject({ plans: z.array(proposalPlanSchema).min(1).max(20) })
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    for (const plan of input.plans) {
      if (seen.has(plan.tableId) || plan.dependsOn.some(id => !seen.has(id)))
        ctx.addIssue({
          code: 'custom',
          message: tableProposalMessages.planOrder,
        });
      seen.add(plan.tableId);
      if (plan.kind === 'schema' && plan.target.id !== plan.tableId)
        ctx.addIssue({ code: 'custom', message: tableProposalMessages.targetMismatch });
      if (plan.kind === 'records' && new Set(plan.changes.map(change => change.recordId)).size !== plan.changes.length)
        ctx.addIssue({ code: 'custom', message: tableProposalMessages.duplicateRow });
      if (
        plan.kind === 'import' &&
        (new Set(plan.matchFieldIds).size !== plan.matchFieldIds.length ||
          new Set(plan.mappings.map(mapping => mapping.fieldId)).size !== plan.mappings.length)
      )
        ctx.addIssue({ code: 'custom', message: tableProposalMessages.duplicateImportField });
    }
  });
export const effectSchema = z.strictObject({
  recordId: z.uuid(),
  kind: z.enum(['create', 'update', 'delete']),
  before: valuesSchema.nullable(),
  after: valuesSchema.nullable(),
});
export const audienceSchema = z.strictObject({
  policy: z.literal('table-permissions'),
  administrators: z.literal(true),
  teams: z.array(z.uuid()),
  members: z.array(z.uuid()),
});
export const reviewedPlanSchema = z.strictObject({
  input: proposalPlanSchema,
  before: definitionSchema.nullable(),
  after: definitionSchema,
  effectCount: z.int().min(0).max(100000),
  effectsDigest: digestSchema,
  freshnessDigest: digestSchema,
  importMatchesDigest: digestSchema.optional(),
  audience: audienceSchema.nullable(),
  importSources: sourceDependenciesSchema,
});
export const proposalManifestSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  workspaceId: z.uuid(),
  requester: humanActorSchema,
  conversationId: z.uuid(),
  turnId: z.uuid(),
  sources: sourceDependenciesSchema,
  expiresAt: z.iso.datetime(),
  plans: z.array(reviewedPlanSchema).min(1).max(20),
});
export const proposalDecisionSchema = z.strictObject({
  commandId: z.uuid(),
  digest: digestSchema,
  decision: z.enum(['approve', 'reject']),
});
export const proposalControlSchema = z.strictObject({
  commandId: z.uuid(),
  digest: digestSchema,
  operation: z.enum(['cancel', 'resume']),
});
export const proposalPageSchema = z.object({
  after: z.coerce.number().int().min(-1).default(-1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const executionReceiptSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('completed'), executionId: z.uuid(), revision: z.string().nullable() }),
  z.strictObject({ status: z.literal('failed'), executionId: z.uuid(), code: z.string().regex(/^[a-z0-9-]{1,100}$/) }),
]);
export const importProgressSchema = z.strictObject({ applied: z.int().min(0), remaining: z.int().min(0) });
export const proposalStatusSchema = z.object({
  id: z.uuid(),
  digest: digestSchema,
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
      importProgress: importProgressSchema.nullable(),
    }),
  ),
});
export const redactedManifestSchema = z.strictObject({
  version: z.literal(1),
  redactedAt: z.iso.datetime(),
  originalDigest: digestSchema,
  originalInputDigest: digestSchema,
  id: z.uuid(),
  workspaceId: z.uuid(),
  requester: humanActorSchema,
  conversationId: z.uuid(),
  turnId: z.uuid(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  plans: z.array(
    z.strictObject({
      input: z.strictObject({ tableId: z.uuid(), kind: z.enum(['schema', 'records', 'import', 'archive', 'restore']) }),
      fieldIds: z.array(z.uuid()),
      effectCount: z.int().nonnegative(),
      effectsDigest: digestSchema,
      freshnessDigest: digestSchema,
      importMatchesDigest: digestSchema.optional(),
    }),
  ),
});
export const proposalViewSchema = z.discriminatedUnion('content', [
  proposalStatusSchema.extend({
    content: z.literal('available'),
    manifest: proposalManifestSchema,
    freshness: z.enum(['current', 'stale']),
    unavailableFileIds: z.array(z.uuid()).optional(),
  }),
  proposalStatusSchema.extend({
    content: z.literal('redacted'),
    manifest: redactedManifestSchema,
    freshness: z.literal('expired'),
  }),
]);
export const proposalEffectsPageSchema = z.object({
  digest: digestSchema,
  total: z.int(),
  items: z.array(
    z.object({ ordinal: z.int(), effect: effectSchema, unavailableFileIds: z.array(z.uuid()).optional() }),
  ),
  nextCursor: z.int().nullable(),
});
export type ProposalPlan = z.infer<typeof proposalPlanSchema>;
export type ProposalManifest = z.infer<typeof proposalManifestSchema>;
export type TableEffect = z.infer<typeof effectSchema>;
export type ReviewedPlan = z.infer<typeof reviewedPlanSchema>;
export class TableProposalError extends Error {
  readonly code:
    | 'proposal-redacted'
    | 'proposal-conflict'
    | 'proposal-stale'
    | 'proposal-expired'
    | 'proposal-not-approved'
    | 'proposal-cancelled'
    | 'dependency-unfinished'
    | 'invalid-transform'
    | 'invalid-import'
    | 'import-adapter-required'
    | 'proposal-storage-unavailable'
    | 'proposal-too-large'
    | 'unsupported-definition'
    | 'table-linked'
    | 'workflow-active'
    | 'agent-schedule-active'
    | 'table-title-immutable'
    | 'table-name-unavailable';
  constructor(code: TableProposalError['code']) {
    super(code);
    this.code = code;
  }
}

export const invalidProposalRecordSchema = z.strictObject({
  recordId: z.uuid(),
  fieldId: z.uuid().nullable(),
  code: transformErrorSchema.shape.code,
});
export const blockedTableProposalSchema = z.strictObject({
  status: z.literal('blocked'),
  error: z.literal('invalid-transform'),
  tableId: z.uuid(),
  revision: z.string().max(100),
  records: z.array(invalidProposalRecordSchema).min(1).max(100),
  total: z.int().min(1).max(100000),
  truncated: z.boolean(),
  instruction: z.string().max(2048),
});
export type InvalidProposalRecord = z.infer<typeof invalidProposalRecordSchema>;
export class TableProposalValidationError extends TableProposalError {
  readonly validation: z.infer<typeof blockedTableProposalSchema>;
  constructor(tableId: string, revision: string, records: InvalidProposalRecord[], total: number) {
    super('invalid-transform');
    this.validation = blockedTableProposalSchema.parse({
      status: 'blocked',
      error: this.code,
      tableId,
      revision,
      records: records.slice(0, 100),
      total,
      truncated: total > 100,
      instruction:
        'The current schema and records are unchanged. No proposal was saved. Show these record IDs, field IDs and error codes to the requester and ask how to correct the values or transformation rules. Do not repair, drop, or replace invalid values automatically. After correction, propose again for a new review. This list shows the first 100 invalid records at most, with the first error per record; another review may reveal further field errors.',
    });
  }
}
