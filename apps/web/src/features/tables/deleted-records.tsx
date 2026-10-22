import { useState } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Table } from '@tulipfarm/sprout/table';
import { useCursorPages } from '@/lib/use-cursor-pages';
import { TableRead } from './feedback';
import { RecordHistory } from './record-history';
import { useTableDeletedRows } from './hooks';
import type { DeletedRecord, RowPermissions, TableDefinition, TableApi } from './api';
import type { TableWorkspace } from './references';

export function DeletedRecords({
  table,
  permissions,
  api,
  workspace,
  disabled,
}: {
  table: TableDefinition;
  permissions: RowPermissions;
  api: TableApi;
  workspace: TableWorkspace;
  disabled: boolean;
}) {
  const pages = useCursorPages();
  const read = useTableDeletedRows(api, table.id, pages.after);
  const [selection, setSelection] = useState<DeletedRecord | null>(null);
  const [message, setMessage] = useState('');
  const locked = disabled || read.state.kind !== 'ready' || read.state.refreshing || !!read.state.error;
  const refresh = async () => {
    await read.refresh();
  };
  const saved = () => {
    setSelection(null);
    setMessage('Row restored.');
  };
  return (
    <section aria-label="Deleted rows" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Review retained history before restoring a deleted row. File access and current field rules are checked again
          when restoring.
        </p>
        <Button
          variant="outline"
          disabled={
            !!selection || read.state.kind === 'loading' || (read.state.kind === 'ready' && read.state.refreshing)
          }
          onClick={() => void refresh()}
        >
          Refresh deleted rows
        </Button>
      </div>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <TableRead state={read.state} refresh={read.refresh}>
        {data => (
          <>
            {!data.records.length ? (
              <StatePanel
                kind="empty"
                title="No deleted rows on this page"
                description="Deleted rows appear here with their recovery deadline. Close this panel to return to active rows."
              />
            ) : (
              <Table
                aria-label="Deleted row list"
                data={data.records}
                getRowId={record => record.id}
                columns={[
                  {
                    key: 'id',
                    header: 'Row',
                    cell: record => <span className="break-all font-mono text-xs">{record.id}</span>,
                  },
                  { key: 'deletedAt', header: 'Deleted', cell: record => new Date(record.deletedAt).toLocaleString() },
                  {
                    key: 'recoverableUntil',
                    header: 'Recovery',
                    cell: record =>
                      record.recoverableUntil && Date.parse(record.recoverableUntil) > Date.now()
                        ? `Until ${new Date(record.recoverableUntil).toLocaleString()}`
                        : 'No retained values remain',
                  },
                  {
                    key: 'token',
                    header: 'Action',
                    cell: record => (
                      <Button
                        variant="outline"
                        disabled={locked || !!selection}
                        onClick={() => {
                          setMessage('');
                          setSelection(record);
                        }}
                      >
                        Review deleted row {record.id.slice(0, 8)}
                      </Button>
                    ),
                  },
                ]}
              />
            )}
            {(pages.after || data.nextCursor) && (
              <nav aria-label="Deleted row pages" className="flex gap-2">
                <Button variant="outline" disabled={locked || !!selection || !pages.after} onClick={pages.previous}>
                  Previous deleted rows
                </Button>
                <Button
                  variant="outline"
                  disabled={locked || !!selection || !data.nextCursor}
                  onClick={() => {
                    if (data.nextCursor) pages.next(data.nextCursor);
                  }}
                >
                  Next deleted rows
                </Button>
              </nav>
            )}
          </>
        )}
      </TableRead>
      {selection && read.state.kind === 'ready' && (
        <RecordHistory
          key={`${selection.id}/${selection.token}`}
          table={table}
          permissions={permissions}
          record={selection}
          api={api}
          workspace={workspace}
          disabled={locked}
          close={() => {
            setSelection(null);
            void refresh();
          }}
          saved={saved}
          refresh={refresh}
        />
      )}
    </section>
  );
}
