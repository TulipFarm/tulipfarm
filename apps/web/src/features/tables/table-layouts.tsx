import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Calendar } from 'reicon-react/icons/Calendar';
import { ChartBar } from 'reicon-react/icons/ChartBar';
import { Kanban } from 'reicon-react/icons/Kanban';
import type { TableQueryResult, TableQueryRequest } from '@tulipfarm/tables/query';
import { Board, type BoardColumn, type BoardItem } from '@tulipfarm/sprout/board';
import { Button } from '@tulipfarm/sprout/button';
import { CategoryChart, chartPalette } from '@tulipfarm/sprout/chart';
import { TimelineChart } from '@tulipfarm/sprout/timeline';
import { RecordList, type RecordListValue } from '@tulipfarm/sprout/record-list';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import type { TableApi, TableDataRow, TableDefinition } from './api';
import { TableRead } from './feedback';
import { RecordMutationFeedback, useRecordMutation } from './record-mutation';
import { workspaceMemberFields } from '@tulipfarm/tables/workspace-members';
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
  optionFiltered,
  toggleOptionWhere,
  optionTone,
  queryDefinition,
  timelineFields,
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
  /** Lets cards drag between columns, saving the new choice to the row. */
  canMove?: boolean | undefined;
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
  canMove,
}: BoardProps) {
  const definition = queryDefinition(table.definition);
  const move = useRecordMutation(api, () => {});
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
  // Workspace access changes through invitations and removals, never by editing the row.
  const managed = table.systemKind === 'workspace-members' && singleSelect.id === workspaceMemberFields.access;
  const movable = !!canMove && !managed && !move.locked;
  // While a move saves, the card waits in its new column instead of jumping back.
  const pending = move.state.kind === 'sending' && move.state.input.kind === 'update' ? move.state.input : null;
  const laneKeyOf = (optionId: string | null) => `${singleSelect.id}:${optionId ?? none}`;
  const items: Card[] = lanes.flatMap(lane =>
    ready(lane).map(record => {
      const next = pending?.recordId === record.id ? pending.values[singleSelect.id] : undefined;
      return {
        id: record.id,
        columnId: next === undefined ? lane.key : laneKeyOf(next?.kind === 'single-select' ? next.optionId : null),
        title: titleText(record, title),
        record,
      };
    }),
  );
  const moveCard = (next: Card[]) => {
    const card = next.find(item => items.some(old => old.id === item.id && old.columnId !== item.columnId));
    const lane = card && lanes.find(item => item.key === card.columnId);
    if (!card || !lane) return;
    void move.submit({
      kind: 'update',
      requestId: crypto.randomUUID(),
      tableId: table.id,
      revision: table.revision,
      recordId: card.record.id,
      expectedToken: card.record.token,
      values: { [singleSelect.id]: lane.id ? { kind: 'single-select', optionId: lane.id } : null },
    });
  };
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
        {canMove && managed && (
          <span className="text-muted-foreground">Access changes through invitations, so cards stay in place.</span>
        )}
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
      {move.state.kind !== 'sending' && <RecordMutationFeedback mutation={move} refresh={async () => move.check()} />}
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
                <span className="table w-full text-xs text-muted-foreground">
                  {shown.map(item => (
                    <span key={item.label} className="table-row">
                      <span className="table-cell w-px pr-3 py-0.5 align-middle whitespace-nowrap">{item.label}</span>
                      <span className="table-cell w-full max-w-0 py-0.5 align-middle text-foreground">
                        {item.value}
                      </span>
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
        onItemsChange={movable ? moveCard : undefined}
      />
    </div>
  );
}

/** A small field picker shared by Chart and Timeline, styled like the board's "Columns by". */
function FieldPicker({
  label,
  value,
  fields,
  change,
  none,
}: {
  label: string;
  value: Fields[number] | undefined;
  fields: { id: string; label: string }[];
  change: (fieldId: string) => void;
  none?: string;
}) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-muted-foreground">{label}</span>
      <Select
        value={value?.id ?? none ?? ''}
        onValueChange={next => {
          if (next) change(next);
        }}
      >
        <SelectTrigger size="sm" aria-label={label}>
          <SelectValue>{value?.label ?? none}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {none && <SelectItem value={none}>{none}</SelectItem>}
          {fields.map(item => (
            <SelectItem key={item.id} value={item.id}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </span>
  );
}

/** Row counts for each option of a single-select field, across every row that matches the search. */
export function ChartView({
  api,
  table,
  view,
  noun,
  fieldId,
  changeField,
  filter,
}: {
  api: TableApi;
  table: TableDefinition;
  view: TableView;
  noun: string;
  fieldId: string | undefined;
  changeField: (fieldId: string) => void;
  /** Applies a filter while staying on the chart. */
  filter: (where: string) => void;
}) {
  const definition = queryDefinition(table.definition);
  const field = boardField(definition, fieldId);
  const singleSelect = field?.kind === 'single-select' ? field : null;
  const counts = useTableQueryResult(api, table, boardCountRequest(view, singleSelect?.id ?? ''), !!singleSelect);
  if (!singleSelect)
    return (
      <StatePanel
        kind="empty"
        heading="h3"
        icon={ChartBar}
        title="Chart needs a choice field"
        description={`Charts count rows for each option of a single-choice field, such as Status. ${table.definition.label} has none yet. Add one in chat, or use Table or List.`}
      />
    );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <FieldPicker label="Bars by" value={singleSelect} fields={boardFields(definition)} change={changeField} />
      </div>
      <TableRead state={counts.state} refresh={counts.refresh}>
        {data => {
          if (data.mode !== 'summary') return null;
          const count = (optionId: string | null) =>
            data.groups
              .filter(group => (group.keys[0] ?? null) === optionId)
              .reduce((sum, group) => sum + Number(group.values[0] ?? 0), 0);
          const bars = [
            ...singleSelect.options
              .filter(option => !option.retired || count(option.id) > 0)
              .map(option => ({ id: option.id as string | null, label: option.label, count: count(option.id) })),
            { id: null, label: `No ${singleSelect.label.toLowerCase()}`, count: count(null) },
          ].filter(bar => bar.id !== null || bar.count > 0);
          const title = `${noun[0]!.toUpperCase()}${noun.slice(1)} by ${singleSelect.label}`;
          return (
            <div className="space-y-4 rounded-lg border border-border p-4">
              <CategoryChart
                title={title}
                horizontal
                // The axis draws four intervals, so a multiple of four keeps every tick a whole count.
                max={Math.max(4, Math.ceil(Math.max(...bars.map(bar => bar.count)) / 4) * 4)}
                rows={bars.map(bar => ({ label: bar.label, count: bar.count }))}
                category="label"
                series={[{ key: 'count', label: noun[0]!.toUpperCase() + noun.slice(1), color: chartPalette[0]! }]}
              />
              <ul aria-label={title} className="flex flex-wrap gap-2">
                {bars.map(bar => (
                  <li key={bar.id ?? none}>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-pressed={optionFiltered(definition, view.where, singleSelect.id, bar.id)}
                      onClick={() => filter(toggleOptionWhere(definition, view.where, singleSelect.id, bar.id))}
                    >
                      {bar.label}
                      <span className="tabular-nums text-muted-foreground">{bar.count.toLocaleString('en-US')}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          );
        }}
      </TableRead>
    </div>
  );
}

const dateOf = (record: TableDataRow, field: Fields[number] | undefined) => {
  const value = field && (record.values[field.id] as { kind?: string; value?: unknown } | null | undefined);
  if (!value || typeof value.value !== 'string') return null;
  return value.kind === 'timestamp' ? Date.parse(value.value) : value.value;
};

const noEnd = 'No end date';

/** The loaded rows on a time axis by a date field, with an optional end field for spans. */
export function TimelineView({
  label,
  table,
  records,
  columns,
  values,
  actions,
  open,
  startId,
  endId,
  change,
}: {
  label: string;
  table: TableDefinition;
  records: TableDataRow[];
  columns: Fields;
  values: Values;
  actions: (record: TableDataRow) => ReactNode;
  open?: ((record: TableDataRow) => void) | undefined;
  startId: string | undefined;
  endId: string | undefined;
  change: (next: { start?: string; end?: string | undefined }) => void;
}) {
  const dates = timelineFields(queryDefinition(table.definition)) as Fields;
  const start = dates.find(field => field.id === startId) ?? dates[0];
  const end = dates.find(field => field.id === endId && field !== start);
  if (!start)
    return (
      <StatePanel
        kind="empty"
        heading="h3"
        icon={Calendar}
        title="Timeline needs a date field"
        description={`Timelines place rows on a date, such as a start or due date. ${table.definition.label} has none yet. Add one in chat, or use Table or List.`}
      />
    );
  const { title } = parts(columns);
  const byId = new Map(records.map(record => [record.id, record]));
  const rows = records.map(record => ({
    id: record.id,
    name: titleText(record, title),
    start: dateOf(record, start),
    end: dateOf(record, end),
  }));
  const undated = rows.filter(row => row.start === null).length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <FieldPicker label="Starts" value={start} fields={dates} change={id => change({ start: id })} />
        <FieldPicker
          label="Ends"
          value={end}
          none={noEnd}
          fields={dates.filter(field => field !== start)}
          change={id => change({ end: id === noEnd ? undefined : id })}
        />
      </div>
      <TimelineChart
        title={label}
        rows={rows}
        category="name"
        start="start"
        end={end ? 'end' : undefined}
        rowKey="id"
        renderLabel={row => {
          const record = byId.get(String(row.id));
          return record && title ? <Value record={record} fieldId={title.id} values={values} /> : row.name;
        }}
        renderActions={row => {
          const record = byId.get(String(row.id));
          return record ? actions(record) : null;
        }}
        onRowOpen={
          open &&
          (row => {
            const record = byId.get(String(row.id));
            if (record) open(record);
          })
        }
        undated={undated > 0 ? { count: undated, field: start.label } : undefined}
      />
    </div>
  );
}
