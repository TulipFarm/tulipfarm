import { z } from 'zod';
import {
  cursorSchema,
  definitionSchema,
  recordIdSchema,
  revisionSchema,
  valueSchema,
} from '@tulipfarm/tables/definition';
import {
  metricFunctions,
  queryIssueSchema,
  queryOps,
  tableRowsQuerySchema,
  tableSummaryQuerySchema,
} from '@tulipfarm/tables/query';

export const agentRecordValueSchema = valueSchema;
// unavailableFileIds lists stored file ids the reader cannot open, as on the human table API.
export const agentRecordSchema = z.strictObject({
  id: recordIdSchema,
  token: z.uuid().optional(),
  values: z.record(z.string(), agentRecordValueSchema),
  unavailableFileIds: z.array(z.uuid()).optional(),
});
export const agentTableStatusSchema = z.strictObject({
  id: z.uuid(),
  owningTeamId: z.uuid(),
  name: z.string(),
  savedRevision: revisionSchema,
  appliedRevision: revisionSchema.nullable(),
  appliedDefinition: definitionSchema.nullable(),
  maintenance: z.boolean(),
  migration: z.null(),
  systemKind: z.literal('workspace-members').optional(),
});
export const agentRecordListSchema = z.strictObject({
  records: z.array(agentRecordSchema),
  total: z.string().nullable(),
  nextCursor: z.uuid().nullable(),
});

/** Query capabilities without the labels and options already present in appliedDefinition. */
export const agentQueryCapabilitiesSchema = z.strictObject({
  fields: z.array(
    z.strictObject({
      fieldId: z.uuid(),
      selector: z.string(),
      ops: z.array(z.enum(queryOps)),
      sortable: z.boolean(),
      groupable: z.boolean(),
      metrics: z.array(z.enum(metricFunctions)),
      targetTableId: z.uuid().optional(),
    }),
  ),
  limits: z.record(z.string(), z.number()),
  rsqlOperators: z.record(z.string(), z.string()),
});
export const agentTableInspectSchema = agentTableStatusSchema.extend({ query: agentQueryCapabilitiesSchema });

const canonical = { version: z.literal(2), rsql: z.string(), references: z.record(z.uuid(), z.string()) };
export const agentQueryRecordListSchema = z.strictObject({
  ...canonical,
  mode: z.literal('rows'),
  query: tableRowsQuerySchema.omit({ after: true }),
  records: z.array(agentRecordSchema),
  total: z.string().nullable(),
  nextCursor: cursorSchema.nullable(),
});
export const agentQuerySummarySchema = z.strictObject({
  ...canonical,
  mode: z.literal('summary'),
  query: tableSummaryQuerySchema.omit({ after: true }),
  groups: z.array(z.strictObject({ keys: z.array(z.string().nullable()), values: z.array(z.string().nullable()) })),
  groupCount: z.string().nullable(),
  nextCursor: cursorSchema.nullable(),
});
export const agentReferenceChoicesSchema = z.strictObject({
  fieldId: z.uuid(),
  targetTableId: z.uuid(),
  choices: z.array(z.strictObject({ id: z.uuid(), label: z.string() })),
  more: z.boolean(),
});
export const agentQueryErrorSchema = z.strictObject({
  error: z.literal('invalid-query'),
  issues: z.array(queryIssueSchema),
  instruction: z.string(),
});
export const agentStaleRevisionSchema = z.strictObject({ error: z.literal('stale-revision'), instruction: z.string() });
