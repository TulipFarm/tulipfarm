import { useMemo } from 'react';
import type { Definition, TableStep } from '@tulipfarm/workflows/contracts';
import { tableApi } from '@/features/tables/api';
import { useTablePicker } from '@/features/tables/hooks';
import { valueDescription } from './editor-controls';

const operators = {
  eq: 'is',
  ne: 'is not',
  lt: 'is less than',
  lte: 'is at most',
  gt: 'is greater than',
  gte: 'is at least',
  'is-null': 'is empty',
  'not-null': 'is not empty',
} as const;

/** Describes a table step with the table and field names the viewer can read, falling back to short IDs. */
export function TableStepSummary({
  workspaceId,
  step,
  steps,
}: {
  workspaceId: string;
  step: TableStep;
  steps: Definition['steps'];
}) {
  const api = useMemo(() => tableApi(workspaceId), [workspaceId]);
  const read = useTablePicker(api);
  const table = read.state.kind === 'ready' ? read.state.data.find(item => item.id === step.tableId) : undefined;
  const tableName = table ? `“${table.definition.label}”` : `table ${step.tableId.slice(0, 8)}`;
  const fieldName = (id: string) =>
    table?.definition.fields.find(field => field.id === id)?.label ?? `field ${id.slice(0, 8)}`;
  const earlier = steps.slice(
    0,
    steps.findIndex(item => item.id === step.id),
  );
  const lead =
    step.kind === 'find-rows'
      ? `Finds up to ${step.limit} rows in ${tableName}${step.filters.length ? ' where:' : '.'}`
      : step.kind === 'create-row'
        ? `Adds a row to ${tableName} with:`
        : `Updates the row from ${valueDescription(step.row, earlier)} in ${tableName} with:`;
  const lines =
    step.kind === 'find-rows'
      ? step.filters.map(
          filter =>
            `${fieldName(filter.fieldId)} ${operators[filter.op]}${'value' in filter ? ` ${valueDescription(filter.value, earlier)}` : ''}`,
        )
      : Object.entries(step.fields).map(
          ([fieldId, value]) => `${fieldName(fieldId)} from ${valueDescription(value, earlier)}`,
        );
  const names =
    read.state.kind === 'loading'
      ? 'Loading table names.'
      : read.state.kind === 'ready' && table
        ? null
        : read.state.kind === 'ready'
          ? 'You cannot read this table, so its name is hidden.'
          : 'Table names are unavailable, so short IDs are shown.';
  return (
    <div className="space-y-1">
      <p>{lead}</p>
      {lines.length > 0 && (
        <ul className="list-disc space-y-1 pl-5">
          {lines.map(line => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      <p className="text-sm text-muted-foreground">
        {names ? `${names} ` : ''}Runs act with the table access of the person who starts them, or the sponsor for
        unattended runs. Change table steps in the full definition.
      </p>
    </div>
  );
}
