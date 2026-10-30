import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { RowView } from '@tulipfarm/conversations/row-view';
import { AddCircle } from 'reicon-react/icons/AddCircle';
import { ArrowUpRight } from 'reicon-react/icons/ArrowUpRight';
import { Edit2 } from 'reicon-react/icons/Edit2';
import { Refresh } from 'reicon-react/icons/Refresh';
import { Disclosure } from '@/components/disclosure';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { ResultCard } from '@tulipfarm/sprout/result-card';
import { Database } from 'reicon-react/icons/Database';
import { CanvasSection } from '@tulipfarm/sprout/canvas';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { MessageTableViewport } from '@tulipfarm/sprout/message-response';
import { Table, type TableColumn } from '@tulipfarm/sprout/table';
import { tableApi, type TableApi, type DefinitionState, type TableDefinition } from '@/features/tables/api';
import { TableRead } from '@/features/tables/feedback';
import { useLinkedRows, useTableDetail, useTableRowsById } from '@/features/tables/hooks';
import { fileIdsOf, ReferenceRetry, TableValueView, useFileNames } from '@/features/tables/references';
import { Records } from '@/features/tables/tables';
import { viewSearch, type TableRowsSearch } from '@/features/tables/table-view';
import { workspaceRoute } from '@/router';
import { useCanvas } from './canvas-state';
import { recordChangesSummary, type RecordChanges } from './record-changes';

export function RowViewResponse({ references, children }: { references: RowView[]; children: ReactNode }) {
  return <MessageTableViewport bounded={references.length > 0}>{children}</MessageTableViewport>;
}

export function RowViewCard({ reference }: { reference: RowView }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const api = useMemo(() => tableApi(workspace.id), [workspace.id]);
  const read = useTableDetail(api, reference.tableId);
  const title =
    read.state.kind === 'ready' ? (read.state.data.applied?.definition.label ?? 'Table rows') : 'Table rows';
  const { show, update } = useCanvas();
  const open = () => show({ id: `records:${reference.callId}`, title, content: { kind: 'records', reference } });
  useEffect(() => {
    update(`records:${reference.callId}`, { title, content: { kind: 'records', reference } });
  }, [reference, title, update]);
  return (
    <section aria-label="Table result" className="space-y-2">
      <ResultCard
        title={title}
        kind="Table"
        apps={[]}
        icon={<Database size={18} />}
        state="success"
        status={
          reference.recordIds
            ? `${reference.recordIds.length} ${reference.recordIds.length === 1 ? 'row returned' : 'rows returned'}.`
            : 'Table results ready.'
        }
        action={{ label: `Open ${title}`, onClick: open }}
      />
    </section>
  );
}

export function RecordsCanvas({ reference }: { reference: RowView }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const api = useMemo(() => tableApi(workspace.id), [workspace.id]);
  const read = useTableDetail(api, reference.tableId);
  return (
    <TableRead state={read.state} refresh={read.refresh}>
      {state =>
        state.applied?.revision === reference.revision ? (
          reference.recordIds ? (
            <ChangedRows
              key={reference.callId}
              recordIds={reference.recordIds}
              table={{
                id: state.id,
                revision: state.applied.revision,
                definition: state.applied.definition,
                systemKind: state.systemKind,
              }}
              api={api}
            />
          ) : (
            <CanvasRecords
              key={reference.callId}
              reference={reference}
              state={state}
              api={api}
              disabled={read.state.kind !== 'ready' || !!read.state.error || read.state.refreshing}
              refresh={read.refresh}
            />
          )
        ) : (
          <CanvasSection title="Table changed">
            <StatePanel
              kind="unavailable"
              title="These fields have changed"
              description="This saved query uses an older table definition. Open the current table, or ask for these rows again."
            >
              <Button
                variant="outline"
                nativeButton={false}
                render={
                  <Link
                    to="/$workspaceSlug/tables/$tableId"
                    params={{ workspaceSlug: workspace.slug, tableId: reference.tableId }}
                  />
                }
              >
                Open current table
              </Button>
              <Button variant="ghost" onClick={() => void read.refresh()}>
                Check again
              </Button>
            </StatePanel>
          </CanvasSection>
        )
      }
    </TableRead>
  );
}

function CanvasRecords({
  reference,
  state,
  api,
  disabled,
  refresh,
}: {
  reference: RowView;
  state: DefinitionState;
  api: TableApi;
  disabled: boolean;
  refresh: () => Promise<void>;
}) {
  const { workspace, sessionId } = workspaceRoute.useRouteContext();
  const applied = state.applied!;
  const [search, setSearch] = useState<TableRowsSearch>(() => ({
    ...viewSearch({
      where: reference.query.rsql,
      search: reference.query.options.search,
      sort: reference.query.options.sort,
      select: reference.query.options.select,
      groupBy: [],
      metrics: [],
    }),
    view: 'table',
  }));
  return (
    <CanvasSection
      title={applied.definition.label}
      actions={
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={
            <Link
              to="/$workspaceSlug/tables/$tableId"
              params={{ workspaceSlug: workspace.slug, tableId: reference.tableId }}
            />
          }
        >
          Open current table
        </Button>
      }
    >
      <Records
        workspace={{ id: workspace.id, slug: workspace.slug, sessionId }}
        tableId={reference.tableId}
        systemKind={state.systemKind}
        applied={applied}
        permissions={state.rowPermissions}
        api={api}
        disabled={disabled}
        refreshTable={refresh}
        search={search}
        changeSearch={next => setSearch(current => ({ ...current, ...next }))}
        initialAfter={reference.query.options.after}
        pageSize={reference.query.options.limit}
      />
    </CanvasSection>
  );
}

export function RecordChangesCard({ change }: { change: RecordChanges }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const api = useMemo(() => tableApi(workspace.id), [workspace.id]);
  const read = useTableDetail(api, change.tableId);
  const title =
    read.state.kind === 'ready' ? (read.state.data.applied?.definition.label ?? 'Changed rows') : 'Changed rows';
  const { show, update } = useCanvas();
  const open = () => show({ id: change.id, title, content: { kind: 'record-changes', change } });
  useEffect(() => {
    update(change.id, { title, content: { kind: 'record-changes', change } });
  }, [change, title, update]);
  return (
    <section aria-label="Changed rows">
      <ResultCard
        title={title}
        kind="Table"
        apps={[]}
        icon={<Database size={18} />}
        state="success"
        status={`${recordChangesSummary(change)} in ${title}.`}
        action={{ label: 'View changed rows', onClick: open }}
      />
    </section>
  );
}

export function RecordChangesCanvas({ change }: { change: RecordChanges }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const api = useMemo(() => tableApi(workspace.id), [workspace.id]);
  const read = useTableDetail(api, change.tableId);
  return (
    <TableRead state={read.state} refresh={read.refresh}>
      {state =>
        state.applied?.revision === change.revision ? (
          <ChangedRows
            key={change.id}
            change={change}
            table={{
              id: state.id,
              revision: state.applied.revision,
              definition: state.applied.definition,
              systemKind: state.systemKind,
            }}
            api={api}
          />
        ) : (
          <CanvasSection title="Table changed">
            <StatePanel
              kind="unavailable"
              title="These fields have changed"
              description="The table's fields changed after these rows were saved. Open the current table to see them."
            >
              <Button
                variant="outline"
                nativeButton={false}
                render={
                  <Link
                    to="/$workspaceSlug/tables/$tableId"
                    params={{ workspaceSlug: workspace.slug, tableId: change.tableId }}
                  />
                }
              >
                Open current table
              </Button>
              <Button variant="ghost" onClick={() => void read.refresh()}>
                Check again
              </Button>
            </StatePanel>
          </CanvasSection>
        )
      }
    </TableRead>
  );
}

function ChangedRows({
  change,
  recordIds,
  table,
  api,
}: {
  change?: RecordChanges;
  recordIds?: string[];
  table: TableDefinition;
  api: TableApi;
}) {
  const { workspace, sessionId } = workspaceRoute.useRouteContext();
  const scope = { id: workspace.id, slug: workspace.slug, sessionId };
  const ids = useMemo(() => recordIds ?? (change ? [...change.created, ...change.updated] : []), [change, recordIds]);
  const read = useTableRowsById(api, table, ids);
  const records = read.state.kind === 'ready' ? read.state.data : [];
  type RecordRow = { id: string; record: (typeof records)[number] } & Record<string, unknown>;
  const linked = useLinkedRows(
    api,
    records.map(record => record.values),
  );
  const files = useFileNames(
    workspace.id,
    fileIdsOf(records.map(record => record.values)),
    records.flatMap(record => record.unavailableFileIds),
  );
  const created = new Set(change?.created);
  const busy = read.state.kind === 'loading' || (read.state.kind === 'ready' && read.state.refreshing);
  const missing = read.state.kind === 'ready' ? ids.length - records.length : 0;
  const tableLink = (
    <Link to="/$workspaceSlug/tables/$tableId" params={{ workspaceSlug: workspace.slug, tableId: table.id }} />
  );
  return (
    <CanvasSection
      title={table.definition.label}
      actions={
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Refresh rows"
            aria-label="Refresh rows"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void read.refresh()}
          >
            <Refresh size={16} />
          </Button>
          <Button variant="outline" size="sm" nativeButton={false} render={tableLink}>
            <ArrowUpRight size={14} aria-hidden="true" />
            Open current table
          </Button>
        </>
      }
    >
      {change && (
        <ul aria-label="Changes" className="flex flex-wrap gap-1.5">
          {change.created.length > 0 && (
            <li>
              <Badge variant="success">
                <AddCircle size={12} />
                {change.created.length} added
              </Badge>
            </li>
          )}
          {change.updated.length > 0 && (
            <li>
              <Badge variant="info">
                <Edit2 size={12} />
                {change.updated.length} updated
              </Badge>
            </li>
          )}
        </ul>
      )}
      <TableRead state={read.state} refresh={read.refresh}>
        {rows =>
          rows.length === 0 ? (
            <StatePanel
              kind={ids.length ? 'unavailable' : 'empty'}
              heading="h3"
              title={ids.length ? 'Rows unavailable' : 'No rows returned'}
              description={
                ids.length
                  ? 'These rows were deleted or you no longer have access.'
                  : 'This read returned no rows. Open the table to browse current rows.'
              }
            >
              <Button variant="outline" nativeButton={false} render={tableLink}>
                Open current table
              </Button>
            </StatePanel>
          ) : (
            <div className="space-y-3">
              {missing > 0 && (
                <Alert>
                  <AlertDescription>
                    {missing === 1
                      ? '1 row was deleted or is no longer visible.'
                      : `${missing} rows were deleted or are no longer visible.`}
                  </AlertDescription>
                </Alert>
              )}
              <ReferenceRetry linked={linked} files={files} />
              <Table<RecordRow>
                aria-label={table.definition.label}
                data={rows.map(record => ({ id: record.id, record }))}
                getRowId={row => row.id}
                columns={[
                  ...(change
                    ? [
                        {
                          key: 'change',
                          header: 'Change',
                          cell: ({ record }) =>
                            created.has(record.id) ? (
                              <Badge variant="success">Added</Badge>
                            ) : (
                              <Badge variant="info">Updated</Badge>
                            ),
                        } satisfies TableColumn<RecordRow>,
                      ]
                    : []),
                  ...table.definition.fields.map((field): TableColumn<RecordRow> => ({
                    key: `field:${field.id}`,
                    header: field.label,
                    cell: ({ record }) => (
                      <TableValueView
                        compact
                        record={record}
                        systemKind={table.systemKind}
                        value={record.values[field.id]}
                        definition={table.definition}
                        fieldId={field.id}
                        linked={linked.state}
                        files={files.state}
                        unavailableFileIds={record.unavailableFileIds}
                        workspace={scope}
                      />
                    ),
                  })),
                ]}
                actions={({ record }) => (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title="Open row"
                    aria-label="Open row"
                    nativeButton={false}
                    render={
                      <Link
                        to="/$workspaceSlug/tables/$tableId"
                        params={{ workspaceSlug: workspace.slug, tableId: table.id }}
                        search={{ row: record.id }}
                      />
                    }
                  >
                    <ArrowUpRight size={14} />
                  </Button>
                )}
              />
            </div>
          )
        }
      </TableRead>
      <Disclosure title="Details">
        <dl className="space-y-1 text-xs text-muted-foreground">
          <dt className="font-medium text-foreground">Table</dt>
          <dd className="break-all">{table.id}</dd>
          {change && change.created.length > 0 && (
            <>
              <dt className="font-medium text-foreground">Added rows</dt>
              <dd className="break-all">{change.created.join(', ')}</dd>
            </>
          )}
          {change && change.updated.length > 0 && (
            <>
              <dt className="font-medium text-foreground">Updated rows</dt>
              <dd className="break-all">{change.updated.join(', ')}</dd>
            </>
          )}
          {!change && (
            <>
              <dt className="font-medium text-foreground">Rows</dt>
              <dd className="break-all">{ids.join(', ')}</dd>
            </>
          )}
        </dl>
      </Disclosure>
    </CanvasSection>
  );
}
