import { z } from 'zod';
import { AccessDenied, canAccessTable, type AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import type { TableField } from '@tulipfarm/tables/definition';
import { activeGeneration, fieldColumn, GenerationError, readRecord, type Generation } from '@tulipfarm/tables/store';
import { idSchema, payloadSchema, recordOffset, type RecordFilter, type Trigger } from './contracts.ts';
import { WorkflowConflict } from './commands.ts';

export type RecordTrigger = Extract<Trigger, { kind: 'record' }>;
/** A trigger that reads one table's rows. */
export type TableTrigger = Extract<Trigger, { kind: 'record' | 'row' }>;
/** The common migration that adds occurrence storage; workspaces below it cannot hold record triggers until the rollout reaches them. */
export const recordTriggerCommonVersion = 1;
const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
export const utcInstant = (expression: string) =>
  `to_char(${expression} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
// Edits saved after the sweep last read the table still fire late within this window; older first sightings are history, not reminders.
export const lateness = '1 hour';
export const sweepInterval = '1 minute';
// Run limits or an outage can hold occurrences back; past this they are reported as missed instead of running days late.
const catchUp = '24 hours';
const occurrenceSchema = z.object({ recordId: idSchema, dueAt: z.iso.datetime() });
const missedSchema = z.object({
  scheduledFor: z.iso.datetime(),
  missedThrough: z.iso.datetime(),
  missedCount: z.number().int().positive(),
});

/** Record runs carry record values, so every member who starts, sees, or sponsors them must be able to read the table. */
export async function canReadRecords(tx: AuthorizationTransaction, membershipId: string, tableId: string) {
  const member = (
    await tx.client.query(`SELECT user_id FROM ${table(tx, 'tf_memberships')} WHERE id=$1 AND removed_at IS NULL`, [
      idSchema.parse(membershipId),
    ])
  ).rows[0];
  if (!member) return false;
  try {
    return await canAccessTable(
      tx,
      { kind: 'human', userId: z.string().parse(member.user_id), membershipId },
      tableId,
      'table.row.read',
    );
  } catch (error) {
    if (error instanceof AccessDenied) return false;
    throw error;
  }
}

export async function requireRecordReader(tx: AuthorizationTransaction, membershipId: string, trigger: TableTrigger) {
  if (!(await canReadRecords(tx, membershipId, trigger.tableId))) throw new AccessDenied();
}

/** A caller may lack the table outright, but naming a sponsor or audience member who cannot read it is a fixable choice. */
export async function requireRecordAudience(
  tx: AuthorizationTransaction,
  trigger: TableTrigger,
  membershipIds: string[],
) {
  for (const membershipId of membershipIds)
    if (!(await canReadRecords(tx, membershipId, trigger.tableId))) throw new WorkflowConflict('record-source-denied');
}

/** Postgres computes local due times, so the zone must be one it knows, not only one the API host's Intl knows. */
export async function requireRecordZone(tx: AuthorizationTransaction, trigger: RecordTrigger) {
  if (
    trigger.field.kind === 'date' &&
    !(await tx.client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1', [trigger.field.timezone])).rowCount
  )
    throw new WorkflowConflict('invalid-schedule');
}

export function filterApplies(generation: Generation, filter: RecordFilter) {
  const field = generation.definition.fields.find(item => item.id === filter.fieldId);
  if (!field) return false;
  if (!('value' in filter)) return true;
  if (field.kind !== filter.value.kind) return false;
  const { value } = filter;
  // Records cannot hold a retired option, so a filter on one would silently match nothing or everything.
  return (
    value.kind !== 'single-select' ||
    (field.kind === 'single-select' && field.options.some(option => option.id === value.optionId && !option.retired))
  );
}

/** The filter as a reader sees it: field label, match, and the value's display text, or null for an empty check. */
export function recordFilterLabels(fields: Generation['definition']['fields'], filter: RecordFilter) {
  const field = fields.find(item => item.id === filter.fieldId);
  if (!field) throw new WorkflowConflict('record-field-unavailable');
  if (!('value' in filter)) return { field: field.label, match: filter.match, value: null };
  const { value } = filter;
  const shown =
    value.kind === 'boolean'
      ? value.value
        ? 'Yes'
        : 'No'
      : value.kind === 'single-select'
        ? field.kind === 'single-select'
          ? field.options.find(option => option.id === value.optionId)?.label
          : undefined
        : value.value;
  if (shown === undefined) throw new WorkflowConflict('record-field-unavailable');
  return { field: field.label, match: filter.match, value: shown };
}

/** The table's active generation, once the member may read it and the fields the trigger reads still have the kinds it expects. */
export async function recordSource(
  tx: AuthorizationTransaction,
  trigger: RecordTrigger,
  membershipId: string,
): Promise<Generation> {
  const generation = await readableGeneration(tx, trigger, membershipId);
  if (generation.definition.fields.find(field => field.id === trigger.field.fieldId)?.kind !== trigger.field.kind)
    throw new WorkflowConflict('record-field-unavailable');
  if (trigger.filter && !filterApplies(generation, trigger.filter))
    throw new WorkflowConflict('record-field-unavailable');
  return generation;
}

export async function readableGeneration(tx: AuthorizationTransaction, trigger: TableTrigger, membershipId: string) {
  await requireRecordReader(tx, membershipId, trigger);
  try {
    return await activeGeneration(tx, trigger.tableId);
  } catch (error) {
    if (error instanceof GenerationError) throw new WorkflowConflict('record-field-unavailable');
    throw error;
  }
}

/** SQL for one field's value: typed for comparison, and a test for no value. */
export type FilterOperand = { value: string; empty: string };
const operandCast: Partial<Record<TableField['kind'], string>> = {
  text: 'text',
  numeric: 'numeric',
  boolean: 'boolean',
  date: 'date',
  timestamp: 'timestamptz',
  'single-select': 'uuid',
};
const listKey: Partial<Record<TableField['kind'], string>> = {
  'multi-select': 'optionIds',
  relationship: 'recordIds',
  file: 'fileIds',
};
const listed = (field: TableField) =>
  field.kind === 'multi-select' ||
  ((field.kind === 'relationship' || field.kind === 'file') && field.cardinality === 'many');

export function columnOperand(field: TableField): FilterOperand {
  const column = `p.${fieldColumn(field.id)}`;
  return { value: column, empty: listed(field) ? `COALESCE(cardinality(${column}),0)=0` : `${column} IS NULL` };
}

/** Reads a field from a stored values object. A value of another kind, written before the field changed, reads as no value. */
export function jsonOperand(values: string, field: TableField): FilterOperand {
  const value = `${values}->'${idSchema.parse(field.id)}'`,
    list = listKey[field.kind],
    cast = operandCast[field.kind];
  return {
    value: cast
      ? `CASE WHEN ${value}->>'kind'='${field.kind}' THEN (${value}->>${field.kind === 'single-select' ? `'optionId'` : `'value'`})::${cast} END`
      : 'NULL',
    empty: list
      ? `COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(${value}->'${list}')='array' THEN ${value}->'${list}' END),0)=0`
      : `${value}->>'kind' IS NULL`,
  };
}

const comparison = { is: '=', 'is-not': 'IS DISTINCT FROM', lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;
// "Is not" keeps records with no value, so a status filter of "is not closed" still reaches records without a status.
export function filterPredicate(
  filter: RecordFilter | undefined,
  operand: (field: string) => FilterOperand,
  parameter: number,
) {
  if (!filter) return { sql: '', parameters: [] };
  const { value, empty } = operand(filter.fieldId);
  if (!('value' in filter))
    return { sql: ` AND ${filter.match === 'is-empty' ? '' : 'NOT '}(${empty})`, parameters: [] };
  const cast = filter.value.kind === 'single-select' ? 'uuid' : operandCast[filter.value.kind];
  return {
    sql: ` AND ${value} ${comparison[filter.match]} $${parameter}::${cast}`,
    parameters: [filter.value.kind === 'single-select' ? filter.value.optionId : filter.value.value],
  };
}

export function fieldOperand(generation: Generation, toOperand: (field: TableField) => FilterOperand) {
  return (fieldId: string) => {
    const field = generation.definition.fields.find(item => item.id === fieldId);
    if (!field) throw new WorkflowConflict('record-field-unavailable');
    return toOperand(field);
  };
}

/**
 * Converges the unfired occurrences on the table's current values. Deleted records, changed fields, and other
 * revisions lose their unfired occurrences. Fired occurrences stay, so a restored record or a reverted date never refires.
 * `sweepDue` is the time this sweep fell due. The previous sweep read the table no earlier than a sweep interval before it,
 * so lateness counts from then: a sweep held back by run limits or an outage still fires what fell due in the meantime.
 */
export async function reconcileRecordOccurrences(
  tx: AuthorizationTransaction,
  workflowId: string,
  revision: string,
  trigger: RecordTrigger,
  generation: Generation,
  sweepDue: string,
) {
  const value = `p.${fieldColumn(trigger.field.fieldId)}`,
    offset = recordOffset(trigger.field);
  const [dueAt, parameters] =
    trigger.field.kind === 'date'
      ? [
          `((${value} + $4::integer)::timestamp + $5::time) AT TIME ZONE $6::text`,
          [offset.days, trigger.field.time, trigger.field.timezone],
        ]
      : [`${value} + make_interval(secs => $4::integer)`, [offset.seconds]];
  const filter = filterPredicate(trigger.filter, fieldOperand(generation, columnOperand), 4 + parameters.length);
  const lastRead = `LEAST(clock_timestamp(), $${4 + parameters.length + filter.parameters.length}::timestamptz - interval '${sweepInterval}')`;
  const occurrences = table(tx, 'tf_workflow_record_occurrences');
  await tx.client.query(
    `WITH desired AS (
      SELECT p.id AS record_id, ${dueAt} AS due_at FROM ${table(tx, generation.physical_table)} p
      JOIN ${table(tx, 'tf_table_identities')} i ON i.table_id=$3 AND i.row_id=p.id AND i.live WHERE ${value} IS NOT NULL${filter.sql}
    ), stale AS (
      DELETE FROM ${occurrences} o WHERE o.workflow_id=$1 AND o.fired_at IS NULL AND (o.revision<>$2 OR NOT EXISTS (SELECT 1 FROM desired d WHERE d.record_id=o.record_id AND d.due_at=o.due_at))
    )
    INSERT INTO ${occurrences} (workflow_id,revision,record_id,due_at)
    SELECT $1,$2,d.record_id,d.due_at FROM desired d
    WHERE d.due_at < '10000-01-01T00:00:00Z' AND d.due_at > GREATEST((SELECT activated_at FROM ${table(tx, 'tf_workflows')} WHERE id=$1), ${lastRead} - interval '${lateness}')
    ON CONFLICT DO NOTHING`,
    [
      idSchema.parse(workflowId),
      idSchema.parse(revision),
      trigger.tableId,
      ...parameters,
      ...filter.parameters,
      z.iso.datetime().parse(sweepDue),
    ],
  );
}

/** Settles unfired occurrences more than a day overdue without running them, and returns their span for one missed-run record. */
export async function settleMissedRecordOccurrences(
  tx: AuthorizationTransaction,
  workflowId: string,
  revision: string,
  now: Date,
) {
  const row = (
    await tx.client.query(
      `WITH missed AS (
      UPDATE ${table(tx, 'tf_workflow_record_occurrences')} SET fired_at=clock_timestamp() WHERE workflow_id=$1 AND revision=$2 AND fired_at IS NULL AND due_at<$3::timestamptz - interval '${catchUp}' RETURNING due_at
    ) SELECT ${utcInstant('min(due_at)')} AS "scheduledFor",${utcInstant('max(due_at)')} AS "missedThrough",count(*)::integer AS "missedCount" FROM missed`,
      [workflowId, revision, now.toISOString()],
    )
  ).rows[0];
  return row.missedCount ? missedSchema.parse(row) : null;
}

export async function dueRecordOccurrences(
  tx: AuthorizationTransaction,
  workflowId: string,
  revision: string,
  now: Date,
) {
  return occurrenceSchema
    .array()
    .parse(
      (
        await tx.client.query(
          `SELECT record_id AS "recordId",${utcInstant('due_at')} AS "dueAt" FROM ${table(tx, 'tf_workflow_record_occurrences')} WHERE workflow_id=$1 AND revision=$2 AND fired_at IS NULL AND due_at<=$3::timestamptz ORDER BY due_at,record_id LIMIT 20`,
          [workflowId, revision, now.toISOString()],
        )
      ).rows,
    );
}

export async function upcomingRecordOccurrences(
  tx: AuthorizationTransaction,
  workflowId: string,
  revision: string,
  limit: number,
) {
  return occurrenceSchema
    .array()
    .parse(
      (
        await tx.client.query(
          `SELECT record_id AS "recordId",${utcInstant('due_at')} AS "dueAt" FROM ${table(tx, 'tf_workflow_record_occurrences')} WHERE workflow_id=$1 AND revision=$2 AND fired_at IS NULL AND due_at>=clock_timestamp() - interval '${catchUp}' ORDER BY due_at,record_id LIMIT $3`,
          [workflowId, revision, limit],
        )
      ).rows,
    );
}

export async function markRecordOccurrenceFired(
  tx: AuthorizationTransaction,
  workflowId: string,
  revision: string,
  occurrence: z.infer<typeof occurrenceSchema>,
) {
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_workflow_record_occurrences')} SET fired_at=clock_timestamp() WHERE workflow_id=$1 AND revision=$2 AND record_id=$3 AND due_at=$4::timestamptz`,
    [workflowId, revision, occurrence.recordId, occurrence.dueAt],
  );
}

/** The sweep returns at the earliest unfired occurrence, and at least every minute to pick up record edits. It never schedules before this sweep, which is when it last read the table. */
export async function nextRecordSweep(tx: AuthorizationTransaction, workflowId: string, revision: string, now: Date) {
  const row = (
    await tx.client.query(
      `SELECT ${utcInstant(`GREATEST($3::timestamptz, LEAST(min(due_at), $3::timestamptz + interval '${sweepInterval}'))`)} AS next FROM ${table(tx, 'tf_workflow_record_occurrences')} WHERE workflow_id=$1 AND revision=$2 AND fired_at IS NULL`,
      [workflowId, revision, now.toISOString()],
    )
  ).rows[0];
  return z.iso.datetime().parse(row.next);
}

/**
 * Run input: the record's identity and row token, the occurrence it fired for, and its values, narrowed to the trigger and filter fields
 * when all values exceed the payload limit. When even those exceed it, the occurrence is too large to run and keeps only its identity.
 */
export async function recordRunInput(
  tx: AuthorizationTransaction,
  generation: Generation,
  trigger: RecordTrigger,
  occurrence: z.infer<typeof occurrenceSchema>,
) {
  const record = await readRecord(tx, generation, occurrence.recordId);
  if (!record) return null;
  const identity = {
    tableId: trigger.tableId,
    recordId: occurrence.recordId,
    token: record.token,
    scheduledFor: occurrence.dueAt,
  };
  const narrowed = Object.fromEntries(
    Object.entries(record.values).filter(
      ([fieldId]) => fieldId === trigger.field.fieldId || fieldId === trigger.filter?.fieldId,
    ),
  );
  for (const candidate of [
    { ...identity, values: record.values },
    { ...identity, values: narrowed, valuesTruncated: true },
  ]) {
    const parsed = payloadSchema.safeParse(candidate);
    if (parsed.success) return { kind: 'run' as const, input: parsed.data };
  }
  return { kind: 'too-large' as const, input: payloadSchema.parse(identity) };
}
