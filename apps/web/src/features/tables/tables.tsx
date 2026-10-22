import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Add } from 'reicon-react/icons/Add';
import { Database } from 'reicon-react/icons/Database';
import { MoreH } from 'reicon-react/icons/MoreH';
import { Edit } from 'reicon-react/icons/Edit';
import { Button } from '@tulipfarm/sprout/button';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { TablePagination } from '@/components/table-pagination';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { RecordsSample, TablesSample, StatePanel } from '@tulipfarm/sprout/state-panel';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSortHead } from '@/components/data-grid';
import { useCursorPages } from '@/lib/use-cursor-pages';
import { TableRead } from './feedback';
import {
  useLinkedRows,
  useTableList,
  useTableDetail,
  useTableQueryResult,
  useTableRow,
  useTableReverseFields,
  useTableReverseRecords,
} from './hooks';
import { RecordMutationFeedback, useRecordMutation } from './record-mutation';
import { RecordHistory } from './record-history';
import { fileIdsOf, ReferenceRetry, TableValueView, useFileNames, type TableWorkspace } from './references';
import { TableMore } from './table-more';
import {
  tableApi,
  type TableListSort,
  type RowPermissions,
  type TableDataRow,
  type TableDefinition,
  type TableApi,
} from './api';
import { rowTotal, useUrlDraft } from './row-query';
import {
  narrowed,
  queryDefinition,
  sortable,
  storedLayout,
  storeLayout,
  summarized,
  tableView,
  viewRequest,
  viewSearch,
  type Layout,
  type TableRowsSearch,
  type TableView,
} from './table-view';
import { QueryBar } from './query-bar';
import { BoardView, ListView } from './table-layouts';
import { viewSwitcherTabId } from '@tulipfarm/sprout/view-switcher';
import { SummaryTable } from './summary-table';
import type { TableQueryResult } from '@tulipfarm/tables/query';
import { RecordEditor } from './record-editor';
import { BulkRecordActions, BulkRecordDelete } from './bulk-record-actions';
import { MemberDirectoryStatus } from './member-status';
import { MemberProfilePanel } from './member-profile';

// Sprout gives its select trigger a resting shadow; table controls stay flat like the rest of the toolbar.
const noControlShadow = { '--sprout-shadow-control': 'none' } as CSSProperties;

const plural = (count: number, noun: string) => `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
const recordCountLabel = (count: string) => (/^\d+$/.test(count) ? Number(count).toLocaleString('en-US') : count);

export function TableList({
  workspaceId,
  workspaceSlug,
  search,
  changeSearch,
}: {
  workspaceId: string;
  workspaceSlug: string;
  search: string;
  changeSearch: (search: string) => void;
}) {
  const api = useMemo(() => tableApi(workspaceId), [workspaceId]);
  const query = search.trim();
  const [sort, setSort] = useState<TableListSort>({ by: 'name', direction: 'asc' });
  const pages = useCursorPages(`${query}|${sort.by}:${sort.direction}`);
  const [draft, setDraft] = useUrlDraft(search, changeSearch);
  const read = useTableList(api, pages.after, query || undefined, sort);
  const sorted = (by: TableListSort['by']) => (sort.by === by ? sort.direction : false);
  const sortBy = (by: TableListSort['by']) =>
    setSort(current => ({
      by,
      direction: current.by === by && current.direction === 'asc' ? 'desc' : by === 'name' ? 'asc' : 'desc',
    }));
  const open = useNavigate();
  const chat = (
    <Button
      nativeButton={false}
      render={<Link to="/$workspaceSlug" params={{ workspaceSlug }} search={{ intent: 'create-table' }} />}
    >
      Create table in chat
    </Button>
  );
  return (
    <section className="space-y-6">
      <PageHeader
        title="Tables"
        description="Read active fields and edit business rows. Schema changes are reviewed in chat."
        actions={chat}
      />
      <SearchField
        id="table-search"
        label="Search tables"
        value={draft}
        maxLength={255}
        onChange={setDraft}
        placeholder="Search tables"
      />
      <TableRead state={read.state} refresh={read.refresh}>
        {data => (
          <>
            {!data.tables.length ? (
              pages.after ? (
                <StatePanel
                  kind="empty"
                  icon={Database}
                  title="No readable active tables on this page"
                  description="Return to the previous page to see your tables."
                >
                  <Button variant="outline" onClick={pages.previous}>
                    Previous tables
                  </Button>
                </StatePanel>
              ) : query ? (
                <StatePanel
                  kind="empty"
                  icon={Database}
                  title={`No tables match “${query}”`}
                  description="Search checks table names across this workspace. Try another name or clear the search."
                >
                  <Button variant="outline" onClick={() => changeSearch('')}>
                    Clear search
                  </Button>
                </StatePanel>
              ) : (
                <StatePanel
                  kind="empty"
                  icon={Database}
                  title="No tables yet"
                  description="A table holds one kind of business row, such as customers or invoices. Describe the fields in chat, and the table appears here after it is created. Ask an administrator if you need read access."
                  sample={<TablesSample />}
                >
                  <Button
                    nativeButton={false}
                    render={
                      <Link to="/$workspaceSlug" params={{ workspaceSlug }} search={{ intent: 'create-table' }} />
                    }
                  >
                    <Add size={16} aria-hidden="true" />
                    Create table in chat
                  </Button>
                </StatePanel>
              )
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableSortHead sorted={sorted('name')} onSort={() => sortBy('name')}>
                      Table
                    </TableSortHead>
                    <TableSortHead align="right" sorted={sorted('records')} onSort={() => sortBy('records')}>
                      Records
                    </TableSortHead>
                    <TableSortHead align="right" sorted={sorted('changed')} onSort={() => sortBy('changed')}>
                      Fields changed
                    </TableSortHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.tables.map(table => (
                    <TableRow
                      key={table.id}
                      interactive
                      onClick={event => {
                        if (!(event.target instanceof Element && event.target.closest('a')))
                          void open({
                            to: '/$workspaceSlug/tables/$tableId',
                            params: { workspaceSlug, tableId: table.id },
                          });
                      }}
                    >
                      <TableCell>
                        <Button
                          variant="link"
                          size="sm"
                          nativeButton={false}
                          render={
                            <Link to="/$workspaceSlug/tables/$tableId" params={{ workspaceSlug, tableId: table.id }} />
                          }
                        >
                          {table.definition.label}
                        </Button>
                        <p className="text-xs text-muted-foreground">
                          {plural(table.definition.fields.length, 'field')}
                        </p>
                      </TableCell>
                      <TableCell align="right">{recordCountLabel(table.recordCount)}</TableCell>
                      <TableCell align="right">
                        <span className="text-muted-foreground" title={table.appliedAt ?? undefined}>
                          {table.appliedAt
                            ? new Date(table.appliedAt).toLocaleDateString(undefined, {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                              })
                            : '—'}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {(pages.after || data.nextCursor) && (
              <nav aria-label="Table pages" className="flex gap-2">
                <Button variant="outline" disabled={!pages.after} onClick={pages.previous}>
                  Previous tables
                </Button>
                <Button
                  variant="outline"
                  disabled={!data.nextCursor}
                  onClick={() => {
                    if (data.nextCursor) pages.next(data.nextCursor);
                  }}
                >
                  Next tables
                </Button>
              </nav>
            )}
          </>
        )}
      </TableRead>
    </section>
  );
}

export function TableDetail({
  workspace,
  tableId,
  search,
  changeSearch,
}: {
  workspace: TableWorkspace;
  tableId: string;
  search: TableRowsSearch;
  changeSearch: ChangeRowsSearch;
}) {
  const workspaceSlug = workspace.slug;
  const api = useMemo(() => tableApi(workspace.id), [workspace.id]);
  const read = useTableDetail(api, tableId);
  const busy = read.state.kind !== 'ready' || !!read.state.error || read.state.refreshing;
  return (
    <TableRead state={read.state} refresh={read.refresh}>
      {state => (
        <div className="space-y-6">
          <PageHeader
            title={state.applied?.definition.label ?? state.saved?.definition?.label ?? 'Table'}
            parent={{ label: 'Tables', link: <Link to="/$workspaceSlug/tables" params={{ workspaceSlug }} /> }}
            actions={
              <>
                <Button
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={
                    <Link
                      to="/$workspaceSlug"
                      params={{ workspaceSlug }}
                      search={{ intent: 'edit-table', tableId: state.id }}
                    />
                  }
                >
                  Change fields in chat
                </Button>
                <TableMore state={state} api={api} workspace={workspace} disabled={busy} />
              </>
            }
          />
          {state.saved && state.applied && state.saved.revision !== state.applied.revision && (
            <Alert>
              <AlertDescription>
                A field change is still applying. Rows use the current fields until it finishes. Open Schema history
                from the ⋯ menu to follow it.
              </AlertDescription>
            </Alert>
          )}
          {state.applied ? (
            <Records
              key={`${workspace.id}/${state.id}`}
              workspace={workspace}
              tableId={state.id}
              systemKind={state.systemKind}
              applied={state.applied}
              permissions={state.rowPermissions}
              api={api}
              disabled={busy}
              refreshTable={read.refresh}
              search={search}
              changeSearch={changeSearch}
            />
          ) : (
            <StatePanel
              kind="empty"
              title="No active definition yet"
              description="Rows become available after the first schema migration completes. Open Schema history from the ⋯ menu to follow progress."
            />
          )}
        </div>
      )}
    </TableRead>
  );
}

type ChangeRowsSearch = (next: Partial<TableRowsSearch>) => void;
type RowSelection =
  | { kind: 'create' }
  | { kind: 'edit' | 'history' | 'delete' | 'profile'; record: TableDataRow }
  | { kind: 'bulk-delete'; records: TableDataRow[] };
type QueryRecord = Extract<TableQueryResult, { mode: 'rows' }>['records'][number];
/** Query rows match the web row shape apart from branded value keys and an optional file list. */
const dataRow = (record: QueryRecord) =>
  ({ ...record, unavailableFileIds: record.unavailableFileIds ?? [] }) as unknown as TableDataRow;

export function Records({
  workspace,
  tableId,
  systemKind,
  applied,
  permissions,
  api,
  disabled,
  refreshTable,
  search,
  changeSearch,
  initialAfter,
  pageSize = 50,
}: {
  workspace: TableWorkspace;
  tableId: string;
  systemKind?: TableDefinition['systemKind'];
  applied: { revision: string; definition: TableDefinition['definition'] };
  permissions: RowPermissions;
  api: TableApi;
  disabled: boolean;
  refreshTable: () => Promise<void>;
  search: TableRowsSearch;
  changeSearch: ChangeRowsSearch;
  initialAfter?: string | undefined;
  pageSize?: number;
}) {
  const [limit, setLimit] = useState(pageSize);
  const [exporting, setExporting] = useState(false);
  const table = useMemo(
    () => ({ id: tableId, revision: applied.revision, definition: applied.definition, systemKind }),
    [tableId, applied.revision, applied.definition, systemKind],
  );
  const view = tableView(search, queryDefinition(table.definition));
  const layoutPanel = useId();
  const [layout, setLayout] = useState<Layout>(() => search.view ?? storedLayout(tableId) ?? 'table');
  useEffect(() => {
    if (search.view) setLayout(search.view);
  }, [search.view]);
  const changeLayout = (next: Layout) => {
    setLayout(next);
    storeLayout(tableId, next);
    changeSearch({ view: next });
  };
  // Board and List always show rows; grouping applies to the Table layout only.
  const shown = layout === 'table' ? view : { ...view, groupBy: [], metrics: [] };
  const filtered = narrowed(view);
  const summary = summarized(shown);
  // Column choice is display-only, so toggling a column never refetches rows.
  const fetched = { ...shown, select: undefined };
  const queryScope = JSON.stringify([applied.revision, fetched, limit]);
  const pages = useCursorPages(queryScope, initialAfter);
  const request = viewRequest(fetched, pages.after);
  const read = useTableQueryResult(
    api,
    table,
    'options' in request ? { ...request, options: { ...request.options, limit } } : request,
  );
  const data = read.state.kind === 'ready' ? read.state.data : null;
  const result = data && data.mode !== 'invalid' ? data : null;
  const last = useRef<{ revision: string; view: string; result: TableQueryResult } | null>(null);
  if (last.current?.revision !== applied.revision || read.state.kind === 'unavailable') last.current = null;
  if (result) last.current = { revision: applied.revision, view: JSON.stringify(shown), result };
  const rows = result?.mode === 'rows' ? result.records.map(dataRow) : [];
  const selectionScope = JSON.stringify([queryScope, pages.after, layout, rows.map(row => [row.id, row.token])]);
  const [checked, setChecked] = useState<{ scope: string; ids: string[] }>({ scope: selectionScope, ids: [] });
  if (checked.scope !== selectionScope) setChecked({ scope: selectionScope, ids: [] });
  const selectedRows = checked.scope === selectionScope ? rows.filter(row => checked.ids.includes(row.id)) : [];
  const selectedIds = new Set(selectedRows.map(row => row.id));
  const pageTotal = useRef<{
    scope: string;
    total: string | null;
    after: string | undefined;
    result: TableQueryResult | null;
  }>({ scope: queryScope, total: null, after: undefined, result: null });
  if (pageTotal.current.scope !== queryScope)
    pageTotal.current = { scope: queryScope, total: null, after: undefined, result: null };
  if (result) {
    if (pages.after && pageTotal.current.after === pages.after && pageTotal.current.result !== result)
      pageTotal.current.total = null;
    if (!pages.after) pageTotal.current.total = result.mode === 'rows' ? result.total : result.groupCount;
    pageTotal.current.after = pages.after;
    pageTotal.current.result = result;
  }
  const shownRows = last.current?.result.mode === 'rows' ? last.current.result.records.map(dataRow) : rows;
  const linked = useLinkedRows(
    api,
    shownRows.map(record => record.values),
  );
  const files = useFileNames(
    workspace.id,
    fileIdsOf(shownRows.map(record => record.values)),
    shownRows.flatMap(record => record.unavailableFileIds),
  );
  const workspaceSlug = workspace.slug;
  const [selection, setSelection] = useState<RowSelection | null>(null);
  useEffect(() => {
    if (read.state.kind === 'unavailable') setSelection(null);
  }, [read.state.kind]);
  const [notice, setNotice] = useState('');
  const [returnFocus, setReturnFocus] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (returnFocus) heading.current?.focus();
  }, [returnFocus]);
  const editing = selection !== null;
  const refresh = async () => {
    await read.refresh();
    await refreshTable();
  };
  const select = (next: RowSelection) => {
    setNotice('');
    setSelection(next);
  };
  const finish = (message = '') => {
    setSelection(null);
    setNotice(message);
    setReturnFocus(count => count + 1);
  };
  const apply = (next: TableView) => {
    changeSearch(viewSearch(next));
    if (JSON.stringify({ ...next, select: undefined }) !== JSON.stringify({ ...view, select: undefined }))
      pages.first();
  };
  const clear = () => apply({ ...view, where: '', search: undefined });
  const locked =
    disabled ||
    exporting ||
    read.state.kind !== 'ready' ||
    !!read.state.error ||
    read.state.refreshing ||
    data?.mode === 'invalid';
  if (search.row)
    return (
      <section className="space-y-4">
        <h2 className="text-sm font-medium">Rows</h2>
        <AddressedRecord
          key={search.row}
          recordId={search.row}
          table={table}
          permissions={permissions}
          api={api}
          workspace={workspace}
          disabled={disabled}
          close={() => changeSearch({ row: undefined })}
          refresh={refresh}
        />
      </section>
    );
  const firstUse = result?.mode === 'rows' && !result.records.length && !pages.after && !filtered && !summary;
  const addRow = (
    <Button disabled={locked || editing} onClick={() => select({ kind: 'create' })}>
      <Add size={16} aria-hidden="true" />
      {systemKind ? 'Add member' : 'Add row'}
    </Button>
  );
  const headerAdd = permissions.create && read.state.kind === 'ready' && !firstUse;
  const sortLabel = view.sort
    .map(item => table.definition.fields.find(field => field.id === item.fieldId)?.label)
    .filter(Boolean)
    .join(', ');
  const added = `Row added. Rows are ${sortLabel ? `sorted by ${sortLabel}` : 'listed by ID'}${filtered ? ' and filtered, so it may appear on another page or not match the current filters.' : ', so it may appear on another page.'}`;
  const columns = view.select
    ? table.definition.fields.filter(field => view.select!.includes(field.id))
    : table.definition.fields;
  const total =
    result?.mode === 'rows'
      ? result.total && !pages.after && !firstUse
        ? rowTotal(result.total, filtered)
        : ''
      : result?.mode === 'summary' && result.groupCount
        ? `${result.groupCount} ${result.groupCount === '1' ? 'group' : 'groups'}${filtered ? ' from matching rows' : ''}`
        : '';
  const references = result?.references ?? last.current?.result.references ?? {};
  const panel =
    !selection || read.state.kind === 'unavailable' ? null : selection.kind === 'create' ? (
      <RecordEditor
        key="create"
        record={null}
        table={table}
        api={api}
        workspace={workspace}
        disabled={locked || !permissions.create}
        close={() => finish()}
        saved={() => finish(added)}
        refresh={refresh}
      />
    ) : selection.kind === 'edit' ? (
      <RecordEditor
        key={`${selection.record.id}/${selection.record.token}`}
        record={selection.record}
        table={table}
        api={api}
        workspace={workspace}
        disabled={locked || !permissions.update}
        close={() => finish()}
        saved={() => finish('Row saved.')}
        refresh={refresh}
      />
    ) : selection.kind === 'profile' ? (
      <MemberProfilePanel
        key={selection.record.id}
        record={selection.record}
        table={table}
        api={api}
        workspace={workspace}
        close={() => finish()}
        refresh={refresh}
      />
    ) : selection.kind === 'delete' ? (
      <RecordDelete
        key={`${selection.record.id}/${selection.record.token}`}
        record={selection.record}
        table={table}
        api={api}
        workspaceSlug={workspaceSlug}
        disabled={locked}
        close={() => finish()}
        saved={() => finish('Row deleted. Restore it from Deleted rows in the ⋯ menu within 30 days.')}
        refresh={refresh}
      />
    ) : selection.kind === 'bulk-delete' ? (
      <BulkRecordDelete
        records={selection.records}
        table={table}
        api={api}
        disabled={locked || !permissions.delete}
        close={count =>
          finish(
            count
              ? `${count} ${count === 1 ? 'row deleted' : 'rows deleted'}. Restore from Deleted rows within 30 days.`
              : '',
          )
        }
        refresh={refresh}
      />
    ) : (
      <RecordHistory
        key={`${selection.record.id}/${selection.record.token}`}
        record={selection.record}
        table={table}
        permissions={permissions}
        api={api}
        workspace={workspace}
        disabled={locked}
        close={() => {
          setSelection(null);
          void refresh();
        }}
        saved={() => finish()}
        refresh={refresh}
      />
    );
  const actions = (record: TableDataRow) => (
    <div className="flex items-center gap-1">
      {permissions.update && (
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={locked || editing}
          aria-label={`Edit row ${record.id.slice(0, 8)}`}
          onClick={() => select({ kind: 'edit', record })}
        >
          <Edit size={16} aria-hidden="true" />
        </Button>
      )}
      <RowActions
        record={record}
        permissions={permissions}
        disabled={locked || editing}
        select={select}
        systemKind={systemKind}
      />
    </div>
  );
  const openRow =
    permissions.update && !locked && !editing ? (record: TableDataRow) => select({ kind: 'edit', record }) : undefined;
  const rowMenu =
    locked || editing
      ? undefined
      : (record: TableDataRow) => (
          <RowActionItems record={record} permissions={permissions} select={select} systemKind={systemKind} />
        );
  const values = { linked: linked.state, files: files.state, workspace, definition: table.definition, systemKind };
  const sortOf = (fieldId: string) => (view.sort[0]?.fieldId === fieldId ? view.sort[0].direction : null);
  const cycleSort = (fieldId: string) => {
    const current = sortOf(fieldId);
    apply({ ...view, sort: current === 'desc' ? [] : [{ fieldId, direction: current === 'asc' ? 'desc' : 'asc' }] });
  };
  const header = (field: TableDefinition['definition']['fields'][number]) => {
    const direction = sortOf(field.id);
    if (!sortable(queryDefinition(table.definition).fields.find(item => item.id === field.id)!))
      return <TableHead key={field.id}>{field.label}</TableHead>;
    return (
      <TableSortHead
        key={field.id}
        sorted={direction ?? false}
        clearsOnDescending
        disabled={locked || editing}
        onSort={() => cycleSort(field.id)}
      >
        {field.label}
      </TableSortHead>
    );
  };
  const rowTable = (records: TableDataRow[], loading = false) => (
    <Table variant="grid" aria-label={`${table.definition.label} rows`} aria-busy={loading}>
      <TableHeader>
        <TableRow>
          <TableHead selection>
            <div className="flex justify-center">
              <Checkbox
                aria-label="Select all rows on this page"
                checked={records.length > 0 && selectedRows.length === records.length}
                indeterminate={selectedRows.length > 0 && selectedRows.length < records.length}
                disabled={locked || editing || !records.length}
                onCheckedChange={value =>
                  setChecked({ scope: selectionScope, ids: value ? records.map(record => record.id) : [] })
                }
              />
            </div>
          </TableHead>
          {columns.map(header)}
          <TableHead stickyEnd>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {loading
          ? Array.from({ length: limit }, (_, index) => (
              <TableRow key={index} data-loading-row aria-hidden="true">
                <TableCell selection>
                  <div className="flex justify-center">
                    <Skeleton shape="checkbox" />
                  </div>
                </TableCell>
                {columns.map(field => (
                  <TableCell key={field.id}>
                    <div className="min-w-24">
                      <Skeleton />
                    </div>
                  </TableCell>
                ))}
                <TableCell stickyEnd>
                  <div className="flex justify-end gap-1">
                    {permissions.update && <Skeleton shape="action" />}
                    <Skeleton shape="action" />
                  </div>
                </TableCell>
              </TableRow>
            ))
          : records.map(record => (
              <TableRow key={record.id} data-state={selectedIds.has(record.id) ? 'selected' : undefined}>
                <TableCell selection>
                  <div className="flex justify-center">
                    <Checkbox
                      aria-label={`Select row ${record.id.slice(0, 8)}`}
                      checked={selectedIds.has(record.id)}
                      disabled={locked || editing}
                      onCheckedChange={value =>
                        setChecked({
                          scope: selectionScope,
                          ids: value ? [...selectedIds, record.id] : [...selectedIds].filter(id => id !== record.id),
                        })
                      }
                    />
                  </div>
                </TableCell>
                {columns.map(field => (
                  <TableCell key={field.id}>
                    <TableValueView
                      compact
                      record={record}
                      systemKind={systemKind}
                      value={record.values[field.id]}
                      definition={table.definition}
                      fieldId={field.id}
                      linked={linked.state}
                      files={files.state}
                      unavailableFileIds={record.unavailableFileIds}
                      workspace={workspace}
                    />
                  </TableCell>
                ))}
                <TableCell stickyEnd>
                  <div className="flex justify-end">{actions(record)}</div>
                </TableCell>
              </TableRow>
            ))}
      </TableBody>
    </Table>
  );
  const output = (current: TableQueryResult) =>
    current.mode === 'summary' ? (
      current.groups.length ? (
        <SummaryTable
          definition={table.definition}
          systemKind={systemKind}
          workspaceId={workspace.id}
          groupBy={view.groupBy}
          metrics={view.metrics.length ? view.metrics : [{ fn: 'count' }]}
          groups={current.groups}
        />
      ) : (
        <StatePanel
          kind="empty"
          heading="h3"
          icon={Database}
          title={filtered ? 'No rows match' : 'Nothing to summarize'}
          description={
            filtered
              ? 'No rows match the current search and filters, so there are no groups.'
              : `${table.definition.label} has no rows yet.`
          }
        >
          {filtered && (
            <Button variant="outline" onClick={clear}>
              Clear filters
            </Button>
          )}
        </StatePanel>
      )
    ) : current.records.length === 0 ? (
      pages.after ? (
        <StatePanel
          kind="empty"
          heading="h3"
          icon={Database}
          title="No rows on this page"
          description="Return to the previous page to see existing rows."
        >
          <Button variant="outline" disabled={locked} onClick={pages.previous}>
            Previous rows
          </Button>
        </StatePanel>
      ) : filtered ? (
        <StatePanel
          kind="empty"
          heading="h3"
          icon={Database}
          title="No rows match"
          description={`No rows in ${table.definition.label} match the current search and filters.`}
        >
          <Button variant="outline" disabled={editing} onClick={clear}>
            Clear filters
          </Button>
        </StatePanel>
      ) : (
        <StatePanel
          kind="empty"
          heading="h3"
          icon={Database}
          title="No rows yet"
          description={
            permissions.create
              ? `${table.definition.label} is ready for its first row. Add one here, or ask the assistant to add rows or import a file.`
              : `${table.definition.label} is ready for its first row. Ask the assistant to add rows or import a file. You review the exact changes before approval.`
          }
          sample={
            <RecordsSample table={table.definition.label} fields={table.definition.fields.map(field => field.label)} />
          }
        >
          {permissions.create && addRow}
          <Button
            variant={permissions.create ? 'outline' : 'default'}
            nativeButton={false}
            render={
              <Link
                to="/$workspaceSlug"
                params={{ workspaceSlug }}
                search={{ intent: 'add-rows', tableId: table.id }}
              />
            }
          >
            {!permissions.create && <Add size={16} aria-hidden="true" />}Add rows in chat
          </Button>
        </StatePanel>
      )
    ) : layout === 'list' ? (
      <ListView
        label={`${table.definition.label} rows`}
        records={current.records.map(dataRow)}
        columns={columns}
        values={values}
        actions={actions}
        open={openRow}
      />
    ) : (
      rowTable(current.records.map(dataRow))
    );
  return (
    <>
      <section key={applied.revision} className="space-y-4 pb-20">
        {systemKind === 'workspace-members' && (
          <MemberDirectoryStatus table={table} api={api} workspace={workspace} refresh={refresh} />
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-baseline gap-3">
            <h2 ref={heading} tabIndex={-1} className="text-sm font-medium">
              {summary ? 'Summary' : 'Rows'}
            </h2>
            <p role={filtered ? 'status' : undefined} className="text-sm text-muted-foreground">
              {total}
            </p>
          </div>
        </div>
        {!firstUse && read.state.kind !== 'unavailable' && (
          <QueryBar
            api={api}
            table={table}
            view={view}
            references={references}
            apply={apply}
            disabled={editing}
            layout={layout}
            changeLayout={changeLayout}
            layoutPanel={layoutPanel}
            mode={search.find}
            changeMode={find => changeSearch({ find })}
            actions={headerAdd && addRow}
            selection={
              layout === 'table' && !summary && selectedRows.length > 0 ? (
                <BulkRecordActions
                  key={selectionScope}
                  records={selectedRows}
                  api={api}
                  table={table}
                  view={view}
                  disabled={locked || editing}
                  canDelete={permissions.delete}
                  clear={() => setChecked({ scope: selectionScope, ids: [] })}
                  remove={() => select({ kind: 'bulk-delete', records: selectedRows })}
                  busy={setExporting}
                />
              ) : undefined
            }
          />
        )}
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        <div
          id={layoutPanel}
          className="space-y-4"
          {...(!firstUse && read.state.kind !== 'unavailable'
            ? { role: 'tabpanel', 'aria-labelledby': viewSwitcherTabId(layoutPanel, layout) }
            : {})}
        >
          <ReferenceRetry linked={linked} files={files} />
          {layout === 'board' && !firstUse && read.state.kind !== 'unavailable' ? (
            <BoardView
              api={api}
              table={table}
              view={view}
              columns={columns}
              fieldId={search.board}
              changeField={board => changeSearch({ board })}
              openColumn={where => {
                changeLayout('table');
                apply({ ...view, where });
              }}
              workspace={workspace}
              menu={rowMenu}
              open={openRow}
            />
          ) : read.state.kind === 'error' && last.current ? (
            <div className="space-y-3">
              <Alert variant="destructive">
                <AlertDescription>{`These rows could not load. ${read.state.message}`}</AlertDescription>
              </Alert>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => void read.refresh()}>
                  Try again
                </Button>
              </div>
              <div className="space-y-2 opacity-60">
                <p className="text-sm text-muted-foreground">
                  Showing the last results that loaded. They may be out of date.
                </p>
                {output(last.current.result)}
              </div>
            </div>
          ) : (
            <TableRead
              state={read.state}
              refresh={read.refresh}
              loading={read.state.kind === 'loading' && layout === 'table' && !summary ? rowTable([], true) : undefined}
            >
              {current =>
                current.mode === 'invalid' ? (
                  <div className="space-y-3">
                    <Alert variant="destructive">
                      <AlertDescription>
                        {pages.after
                          ? 'This page is no longer valid. The rows may have changed since it loaded.'
                          : `This search can’t run. ${current.issues.map(issue => issue.message).join(' ')}`}
                      </AlertDescription>
                    </Alert>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" disabled={editing} onClick={pages.after ? pages.first : clear}>
                        {pages.after ? 'Back to first rows' : 'Clear filters'}
                      </Button>
                    </div>
                    {last.current && (
                      <div className="space-y-2 opacity-60">
                        <p className="text-sm text-muted-foreground">Showing the last results that loaded.</p>
                        {output(last.current.result)}
                      </div>
                    )}
                  </div>
                ) : (
                  output(current)
                )
              }
            </TableRead>
          )}
          {layout !== 'board' && !firstUse && (read.state.kind === 'loading' || result) && (
            <div className="contents" style={noControlShadow}>
              <TablePagination
                page={pages.page}
                pageSize={limit}
                count={result?.mode === 'rows' ? result.records.length : (result?.groups.length ?? 0)}
                total={pageTotal.current.total}
                hasNext={!!result?.nextCursor}
                disabled={locked || editing}
                loading={read.state.kind === 'loading'}
                groups={summary}
                unknownStart={!!initialAfter && !!pages.after && pageTotal.current.total === null}
                onFirst={pages.first}
                onPrevious={pages.previous}
                onNext={() => {
                  if (result?.nextCursor) pages.next(result.nextCursor);
                }}
                onPageSize={size => {
                  pages.first();
                  setLimit(size);
                }}
              />
            </div>
          )}
        </div>
      </section>
      {panel}
    </>
  );
}

type RowActionProps = {
  record: TableDataRow;
  permissions: RowPermissions;
  select: (next: RowSelection) => void;
  systemKind?: TableDefinition['systemKind'];
};

/** The row menu's items, shared by the table and list menu button and the board card menu. */
function RowActionItems({ record, permissions, select, systemKind }: RowActionProps) {
  return (
    <>
      <DropdownMenuGroup>
        {permissions.update && (
          <DropdownMenuItem onClick={() => select({ kind: 'edit', record })}>Edit row</DropdownMenuItem>
        )}
        {systemKind === 'workspace-members' && (
          <DropdownMenuItem onClick={() => select({ kind: 'profile', record })}>Profile and photo</DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => select({ kind: 'history', record })}>History</DropdownMenuItem>
      </DropdownMenuGroup>
      {permissions.delete && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => select({ kind: 'delete', record })}>
            Delete row
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}

/** One menu per row keeps the grid compact. The trigger names the row so screen readers can tell rows apart. */
function RowActions({ disabled, record, permissions, select, systemKind }: RowActionProps & { disabled: boolean }) {
  const id = record.id.slice(0, 8);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" disabled={disabled} aria-label={`Actions for row ${id}`} />}
      >
        <MoreH size={16} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <RowActionItems record={record} permissions={permissions} select={select} systemKind={systemKind} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AddressedRecord({
  recordId,
  table,
  permissions,
  api,
  workspace,
  disabled,
  close,
  refresh,
}: {
  recordId: string;
  table: TableDefinition;
  permissions: RowPermissions;
  api: TableApi;
  workspace: TableWorkspace;
  disabled: boolean;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const read = useTableRow(api, table, recordId);
  const [selection, setSelection] = useState<{ kind: 'edit' | 'delete' | 'profile'; record: TableDataRow } | null>(
    null,
  );
  const [notice, setNotice] = useState('');
  const record = read.state.kind === 'ready' ? read.state.data : null;
  const unavailable = read.state.kind === 'unavailable' || (read.state.kind === 'ready' && !record);
  useEffect(() => {
    if (unavailable) setSelection(null);
  }, [unavailable]);
  const error =
    read.state.kind === 'error' ? read.state.message : read.state.kind === 'ready' ? read.state.error : null;
  const locked = disabled || read.state.kind !== 'ready' || !!error || read.state.refreshing;
  const refreshRecord = async () => {
    await read.refresh();
    await refresh();
  };
  return (
    <div className="space-y-4">
      {read.state.kind === 'loading' ? (
        <StatePanel
          kind="loading"
          heading="h3"
          title="Opening row"
          description="Loading the linked row and its history."
        />
      ) : unavailable ? (
        <UnavailableRow close={close} />
      ) : error ? (
        <StatePanel kind="error" heading="h3" title="Could not open row" description={error}>
          <Button variant="outline" onClick={() => void read.refresh()}>
            Try again
          </Button>
          <Button variant="ghost" onClick={close}>
            Back to table
          </Button>
        </StatePanel>
      ) : (
        record && (
          <>
            <div className="flex flex-wrap gap-2">
              {permissions.update && (
                <Button disabled={locked || selection !== null} onClick={() => setSelection({ kind: 'edit', record })}>
                  <Edit size={16} aria-hidden="true" />
                  Edit row
                </Button>
              )}
              {table.systemKind === 'workspace-members' && (
                <Button
                  variant="outline"
                  disabled={locked || selection !== null}
                  onClick={() => setSelection({ kind: 'profile', record })}
                >
                  Profile and photo
                </Button>
              )}
              {permissions.delete && (
                <Button
                  variant="outline"
                  disabled={locked || selection !== null}
                  onClick={() => setSelection({ kind: 'delete', record })}
                >
                  Delete row
                </Button>
              )}
            </div>
            {notice && (
              <p role="status" className="text-sm">
                {notice}
              </p>
            )}
            <IncomingLinkedRows table={table} record={record} api={api} workspaceSlug={workspace.slug} />
            <RecordHistory
              key={`${table.revision}/${record.id}/${record.token}`}
              table={table}
              record={record}
              permissions={permissions}
              api={api}
              workspace={workspace}
              disabled={locked || selection !== null}
              close={close}
              saved={close}
              refresh={refreshRecord}
            />
          </>
        )
      )}
      {!unavailable && selection?.kind === 'edit' && (
        <RecordEditor
          record={selection.record}
          table={table}
          api={api}
          workspace={workspace}
          disabled={locked || !permissions.update}
          close={() => setSelection(null)}
          saved={() => {
            setSelection(null);
            setNotice('Row saved.');
          }}
          refresh={refreshRecord}
        />
      )}
      {!unavailable && selection?.kind === 'delete' && (
        <RecordDelete
          record={selection.record}
          table={table}
          api={api}
          workspaceSlug={workspace.slug}
          disabled={locked || !permissions.delete}
          close={() => setSelection(null)}
          saved={close}
          refresh={refreshRecord}
        />
      )}
      {!unavailable && selection?.kind === 'profile' && (
        <MemberProfilePanel
          record={selection.record}
          table={table}
          api={api}
          workspace={workspace}
          close={() => setSelection(null)}
          refresh={refreshRecord}
        />
      )}
    </div>
  );
}

function UnavailableRow({ close }: { close: () => void }) {
  return (
    <StatePanel
      kind="unavailable"
      heading="h3"
      title="Row unavailable"
      description="This row was deleted or you no longer have access to it."
    >
      <Button variant="outline" onClick={close}>
        Back to table
      </Button>
    </StatePanel>
  );
}

function IncomingLinkedRows({
  table,
  record,
  api,
  workspaceSlug,
}: {
  table: TableDefinition;
  record: TableDataRow;
  api: TableApi;
  workspaceSlug: string;
}) {
  const pages = useCursorPages(record.id);
  const fields = useTableReverseFields(api, table.id, record.id, pages.after);
  if (fields.state.kind === 'loading')
    return (
      <StatePanel
        kind="loading"
        heading="h3"
        title="Loading incoming links"
        description="Checking rows that link to this row."
      />
    );
  if (fields.state.kind === 'error' || (fields.state.kind === 'ready' && fields.state.error))
    return (
      <StatePanel
        kind="error"
        heading="h3"
        title="Could not load incoming links"
        description={fields.state.kind === 'error' ? fields.state.message : (fields.state.error ?? '')}
      >
        <Button variant="outline" onClick={() => void fields.refresh()}>
          Try again
        </Button>
      </StatePanel>
    );
  if (fields.state.kind !== 'ready' || (!fields.state.data.fields.length && !pages.after)) return null;
  return (
    <section
      id="incoming-links"
      aria-label="Incoming linked rows"
      className="space-y-3 rounded-xl border border-border p-4"
    >
      <h3 className="text-base font-medium">Incoming linked rows</h3>
      {fields.state.data.fields.map(field => (
        <IncomingField
          key={field.fieldId}
          table={table}
          record={record}
          field={field}
          api={api}
          workspaceSlug={workspaceSlug}
        />
      ))}
      {!fields.state.data.fields.length && (
        <p className="text-sm text-muted-foreground">No reverse fields on this page.</p>
      )}
      {(pages.after || fields.state.data.nextCursor) && (
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={!pages.after} onClick={pages.previous}>
            Previous fields
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!fields.state.data.nextCursor}
            onClick={() => {
              if (fields.state.kind === 'ready' && fields.state.data.nextCursor)
                pages.next(fields.state.data.nextCursor);
            }}
          >
            Next fields
          </Button>
        </div>
      )}
    </section>
  );
}

function IncomingField({
  table,
  record,
  field,
  api,
  workspaceSlug,
}: {
  table: TableDefinition;
  record: TableDataRow;
  field: { fieldId: string; tableId: string; label: string; cardinality: 'one' | 'many' };
  api: TableApi;
  workspaceSlug: string;
}) {
  const pages = useCursorPages(field.fieldId);
  const links = useTableReverseRecords(api, table.id, record.id, field.fieldId, pages.after);
  if (links.state.kind === 'loading') return <p className="text-sm">Loading {field.label}…</p>;
  if (links.state.kind === 'error' || (links.state.kind === 'ready' && links.state.error))
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm">
          Could not load {field.label}.
        </p>
        <Button variant="outline" size="sm" onClick={() => void links.refresh()}>
          Try again
        </Button>
      </div>
    );
  if (links.state.kind !== 'ready') return null;
  return (
    <div className="space-y-2">
      <h4 className="font-medium">{field.label}</h4>
      {links.state.data.recordIds.length ? (
        <ul className="list-disc pl-5 text-sm">
          {links.state.data.recordIds.map(id => (
            <li key={id}>
              <Link
                to="/$workspaceSlug/tables/$tableId"
                params={{ workspaceSlug, tableId: field.tableId }}
                search={{ row: id }}
              >
                Row {id.slice(0, 8)}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No linked rows on this page.</p>
      )}
      {(pages.after || links.state.data.nextCursor) && (
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={!pages.after} onClick={pages.previous}>
            Previous rows
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!links.state.data.nextCursor}
            onClick={() => {
              if (links.state.kind === 'ready' && links.state.data.nextCursor) pages.next(links.state.data.nextCursor);
            }}
          >
            Next rows
          </Button>
        </div>
      )}
    </div>
  );
}

function RecordDelete({
  record,
  table,
  api,
  workspaceSlug,
  disabled,
  close,
  saved,
  refresh,
}: {
  record: TableDataRow;
  table: TableDefinition;
  api: TableApi;
  workspaceSlug: string;
  disabled: boolean;
  close: () => void;
  saved: () => void;
  refresh: () => Promise<void>;
}) {
  const write = useRecordMutation(api, saved);
  const sending = write.state.kind === 'sending';
  const dismiss = () => {
    if (sending) return;
    close();
    if (write.state.kind !== 'idle') void refresh();
  };
  return (
    <AlertDialog
      open
      onOpenChange={open => {
        if (!open) dismiss();
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>Delete row {record.id.slice(0, 8)}?</AlertDialogTitle>
        <AlertDialogDescription>
          The row leaves active rows. Its values stay recoverable for 30 days from Deleted rows in the ⋯ menu. A row
          that other rows still link to cannot be deleted.
        </AlertDialogDescription>
        <RecordMutationFeedback mutation={write} refresh={refresh} />
        {write.state.kind === 'rejected' && write.state.message.startsWith('Linked deletion is blocked.') && (
          <p className="text-sm underline">
            <Link
              to="/$workspaceSlug/tables/$tableId"
              params={{ workspaceSlug, tableId: table.id }}
              search={{ row: record.id }}
              onClick={dismiss}
            >
              View incoming linked rows
            </Link>
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={sending}>
            {write.state.kind === 'uncertain'
              ? 'Close and inspect current rows'
              : write.state.kind === 'rejected'
                ? 'Close'
                : 'Keep row'}
          </AlertDialogCancel>
          {(write.state.kind === 'idle' || sending) && (
            <AlertDialogAction
              variant="destructive"
              disabled={disabled || sending}
              aria-busy={sending}
              onClick={() =>
                void write.submit({
                  kind: 'delete',
                  requestId: crypto.randomUUID(),
                  tableId: table.id,
                  revision: table.revision,
                  recordId: record.id,
                  expectedToken: record.token,
                })
              }
            >
              {sending ? 'Deleting row…' : 'Delete row'}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
