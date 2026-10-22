import { queryLimits } from '@tulipfarm/tables/query';
import type { TableApi, TableDefinition } from './api';
import { formatTableValue } from './definition-view';
import { linkedRefs, tableQueries } from './queries';
import { csvLine, viewRequest, type TableView } from './table-view';
import type { TableValues } from './review-contracts';

export const exportRowCap = 5000;
export type ExportResult = { rows: number; capped: boolean };

/** Exports every row matching the applied search and filters, in shown columns and sort order. Linked rows are written by name. */
export async function exportCsv(
  api: TableApi,
  table: TableDefinition,
  view: TableView,
  progress: (rows: number) => void,
  signal: AbortSignal,
): Promise<ExportResult> {
  const rows: TableValues[] = [];
  let after: string | undefined;
  let capped = false;
  const rowsView: TableView = { ...view, groupBy: [], metrics: [] };
  do {
    const base = viewRequest(rowsView, after);
    const request = 'rsql' in base ? { ...base, options: { ...base.options, limit: queryLimits.pageSize } } : base;
    const page = await api.query(table, request, signal);
    if (page.mode !== 'rows') throw new Error('This search can’t be exported. Fix it and try again.');
    rows.push(...page.records.map(record => record.values as unknown as TableValues));
    progress(Math.min(rows.length, exportRowCap));
    after = page.nextCursor ?? undefined;
    if (rows.length >= exportRowCap) {
      capped = !!after || rows.length > exportRowCap;
      break;
    }
  } while (after);
  const kept = rows.slice(0, exportRowCap);
  await downloadCsv(api, table, view, kept, signal);
  return { rows: kept.length, capped };
}

/** Selection is page-scoped (at most 100). Reread before export so deleted or unreadable rows are never exported from a cached page. */
export async function exportSelectedCsv(
  api: TableApi,
  table: TableDefinition,
  view: TableView,
  ids: readonly string[],
  signal: AbortSignal,
) {
  const records = await api.rowsById(table, ids, signal);
  const byId = new Map(records.map(record => [record.id, record.values]));
  if (ids.some(id => !byId.has(id)))
    throw new Error('Some selected rows are no longer available. Reload the table and select the rows again.');
  await downloadCsv(
    api,
    table,
    view,
    ids.map(id => byId.get(id)!),
    signal,
  );
  return ids.length;
}

async function downloadCsv(
  api: TableApi,
  table: TableDefinition,
  view: TableView,
  kept: TableValues[],
  signal: AbortSignal,
) {
  const columns = view.select
    ? table.definition.fields.filter(field => view.select!.includes(field.id))
    : table.definition.fields;
  const names = await tableQueries.linked(api, linkedRefs(kept)).load(signal);
  signal.throwIfAborted();
  const text = (values: TableValues, fieldId: string) => {
    const value = values[fieldId];
    if (value == null) return '';
    if (value.kind === 'relationship') return value.recordIds.map(id => names[id] ?? id).join(', ');
    return formatTableValue(value, table.definition, fieldId);
  };
  const lines = [
    csvLine(columns.map(field => field.label)),
    ...kept.map(values => csvLine(columns.map(field => text(values, field.id)))),
  ];
  const url = URL.createObjectURL(new Blob([`\uFEFF${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${table.definition.label.replace(/[^\w -]+/g, '').trim() || 'table'}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
