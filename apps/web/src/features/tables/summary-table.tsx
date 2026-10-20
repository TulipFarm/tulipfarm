import { Table, type TableColumn } from '@tulipfarm/sprout/table';
import type { QueryMetric } from '@tulipfarm/tables/query';
import { workspaceMemberFields } from '@tulipfarm/tables/workspace-members';
import type { TableDefinition } from './api';
import { MemberPhoto } from './member-profile';
import { metricLabels } from './table-view';

type Definition = TableDefinition['definition'];
type Group = { keys: (string | null)[]; values: (string | null)[] };

/** Group keys arrive as text. Options show their labels and empty values read as "Empty" rather than blank cells. */
export function groupKeyLabel(definition: Definition, fieldId: string, key: string | null) {
  if (key === null) return 'Empty';
  const field = definition.fields.find(item => item.id === fieldId);
  if (field?.kind === 'boolean') return key === 'true' ? 'Yes' : 'No';
  if (field?.kind === 'single-select')
    return field.options.find(option => option.id === key)?.label ?? 'Unknown option';
  return key;
}

export function metricHeader(definition: Definition, metric: QueryMetric) {
  if (metric.fn === 'count') return 'Rows';
  return `${metricLabels[metric.fn]} of ${definition.fields.find(field => field.id === metric.fieldId)?.label ?? 'field'}`;
}

const formatted = (value: string | null) => {
  if (value === null) return '—';
  const number = Number(value);
  return /^-?\d+(\.\d+)?$/.test(value) && Number.isFinite(number)
    ? number.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : value;
};

type SummaryRow = Record<string, string | null> & { id: string };

export function SummaryTable({
  definition,
  systemKind,
  workspaceId,
  groupBy,
  metrics,
  groups,
}: {
  definition: Definition;
  systemKind?: TableDefinition['systemKind'];
  workspaceId: string;
  groupBy: string[];
  metrics: QueryMetric[];
  groups: Group[];
}) {
  const columns: TableColumn<SummaryRow>[] = [
    ...groupBy.map((id, at): TableColumn<SummaryRow> => ({
      key: `g${at}`,
      header: definition.fields.find(field => field.id === id)?.label ?? 'Field',
      cell: row => {
        const key = row[`g${at}`] ?? null;
        return systemKind === 'workspace-members' && id === workspaceMemberFields.photo && key !== null ? (
          <MemberPhoto workspaceId={workspaceId} value={{ kind: 'text', value: key }} />
        ) : (
          groupKeyLabel(definition, id, key)
        );
      },
    })),
    ...metrics.map((metric, at): TableColumn<SummaryRow> => ({
      key: `m${at}`,
      header: metricHeader(definition, metric),
      cell: row => <span className="tabular-nums">{formatted(row[`m${at}`] ?? null)}</span>,
    })),
  ];
  const data = groups.map((group, index): SummaryRow => ({
    id: String(index),
    ...Object.fromEntries(group.keys.map((key, at) => [`g${at}`, key])),
    ...Object.fromEntries(group.values.map((value, at) => [`m${at}`, value])),
  }));
  return <Table aria-label={`${definition.label} summary`} data={data} columns={columns} getRowId={row => row.id} />;
}
