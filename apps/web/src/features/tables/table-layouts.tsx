import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Kanban } from 'reicon-react/icons/Kanban';
import type { TableQueryResult, TableQueryRequest } from '@tulipfarm/tables/query';
import { Board, type BoardColumn, type BoardItem } from '@tulipfarm/sprout/board';
import { Button } from '@tulipfarm/sprout/button';
import { RecordList, type RecordListValue } from '@tulipfarm/sprout/record-list';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import type { TableApi, TableDataRow, TableDefinition } from './api';
import { useLinkedRows, useTableQueryResult } from './hooks';
import {
  fileIdsOf,
  TableValueView,
  useFileNames,
  type FileNames,
  type LinkedLabels,
  type TableWorkspace,
} from './references';
import {
  boardColumnRequest,
  boardCountRequest,
  boardField,
  boardFields,
  columnWhere,
  optionTone,
  queryDefinition,
  type TableView,
} from './table-view';

type Fields = TableDefinition['definition']['fields'];
type Values = {
  linked: LinkedLabels;
  files: FileNames;
  workspace: TableWorkspace;
  definition: TableDefinition['definition'];
  systemKind?: TableDefinition['systemKind'];
};
type QueryRecord = Extract<TableQueryResult, { mode: 'rows' }>['records'][number];
const dataRow = (record: QueryRecord) =>
  ({ ...record, unavailableFileIds: record.unavailableFileIds ?? [] }) as unknown as TableDataRow;
const choice = (kind: string) => kind === 'single-select' || kind === 'multi-select';

/** A row's title is its first shown text field, so cards and list rows read like the table's own names. */
function parts(columns: Fields, skip?: string) {
  const title = columns.find(field => field.kind === 'text') ?? columns[0];
  const rest = columns.filter(field => field !== title && field.id !== skip);
  return { title, badges: rest.filter(field => choice(field.kind)), meta: rest.filter(field => !choice(field.kind)) };
}

const filled = (record: TableDataRow) => (field: Fields[number]) => record.values[field.id] != null;
const plain = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : undefined);
const titleText = (record: TableDataRow, title: Fields[number] | undefined) =>
  (title && plain(record.values[title.id])) || `Row ${record.id.slice(0, 8)}`;

function Value({ record, fieldId, values }: { record: TableDataRow; fieldId: string; values: Values }) {
  return (
    <TableValueView
      compact
      record={record}
      systemKind={values.systemKind}
      value={record.values[fieldId]}
      definition={values.definition}
      fieldId={fieldId}
      linked={values.linked}
      files={values.files}
      unavailableFileIds={record.unavailableFileIds}
      workspace={values.workspace}
    />
  );
}

/** Secondary values carry their field name, because a bare "No" or "3" means nothing out of its column. */
const labeled = (record: TableDataRow, fields: Fields, values: Values): RecordListValue[] =>
  fields.filter(filled(record)).map(field => ({
    label: field.label,
    value: <Value record={record} fieldId={field.id} values={values} />,
    text: plain(record.values[field.id]),
  }));

function Badges({ record, fields, values }: { record: TableDataRow; fields: Fields; values: Values }) {
  return fields
    .filter(filled(record))
    .map(field => <Value key={field.id} record={record} fieldId={field.id} values={values} />);
}

type ListRecord = TableDataRow & { title: string };

/** Stacked rows: title and up to four labelled values, with choice badges and row actions on the right. */
export function ListView({
  label,
  records,
  columns,
  values,
  actions,
  open,
}: {
  label: string;
  records: TableDataRow[];
  columns: Fields;
  values: Values;
  actions: (record: TableDataRow) => ReactNode;
  open?: ((record: TableDataRow) => void) | undefined;
}) {
  const { title, badges, meta } = parts(columns);
  const items: ListRecord[] = records.map(record => ({ ...record, title: titleText(record, title) }));
  return (
    <RecordList
      items={items}
      label={label}
      renderTitle={record =>
        title ? <Value record={record} fieldId={title.id} values={values} /> : `Row ${record.id.slice(0, 8)}`
      }
      values={record => labeled(record, meta, values)}
      badges={record => <Badges record={record} fields={badges} values={values} />}
      renderActions={actions}
      onItemOpen={open}
    />
  );
}

type BoardProps = {
  api: TableApi;
  table: TableDefinition;
  view: TableView;
  columns: Fields;
  fieldId: string | undefined;
  changeField: (fieldId: string) => void;
  openColumn: (where: string) => void;
  workspace: TableWorkspace;
  menu?: ((record: TableDataRow) => ReactNode) | undefined;
  open?: ((record: TableDataRow) => void) | undefined;
};
type Lane = { key: string; id: string | null; label: string };
type LaneRead = { state: ReturnType<typeof useTableQueryResult>['state']; refresh: () => void };
type Card = BoardItem & { record: TableDataRow };

const none = '\u0000none';

/** Read states are rebuilt every render, so compare what they hold rather than the object. */
function sameState(a: LaneRead['state'] | undefined, b: LaneRead['state']) {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === 'ready' && b.kind === 'ready')
    return a.data === b.data && a.refreshing === b.refreshing && a.error === b.error;
  if (a.kind === 'error' && b.kind === 'error') return a.message === b.message && a.busy === b.busy;
  if (a.kind === 'unavailable' && b.kind === 'unavailable') return a.status === b.status;
  return true;
}

/** Loads one column on its own, so a slow or failed column never holds back the others. */
function LaneLoader({
  api,
  table,
  request,
  lane,
  report,
}: {
  api: TableApi;
  table: TableDefinition;
  request: TableQueryRequest;
  lane: string;
  report: (lane: string, read: LaneRead) => void;
}) {
  const read = useTableQueryResult(api, table, request);
  const refresh = useRef(read.refresh);
  refresh.current = read.refresh;
  useEffect(
    () => report(lane, { state: read.state, refresh: () => void refresh.current() }),
    [lane, read.state, report],
  );
  return null;
}

/** One column per option of a single-select field, plus rows with no value. Columns load separately and show their first 20 rows. */
export function BoardView({
  api,
  table,
  view,
  columns,
  fieldId,
  changeField,
  openColumn,
  workspace,
  menu,
  open,
}: BoardProps) {
  const definition = queryDefinition(table.definition);
  const field = boardField(definition, fieldId);
  const counts = useTableQueryResult(api, table, boardCountRequest(view, field?.id ?? ''), !!field);
  const [reads, setReads] = useState<Record<string, LaneRead>>({});
  const report = useCallback(
    (lane: string, read: LaneRead) =>
      setReads(current => (sameState(current[lane]?.state, read.state) ? current : { ...current, [lane]: read })),
    [],
  );
  const singleSelect = field?.kind === 'single-select' ? field : null;
  const data = counts.state.kind === 'ready' && counts.state.data.mode === 'summary' ? counts.state.data : null;
  const count = (optionId: string | null) =>
    data
      ? data.groups
          .filter(group => (group.keys[0] ?? null) === optionId)
          .reduce((sum, group) => sum + Number(group.values[0] ?? 0), 0)
      : null;
  const lanes: Lane[] = singleSelect
    ? [
        ...singleSelect.options
          .filter(option => !option.retired || (count(option.id) ?? 0) > 0)
          .map(option => ({
            key: `${singleSelect.id}:${option.id}`,
            id: option.id as string | null,
            label: option.label,
          })),
        { key: `${singleSelect.id}:${none}`, id: null, label: `No ${singleSelect.label.toLowerCase()}` },
      ]
    : [];
  const ready = (lane: Lane) => {
    const state = reads[lane.key]?.state;
    return state?.kind === 'ready' && state.data.mode === 'rows' ? state.data.records.map(dataRow) : [];
  };
  const records = lanes.flatMap(ready);
  const linked = useLinkedRows(
    api,
    records.map(record => record.values),
  );
  const files = useFileNames(
    workspace.id,
    fileIdsOf(records.map(record => record.values)),
    records.flatMap(record => record.unavailableFileIds),
  );
  if (!singleSelect)
    return (
      <StatePanel
        kind="empty"
        heading="h3"
        icon={Kanban}
        title="Board needs a choice field"
        description={`Boards group rows by a single-choice field, such as Status. ${table.definition.label} has none yet. Add one in chat, or use Table or List.`}
      />
    );
  const values: Values = {
    linked: linked.state,
    files: files.state,
    workspace,
    definition: table.definition,
    systemKind: table.systemKind,
  };
  const { title, badges, meta } = parts(columns, singleSelect.id);
  const boardColumns: BoardColumn[] = lanes.map(lane => {
    const state = reads[lane.key]?.state ?? { kind: 'loading' };
    const total = count(lane.id);
    const status =
      state.kind === 'loading'
        ? ('loading' as const)
        : state.kind === 'unavailable'
          ? ('unavailable' as const)
          : state.kind === 'error' || state.data.mode !== 'rows'
            ? ('error' as const)
            : undefined;
    return {
      id: lane.key,
      title: lane.label,
      tone: lane.id ? optionTone(lane.label) : 'ghost',
      ...(total !== null && { total }),
      ...(status && {
        status,
        error: status === 'unavailable' ? 'Rows are unavailable.' : 'Couldn’t load this column.',
      }),
    };
  });
  const items: Card[] = lanes.flatMap(lane =>
    ready(lane).map(record => ({ id: record.id, columnId: lane.key, title: titleText(record, title), record })),
  );
  const laneOf = (column: BoardColumn) => lanes.find(lane => lane.key === column.id);
  return (
    <div className="space-y-3">
      {lanes.map(lane => (
        <LaneLoader
          key={lane.key}
          api={api}
          table={table}
          request={boardColumnRequest(definition, view, singleSelect.id, lane.id)}
          lane={lane.key}
          report={report}
        />
      ))}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Columns by</span>
        <Select
          value={singleSelect.id}
          onValueChange={value => {
            if (value) changeField(value);
          }}
        >
          <SelectTrigger size="sm" aria-label="Board columns by">
            <SelectValue>{singleSelect.label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {boardFields(definition).map(item => (
              <SelectItem key={item.id} value={item.id}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {counts.state.kind === 'error' && (
          <>
            <span role="alert" className="text-destructive">
              Couldn’t load column counts.
            </span>
            <Button variant="link" size="sm" onClick={() => void counts.refresh()}>
              Retry
            </Button>
          </>
        )}
      </div>
      <Board
        label={`Board by ${singleSelect.label}`}
        columns={boardColumns}
        items={items}
        columnText={{ empty: 'No rows', showAll: total => `Show all ${total.toLocaleString('en-US')} in table` }}
        onColumnRetry={column => reads[column.id]?.refresh()}
        onColumnShowAll={column => {
          const lane = laneOf(column);
          if (lane) openColumn(columnWhere(definition, view.where, singleSelect.id, lane.id));
        }}
        renderTitle={({ record }) =>
          title ? <Value record={record} fieldId={title.id} values={values} /> : `Row ${record.id.slice(0, 8)}`
        }
        renderBody={({ record }) => {
          const shown = labeled(record, meta, values).slice(0, 2);
          const chips = badges.filter(filled(record)).slice(0, 2);
          return (
            <>
              {shown.length > 0 && (
                <span className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                  {shown.map(item => (
                    <span key={item.label} className="flex min-w-0 items-center gap-1">
                      <span className="shrink-0">{item.label}</span>
                      <span className="min-w-0 text-foreground">{item.value}</span>
                    </span>
                  ))}
                </span>
              )}
              {chips.length > 0 && (
                <span className="flex flex-wrap gap-1 pt-1">
                  <Badges record={record} fields={chips} values={values} />
                </span>
              )}
            </>
          );
        }}
        itemActions={menu && (({ record }) => menu(record))}
        onItemOpen={open && (({ record }) => open(record))}
      />
    </div>
  );
}
