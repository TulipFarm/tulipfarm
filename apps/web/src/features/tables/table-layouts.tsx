import type { ReactNode } from 'react';
import { Kanban } from 'reicon-react/icons/Kanban';
import type { TableQueryResult } from '@tulipfarm/tables/query';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/item';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Spinner } from '@tulipfarm/sprout/spinner';
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

/** Secondary values carry their field name, because a bare "No" or "3" means nothing out of its column. */
function Labeled({ record, field, values }: { record: TableDataRow; field: Fields[number]; values: Values }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="shrink-0">{field.label}</span>
      <span className="min-w-0 text-foreground">
        <Value record={record} fieldId={field.id} values={values} />
      </span>
    </span>
  );
}

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

/** Stacked rows: title and a muted line of other values, with choice badges and row actions on the right. */
export function ListView({
  records,
  columns,
  values,
  actions,
}: {
  records: TableDataRow[];
  columns: Fields;
  values: Values;
  actions: (record: TableDataRow) => ReactNode;
}) {
  const { title, badges, meta } = parts(columns);
  return (
    <ItemGroup>
      {records.map(record => {
        const shown = meta.filter(filled(record)).slice(0, 4);
        return (
          <Item key={record.id} role="listitem" variant="outline" size="xs">
            <ItemContent>
              <ItemTitle>
                {title ? <Value record={record} fieldId={title.id} values={values} /> : `Row ${record.id.slice(0, 8)}`}
              </ItemTitle>
              {shown.length > 0 && (
                <ItemDescription>
                  <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    {shown.map(field => (
                      <Labeled key={field.id} record={record} field={field} values={values} />
                    ))}
                  </span>
                </ItemDescription>
              )}
            </ItemContent>
            <ItemActions>
              {badges.filter(filled(record)).map(field => (
                <Value key={field.id} record={record} fieldId={field.id} values={values} />
              ))}
              {actions(record)}
            </ItemActions>
          </Item>
        );
      })}
    </ItemGroup>
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
  actions: (record: TableDataRow) => ReactNode;
};

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
  actions,
}: BoardProps) {
  const definition = queryDefinition(table.definition);
  const field = boardField(definition, fieldId);
  const counts = useTableQueryResult(api, table, boardCountRequest(view, field?.id ?? ''), !!field);
  if (!field || field.kind !== 'single-select')
    return (
      <StatePanel
        kind="empty"
        heading="h3"
        icon={Kanban}
        title="Board needs a choice field"
        description={`Boards group rows by a single-choice field, such as Status. ${table.definition.label} has none yet. Add one in chat, or use Table or List.`}
      />
    );
  const data = counts.state.kind === 'ready' && counts.state.data.mode === 'summary' ? counts.state.data : null;
  const count = (optionId: string | null) =>
    data
      ? data.groups
          .filter(group => (group.keys[0] ?? null) === optionId)
          .reduce((sum, group) => sum + Number(group.values[0] ?? 0), 0)
      : null;
  const options = field.options.filter(option => !option.retired || (count(option.id) ?? 0) > 0);
  const lanes = [
    ...options.map(option => ({ id: option.id as string | null, label: option.label })),
    { id: null, label: `No ${field.label.toLowerCase()}` },
  ];
  const fields = boardFields(definition);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Columns by</span>
        <Select
          value={field.id}
          onValueChange={value => {
            if (value) changeField(value);
          }}
        >
          <SelectTrigger size="sm" aria-label="Board columns by">
            <SelectValue>{field.label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {fields.map(item => (
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
      <div role="list" aria-label={`Board by ${field.label}`} className="flex gap-3 overflow-x-auto pb-2">
        {lanes.map(lane => (
          <BoardColumn
            key={lane.id ?? 'empty'}
            api={api}
            table={table}
            view={view}
            columns={columns}
            fieldId={field.id}
            lane={lane}
            total={count(lane.id)}
            openColumn={() => openColumn(columnWhere(definition, view.where, field.id, lane.id))}
            workspace={workspace}
            actions={actions}
          />
        ))}
      </div>
    </div>
  );
}

function BoardColumn({
  api,
  table,
  view,
  columns,
  fieldId,
  lane,
  total,
  openColumn,
  workspace,
  actions,
}: Omit<BoardProps, 'fieldId' | 'changeField' | 'openColumn'> & {
  fieldId: string;
  lane: { id: string | null; label: string };
  total: number | null;
  openColumn: () => void;
}) {
  const read = useTableQueryResult(
    api,
    table,
    boardColumnRequest(queryDefinition(table.definition), view, fieldId, lane.id),
  );
  const result = read.state.kind === 'ready' && read.state.data.mode === 'rows' ? read.state.data : null;
  const records = result ? result.records.map(dataRow) : [];
  const linked = useLinkedRows(
    api,
    records.map(record => record.values),
  );
  const files = useFileNames(
    workspace.id,
    fileIdsOf(records.map(record => record.values)),
    records.flatMap(record => record.unavailableFileIds),
  );
  const values: Values = {
    linked: linked.state,
    files: files.state,
    workspace,
    definition: table.definition,
    systemKind: table.systemKind,
  };
  const { title, badges, meta } = parts(columns, fieldId);
  const more = total !== null && total > records.length;
  return (
    <section
      role="listitem"
      aria-label={`${lane.label}${total !== null ? `, ${total} rows` : ''}`}
      className="flex w-72 shrink-0 flex-col gap-2 rounded-xl bg-muted/50 p-2"
    >
      <header className="flex items-center justify-between gap-2 px-1 py-0.5">
        <span title={lane.label} className="flex min-w-0">
          <Badge variant={lane.id ? optionTone(lane.label) : 'ghost'}>
            <span className="min-w-0 truncate">{lane.label}</span>
          </Badge>
        </span>
        {total !== null && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{total.toLocaleString('en-US')}</span>
        )}
      </header>
      {read.state.kind === 'loading' ? (
        <p role="status" className="flex items-center gap-2 px-1 py-4 text-sm text-muted-foreground">
          <Spinner />
          Loading rows…
        </p>
      ) : read.state.kind === 'error' || (read.state.kind === 'ready' && read.state.data.mode === 'invalid') ? (
        <div className="space-y-2 px-1 py-2">
          <p role="alert" className="text-sm text-destructive">
            Couldn’t load this column.
          </p>
          <Button variant="outline" size="sm" onClick={() => void read.refresh()}>
            Try again
          </Button>
        </div>
      ) : read.state.kind === 'unavailable' ? (
        <p className="px-1 py-4 text-sm text-muted-foreground">Rows are unavailable.</p>
      ) : !records.length ? (
        <p className="px-1 py-4 text-sm text-muted-foreground">No rows</p>
      ) : (
        <ItemGroup>
          {records.map(record => {
            const shown = meta.filter(filled(record)).slice(0, 2),
              chips = badges.filter(filled(record)).slice(0, 2);
            return (
              <Item key={record.id} role="listitem" variant="card" size="xs">
                <ItemContent>
                  <div className="flex items-start justify-between gap-2">
                    <ItemTitle>
                      {title ? (
                        <Value record={record} fieldId={title.id} values={values} />
                      ) : (
                        `Row ${record.id.slice(0, 8)}`
                      )}
                    </ItemTitle>
                    <div className="-mt-1 -mr-1 shrink-0">{actions(record)}</div>
                  </div>
                  {shown.length > 0 && (
                    <ItemDescription>
                      <span className="flex flex-col gap-0.5">
                        {shown.map(field => (
                          <Labeled key={field.id} record={record} field={field} values={values} />
                        ))}
                      </span>
                    </ItemDescription>
                  )}
                  {chips.length > 0 && (
                    <span className="flex flex-wrap gap-1 pt-1">
                      {chips.map(field => (
                        <Value key={field.id} record={record} fieldId={field.id} values={values} />
                      ))}
                    </span>
                  )}
                </ItemContent>
              </Item>
            );
          })}
        </ItemGroup>
      )}
      {more && (
        <Button variant="ghost" size="sm" onClick={openColumn}>
          Show all {total!.toLocaleString('en-US')} in table
        </Button>
      )}
    </section>
  );
}
