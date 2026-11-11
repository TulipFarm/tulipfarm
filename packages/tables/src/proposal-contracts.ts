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
const importColumnSchema = z.string().min(1).max(120);
const importConversionSchema = z.enum(['text', 'numeric', 'boolean', 'date', 'timestamp']);
/** A change made to a chat's file selection so it fits the file, shown on the import review. */
export const importAdjustmentSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('delimiter'),
    requested: z.enum([',', ';', '\t', '|']),
    used: z.enum([',', ';', '\t', '|']),
  }),
  z.strictObject({
    kind: z.literal('sheet'),
    requested: z.string().min(1).max(31),
    used: z.string().min(1).max(31),
    only: z.boolean(),
  }),
  z.strictObject({ kind: z.literal('header'), requested: z.int().min(1), used: z.int().min(1) }),
  z.strictObject({ kind: z.literal('column'), requested: importColumnSchema, used: importColumnSchema }),
  z.strictObject({
    kind: z.literal('conversion-dropped'),
    column: importColumnSchema,
    conversion: importConversionSchema,
  }),
  z.strictObject({
    kind: z.literal('conversion-changed'),
    column: importColumnSchema,
    requested: importConversionSchema,
    used: importConversionSchema,
    example: z.string().max(40),
  }),
]);
export type ImportAdjustment = z.infer<typeof importAdjustmentSchema>;
export const importAdjustmentsSchema = z.array(importAdjustmentSchema).max(64);
export const importSnapshotSchema = z.strictObject({
  contentDigest: digestSchema,
  sources: sourceDependenciesSchema,
  rows: z.array(z.record(z.string().min(1).max(120), valueSchema)).max(100000),
  adjustments: importAdjustmentsSchema.optional(),
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
const revision = z.string().regex(/^[a-f0-9]{40}$/);
export const schemaPlanSchema = z.strictObject({
  ...base,
  kind: z.literal('schema'),
  expectedRevision: z.string().nullable(),
  target: definitionSchema,
  transforms: transformsSchema,
});
export const recordsPlanSchema = z.strictObject({
  ...base,
  kind: z.literal('records'),
  expectedRevision: revision,
  changes: z.array(recordChangeSchema).min(1).max(1000),
});
export const importPlanSchema = z.strictObject({
  ...base,
  kind: z.literal('import'),
  expectedRevision: revision,
  reference: importReferenceSchema,
  matchFieldIds: z.array(z.uuid()).min(1).max(8),
  mappings: z
    .array(z.strictObject({ sourceColumn: z.string().min(1).max(120), fieldId: z.uuid() }))
    .min(1)
    .max(64),
});
export const archivePlanSchema = z.strictObject({ ...base, kind: z.literal('archive'), expectedRevision: revision });
export const restorePlanSchema = z.strictObject({ ...base, kind: z.literal('restore'), expectedRevision: revision });
export const proposalPlanSchema = z.discriminatedUnion('kind', [
  schemaPlanSchema,
  recordsPlanSchema,
  importPlanSchema,
  archivePlanSchema,
  restorePlanSchema,
]);
export const proposalPlansSchema = <T extends z.ZodType>(plan: T) => z.array(plan).min(1).max(20);
export const proposeTableSchema = z
  .strictObject({
    plans: proposalPlansSchema(proposalPlanSchema),
    /** The earlier proposal in this chat that this one replaces. */
    revises: z.uuid().optional(),
    /** A 2–5 word name for this version, such as “Add priority field”. */
    label: z.string().trim().min(1).max(40).optional(),
  })
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
  /** How the chat's file selection was changed to fit the file, listed on the import review. */
  importAdjustments: importAdjustmentsSchema.min(1).optional(),
  audience: audienceSchema.nullable(),
  importSources: sourceDependenciesSchema,
});
export const proposalManifestSchema = z
  .strictObject({
    version: z.literal(1),
    id: z.uuid(),
    workspaceId: z.uuid(),
    requester: humanActorSchema,
    conversationId: z.uuid().nullable(),
    turnId: z.uuid().nullable(),
    installationId: z.uuid().optional(),
    sources: sourceDependenciesSchema,
    expiresAt: z.iso.datetime(),
    revises: z.uuid().optional(),
    label: z.string().min(1).max(40).optional(),
    plans: z.array(reviewedPlanSchema).min(1).max(20),
  })
  .refine(
    value =>
      value.installationId
        ? value.conversationId === null && value.turnId === null
        : value.conversationId !== null
          ? value.turnId !== null
          : value.turnId === null &&
            value.plans.length === 1 &&
            ['archive', 'restore'].includes(value.plans[0]?.input.kind ?? ''),
    'A table proposal has a real conversation origin, an installation origin, or is a single direct archive or restore',
  );
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
    'superseded',
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
  conversationId: z.uuid().nullable(),
  turnId: z.uuid().nullable(),
  installationId: z.uuid().optional(),
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
    blockedReason: z.literal('skill-unavailable').optional(),
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
    | 'proposal-superseded'
    | 'dependency-unfinished'
    | 'invalid-transform'
    | 'invalid-import'
    | 'import-adapter-required'
    | 'import-reference-unknown'
    | 'proposal-storage-unavailable'
    | 'table-activation-unavailable'
    | 'proposal-too-large'
    | 'unsupported-definition'
    | 'table-linked'
    | 'workflow-active'
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

export const importProblemCodes = [
  'unknown-column',
  'unknown-field',
  'key-not-unique',
  'key-unmapped',
  'missing-key',
  'duplicate-key',
  'existing-duplicate-key',
  'unmapped-value',
  'conversion-failed',
  'type-mismatch',
  'missing-field',
  'invalid-output',
] as const;
export const importProblemSchema = z.strictObject({
  /** 1-based data row in the prepared file, counting from the first row after the header. */
  row: z.int().min(1).nullable(),
  column: z.string().max(120).nullable(),
  fieldId: z.string().max(100).nullable(),
  field: z.string().max(200).nullable(),
  code: z.enum(importProblemCodes),
  value: z.string().max(60).nullable(),
  /** Valid choices the person can use instead, such as option labels or file columns. */
  expected: z.array(z.string().max(200)).max(20).optional(),
});
export type ImportProblem = z.infer<typeof importProblemSchema>;
/** An import plan whose file values or mappings cannot become the table's rows; it names each problem. */
export class TableImportPlanError extends TableProposalError {
  readonly problems: ImportProblem[];
  readonly total: number;
  constructor(problems: ImportProblem[], total = problems.length) {
    super('invalid-import');
    this.problems = z.array(importProblemSchema).max(100).parse(problems.slice(0, 100));
    this.total = Math.max(total, this.problems.length);
  }
  get truncated() {
    return this.total > this.problems.length;
  }
}
