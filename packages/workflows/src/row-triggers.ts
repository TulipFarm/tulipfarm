import { z } from 'zod';
import type { AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import type { Generation } from '@tulipfarm/tables/store';
import { idSchema, payloadSchema, rowEventBatchSize, type Trigger } from './contracts.ts';
import { WorkflowConflict } from './commands.ts';
import {
  fieldOperand,
  filterApplies,
  filterPredicate,
  jsonOperand,
  readableGeneration,
  utcInstant,
} from './record-triggers.ts';

export type RowTrigger = Extract<Trigger, { kind: 'row' }>;
export const rowTriggerCommonVersion = 1;
const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
const changeSchema = z.object({ historyId: idSchema, changedAt: z.iso.datetime() });
export type RowChange = z.infer<typeof changeSchema>;
const valuesSchema = z.record(z.string(), z.unknown());

export async function rowSource(
  tx: AuthorizationTransaction,
  trigger: RowTrigger,
  membershipId: string,
): Promise<Generation> {
  const generation = await readableGeneration(tx, trigger, membershipId);
  if (trigger.fieldIds?.some(id => !generation.definition.fields.some(field => field.id === id)))
    throw new WorkflowConflict('record-field-unavailable');
  if (trigger.filter && !filterApplies(generation, trigger.filter))
    throw new WorkflowConflict('record-field-unavailable');
  return generation;
}

/** Bound each read, not retention. Retried blockers rotate behind events not yet attempted. */
export async function dueRowChanges(tx: AuthorizationTransaction, workflowId: string, revision: string) {
  return changeSchema
    .array()
    .parse(
      (
        await tx.client.query(
          `SELECT history_id AS "historyId",${utcInstant('changed_at')} AS "changedAt" FROM ${table(tx, 'tf_workflow_row_events')} WHERE workflow_id=$1 AND revision=$2 AND settled_at IS NULL ORDER BY attempted_at NULLS FIRST,changed_at,history_id LIMIT $3`,
          [workflowId, revision, rowEventBatchSize],
        )
      ).rows,
    );
}

export async function settleRowChange(
  tx: AuthorizationTransaction,
  workflowId: string,
  revision: string,
  change: RowChange,
  state: 'admitted' | 'ignored',
  runId: string | null = null,
) {
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_workflow_row_events')} SET state=$4,reason=NULL,settled_at=clock_timestamp(),attempted_at=clock_timestamp(),run_id=$5,snapshot=NULL WHERE workflow_id=$1 AND revision=$2 AND history_id=$3 AND settled_at IS NULL`,
    [workflowId, revision, change.historyId, state, runId],
  );
}

export async function blockRowChange(
  tx: AuthorizationTransaction,
  workflowId: string,
  revision: string,
  change: RowChange,
  reason: 'capacity' | 'values-too-large' | 'values-unavailable',
) {
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_workflow_row_events')} SET state='blocked',reason=$4,attempted_at=CASE WHEN $4='capacity' THEN NULL ELSE clock_timestamp() END WHERE workflow_id=$1 AND revision=$2 AND history_id=$3 AND settled_at IS NULL`,
    [workflowId, revision, change.historyId, reason],
  );
}

/** The queue owns an immutable snapshot until admission; table history cleanup cannot erase it. */
export async function rowRunInput(
  tx: AuthorizationTransaction,
  workflowId: string,
  revision: string,
  generation: Generation,
  trigger: RowTrigger,
  change: RowChange,
) {
  const filter = filterPredicate(
    trigger.filter,
    fieldOperand(generation, field => jsonOperand(`snapshot->'values'`, field)),
    4,
  );
  const row = (
    await tx.client.query(
      `SELECT snapshot, (true${filter.sql}) IS TRUE AS matches FROM ${table(tx, 'tf_workflow_row_events')} WHERE workflow_id=$1 AND revision=$2 AND history_id=$3`,
      [workflowId, revision, change.historyId, ...filter.parameters],
    )
  ).rows[0];
  const entry = z
    .object({
      row_id: idSchema,
      token: z.uuid(),
      field_ids: z.array(z.string()),
      values: valuesSchema,
      before_values: valuesSchema.nullable(),
      file_fields: z.array(z.string()),
    })
    .safeParse(row?.snapshot);
  if (!entry.success || (trigger.event === 'updated' && entry.data.before_values === null))
    return { kind: 'blocked' as const, reason: 'values-unavailable' as const };
  if (!row.matches) return { kind: 'ignored' as const };
  const snapshot = entry.data;
  const files = new Set([
    ...snapshot.file_fields,
    ...generation.definition.fields.filter(field => field.kind === 'file').map(field => field.id),
  ]);
  const shown = (fieldId: string, value: unknown) =>
    !files.has(fieldId) && !(typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'file');
  const visible = (values: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(values).filter(([fieldId, value]) => shown(fieldId, value)));
  const updated = trigger.event === 'updated',
    previous = updated ? snapshot.before_values : null;
  const changedFieldIds = updated
    ? snapshot.field_ids
        .filter(fieldId => shown(fieldId, snapshot.values[fieldId]) && shown(fieldId, previous?.[fieldId]))
        .sort()
    : [];
  const candidate = {
    event: trigger.event,
    tableId: trigger.tableId,
    recordId: snapshot.row_id,
    ...(trigger.event === 'deleted' ? {} : { token: snapshot.token }),
    changedAt: change.changedAt,
    ...(updated ? { changedFieldIds } : {}),
    values: visible(snapshot.values),
    ...(previous ? { previousValues: visible(previous) } : {}),
  };
  const parsed = payloadSchema.safeParse(candidate);
  return parsed.success
    ? { kind: 'run' as const, input: parsed.data }
    : { kind: 'blocked' as const, reason: 'values-too-large' as const };
}
