import { useMemo } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { AddIcon, DatabaseIcon } from '@tulipfarm/icons';
import { Button } from '@tulipfarm/sprout/button';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { TablesSample, StatePanel } from '@tulipfarm/sprout/state-panel';
import { RecordList } from '@tulipfarm/sprout/record-list';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { ToggleGroup, ToggleGroupItem } from '@tulipfarm/sprout/toggle-group';
import { useCursorPages } from '@/lib/use-cursor-pages';
import { TableRead } from './feedback';
import { useTableList } from './hooks';
import { tableApi, type TableListSort } from './api';
import { useUrlDraft } from './row-query';
import type { TableListOrder, TableListSearch } from './table-search';

const byName: TableListSort = { by: 'name', direction: 'asc' };
const recordCountLabel = (count: string) => (/^\d+$/.test(count) ? Number(count).toLocaleString('en-US') : count);
const listOrders: ReadonlyArray<{ value: TableListOrder; label: string }> = [
  { value: 'name', label: 'Name A–Z' },
  { value: '-name', label: 'Name Z–A' },
  { value: '-records', label: 'Most records' },
  { value: 'records', label: 'Fewest records' },
  { value: '-changed', label: 'Recently changed' },
  { value: 'changed', label: 'Least recently changed' },
];
const listSort = (order: TableListOrder): TableListSort => ({
  by: order.replace(/^-/, '') as TableListSort['by'],
  direction: order.startsWith('-') ? 'desc' : 'asc',
});

export function TableList({
  workspaceId,
  workspaceSlug,
  search,
  changeSearch,
}: {
  workspaceId: string;
  workspaceSlug: string;
  search: TableListSearch;
  changeSearch: (next: Partial<TableListSearch>) => void;
}) {
  const api = useMemo(() => tableApi(workspaceId), [workspaceId]);
  const query = (search.q ?? '').trim();
  const archived = search.archived === true;
  const order: TableListOrder = search.sort ?? 'name';
  const sort = order === 'name' ? byName : listSort(order);
  const pages = useCursorPages(JSON.stringify([query, archived, order]));
  const [draft, setDraft] = useUrlDraft(search.q ?? '', q => changeSearch({ q: q || undefined }));
  const read = useTableList(api, pages.after, query || undefined, sort, archived);
  const open = useNavigate();
  const shelf = archived ? 'archived' : 'active';
  return (
    <section className="space-y-6">
      <PageHeader
        title="Tables"
        description="Structured workspace data for customers, projects, and records. New tables open in chat."
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <SearchField
            id="table-search"
            label="Search tables"
            value={draft}
            maxLength={255}
            onChange={setDraft}
            placeholder="Search tables"
          />
          <ToggleGroup
            aria-label="Show tables"
            variant="outline"
            size="sm"
            spacing={0}
            value={[shelf]}
            onValueChange={value => {
              const next = value[0];
              if ((next === 'active' || next === 'archived') && next !== shelf)
                changeSearch({ archived: next === 'archived' || undefined });
            }}
          >
            <ToggleGroupItem value="active">Active</ToggleGroupItem>
            <ToggleGroupItem value="archived">Archived</ToggleGroupItem>
          </ToggleGroup>
          <Select
            value={order}
            onValueChange={value => {
              const next = listOrders.find(item => item.value === value)?.value;
              if (next) changeSearch({ sort: next === 'name' ? undefined : next });
            }}
          >
            <SelectTrigger size="sm" aria-label="Sort tables">
              <SelectValue>{listOrders.find(item => item.value === order)?.label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {listOrders.map(item => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          nativeButton={false}
          render={<Link to="/$workspaceSlug" params={{ workspaceSlug }} search={{ intent: 'create-table' }} />}
        >
          <AddIcon size="md" aria-hidden="true" />
          New table
        </Button>
      </div>
      <TableRead state={read.state} refresh={read.refresh}>
        {data => (
          <>
            {!data.tables.length ? (
              pages.after ? (
                <StatePanel
                  kind="empty"
                  icon={DatabaseIcon}
                  title={`No readable ${shelf} tables on this page`}
                  description="Return to the previous page to see your tables."
                >
                  <Button variant="outline" onClick={pages.previous}>
                    Previous tables
                  </Button>
                </StatePanel>
              ) : query ? (
                <StatePanel
                  kind="empty"
                  icon={DatabaseIcon}
                  title={`No ${archived ? 'archived ' : ''}tables match “${query}”`}
                  description="Search checks table names across this workspace. Try another name or clear the search."
                >
                  <Button variant="outline" onClick={() => changeSearch({ q: undefined })}>
                    Clear search
                  </Button>
                </StatePanel>
              ) : archived ? (
                <StatePanel
                  kind="empty"
                  icon={DatabaseIcon}
                  title="No archived tables"
                  description="Tables you archive appear here. Their fields and records are kept."
                >
                  <Button variant="outline" onClick={() => changeSearch({ archived: undefined })}>
                    Show active tables
                  </Button>
                </StatePanel>
              ) : (
                <StatePanel
                  kind="empty"
                  icon={DatabaseIcon}
                  title="No tables yet"
                  description="Tables organize structured records like customers, invoices, or inventory. Describe the fields you need in chat to create one. Ask an admin if you need read access."
                  sample={<TablesSample />}
                >
                  <Button
                    nativeButton={false}
                    render={
                      <Link to="/$workspaceSlug" params={{ workspaceSlug }} search={{ intent: 'create-table' }} />
                    }
                  >
                    <AddIcon size="md" aria-hidden="true" />
                    New table
                  </Button>
                </StatePanel>
              )
            ) : (
              <RecordList
                label="Tables"
                items={data.tables.map(table => ({
                  id: table.id,
                  title: table.definition.label,
                  records: table.recordCount,
                }))}
                values={table => [{ label: 'Records', value: recordCountLabel(table.records) }]}
                onItemOpen={table =>
                  void open({ to: '/$workspaceSlug/tables/$tableId', params: { workspaceSlug, tableId: table.id } })
                }
              />
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
