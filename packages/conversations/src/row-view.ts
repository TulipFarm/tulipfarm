import { z } from 'zod';

const optionsSchema = z.object({
  version: z.literal(2),
  mode: z.literal('rows'),
  search: z.string().min(1).max(255).optional(),
  sort: z.array(z.strictObject({ fieldId: z.uuid(), direction: z.enum(['asc', 'desc']) })).max(3),
  select: z.array(z.uuid()).min(1).max(64).optional(),
  limit: z.int().min(1).max(100),
  after: z.string().max(81000).optional(),
});

export const rowViewSchema = z.strictObject({
  callId: z.uuid(),
  tableId: z.uuid(),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  recordIds: z.array(z.uuid()).max(100).optional(),
  query: z.strictObject({ rsql: z.string().max(8192), options: optionsSchema }),
});
export type RowView = z.infer<typeof rowViewSchema>;

const callSchema = z.object({
  tool: z.literal('rows.list'),
  tableId: z.uuid(),
  expectedAppliedRevision: rowViewSchema.shape.revision,
  query: z.object({ version: z.literal(2), after: optionsSchema.shape.after }),
});
const outputSchema = z.object({
  result: z.object({
    version: z.literal(2),
    mode: z.literal('rows'),
    rsql: rowViewSchema.shape.query.shape.rsql,
    query: optionsSchema,
  }),
});
const pageCallSchema = z.object({
  tool: z.literal('rows.page'),
  tableId: z.uuid(),
  revision: rowViewSchema.shape.revision,
});
const getCallSchema = z.object({
  tool: z.literal('rows.get'),
  tableId: z.uuid(),
  expectedAppliedRevision: rowViewSchema.shape.revision,
  recordId: z.uuid(),
});
const recordIdentity = z.object({ id: z.uuid() });

/** Saved execution output supplies the normalized filter, never a model-authored display snapshot. */
export function rowViewForReceipt(row: {
  id: string;
  tool: string;
  status: string;
  call?: unknown;
  output?: unknown;
}): RowView | undefined {
  if (row.status !== 'completed') return undefined;
  if (row.tool === 'rows.page') {
    const call = pageCallSchema.safeParse(row.call);
    const output = z.object({ result: z.array(recordIdentity).max(100) }).safeParse(row.output);
    if (!call.success || !output.success) return undefined;
    return rowViewSchema.parse({
      callId: row.id,
      tableId: call.data.tableId,
      revision: call.data.revision,
      recordIds: output.data.result.map(record => record.id),
      query: { rsql: '', options: { version: 2, mode: 'rows', sort: [], limit: 100 } },
    });
  }
  if (row.tool === 'rows.get') {
    const call = getCallSchema.safeParse(row.call);
    const output = z.object({ result: recordIdentity.nullable() }).safeParse(row.output);
    if (!call.success || !output.success || (output.data.result && output.data.result.id !== call.data.recordId))
      return undefined;
    return rowViewSchema.parse({
      callId: row.id,
      tableId: call.data.tableId,
      revision: call.data.expectedAppliedRevision,
      recordIds: [call.data.recordId],
      query: { rsql: '', options: { version: 2, mode: 'rows', sort: [], limit: 1 } },
    });
  }
  if (row.tool !== 'rows.list') return undefined;
  const call = callSchema.safeParse(row.call);
  const output = outputSchema.safeParse(row.output);
  if (!call.success || !output.success) return undefined;
  return rowViewSchema.parse({
    callId: row.id,
    tableId: call.data.tableId,
    revision: call.data.expectedAppliedRevision,
    query: {
      rsql: output.data.result.rsql,
      options: { ...output.data.result.query, ...(call.data.query.after ? { after: call.data.query.after } : {}) },
    },
  });
}

export const rowChangeSchema = z.strictObject({
  callId: z.uuid(),
  tableId: z.uuid(),
  revision: rowViewSchema.shape.revision,
  kind: z.enum(['created', 'updated']),
  recordIds: z.array(z.uuid()).min(1).max(100),
});
export type RowChange = z.infer<typeof rowChangeSchema>;

const writeCallSchema = z.object({
  tool: z.enum(['rows.create', 'rows.create.batch', 'rows.update']),
  tableId: z.uuid(),
  expectedAppliedRevision: rowViewSchema.shape.revision,
});
const writtenRecord = z.object({ id: z.uuid() });
const writeOutputSchema = z.object({
  result: z.union([writtenRecord, z.object({ records: z.array(writtenRecord).min(1).max(100) })]),
});

/** Identifies the rows a completed write committed. Only IDs leave the receipt; the canvas rereads current values. */
export function rowChangeForReceipt(row: {
  id: string;
  tool: string;
  status: string;
  call?: unknown;
  output?: unknown;
}): RowChange | undefined {
  if (row.status !== 'completed') return undefined;
  const call = writeCallSchema.safeParse(row.call);
  const output = writeOutputSchema.safeParse(row.output);
  if (!call.success || call.data.tool !== row.tool || !output.success) return undefined;
  const result = output.data.result;
  return rowChangeSchema.parse({
    callId: row.id,
    tableId: call.data.tableId,
    revision: call.data.expectedAppliedRevision,
    kind: row.tool === 'rows.update' ? 'updated' : 'created',
    recordIds: 'records' in result ? result.records.map(record => record.id) : [result.id],
  });
}
