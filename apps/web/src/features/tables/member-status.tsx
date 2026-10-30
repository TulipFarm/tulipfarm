import { useState } from 'react';
import { Disclosure } from '@/components/disclosure';
import { Button } from '@tulipfarm/sprout/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@tulipfarm/sprout/sheet';
import { useCursorPages } from '@/lib/use-cursor-pages';
import { workspaceMemberLabel } from '@tulipfarm/tables/workspace-members';
import { TableRead } from './feedback';
import { useTableRowsById, useWorkspaceMembers } from './hooks';
import { MemberSyncStatus } from './member-profile';
import { RecordEditor } from './record-editor';
import type { TableApi, TableDefinition, WorkspaceMemberState } from './api';
import type { TableWorkspace } from './references';

export function MemberDirectoryStatus({
  table,
  api,
  workspace,
  refresh,
}: {
  table: TableDefinition;
  api: TableApi;
  workspace: TableWorkspace;
  refresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Profile sync status
      </Button>
      {open && (
        <MemberStatusPanel
          table={table}
          api={api}
          workspace={workspace}
          refresh={refresh}
          close={() => setOpen(false)}
        />
      )}
    </>
  );
}

function MemberStatusPanel({
  table,
  api,
  workspace,
  refresh,
  close,
}: {
  table: TableDefinition;
  api: TableApi;
  workspace: TableWorkspace;
  refresh: () => Promise<void>;
  close: () => void;
}) {
  const pages = useCursorPages(table.id);
  const read = useWorkspaceMembers(workspace.id, table.id, {
    attention: true,
    ...(pages.after ? { after: pages.after } : {}),
  });
  const [repair, setRepair] = useState<WorkspaceMemberState | null>(null);
  const reload = async () => {
    await read.refresh();
    await refresh();
  };
  return (
    <>
      <Sheet
        open
        onOpenChange={open => {
          if (!open && !repair) close();
        }}
      >
        <SheetContent size="lg">
          <SheetHeader>
            <SheetTitle>Member profile status</SheetTitle>
            <SheetDescription>
              Pending updates are not missing people. Check status after a sync, or complete a member whose access was
              removed before setup finished.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-6">
            <TableRead state={read.state} refresh={reload}>
              {data => (
                <>
                  <p className="text-sm">
                    {data.sync.pending} pending · {data.sync.failed} need retry · {data.sync.repairRequired} need setup
                  </p>
                  {!data.members.length ? (
                    <p className="text-sm text-muted-foreground">
                      {pages.after
                        ? 'No profiles need attention on this page.'
                        : 'No member profiles need attention right now.'}
                    </p>
                  ) : (
                    <MemberStatusRows
                      members={data.members}
                      table={table}
                      api={api}
                      workspace={workspace}
                      refresh={reload}
                      repair={setRepair}
                    />
                  )}
                  {(pages.after || data.nextCursor) && (
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" disabled={!pages.after} onClick={pages.previous}>
                        Previous profiles
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!data.nextCursor}
                        onClick={() => {
                          if (data.nextCursor) pages.next(data.nextCursor);
                        }}
                      >
                        Next profiles
                      </Button>
                    </div>
                  )}
                  <Button variant="outline" onClick={() => void reload()}>
                    Check profile status
                  </Button>
                </>
              )}
            </TableRead>
          </div>
        </SheetContent>
      </Sheet>
      {repair && (
        <RecordEditor
          key={repair.id}
          record={null}
          repair={repair}
          table={table}
          api={api}
          workspace={workspace}
          disabled={!repair.canRepair}
          close={() => setRepair(null)}
          saved={() => {
            setRepair(null);
            void reload();
          }}
          refresh={reload}
        />
      )}
    </>
  );
}

function MemberStatusRows({
  members,
  table,
  api,
  workspace,
  refresh,
  repair,
}: {
  members: WorkspaceMemberState[];
  table: TableDefinition;
  api: TableApi;
  workspace: TableWorkspace;
  refresh: () => Promise<void>;
  repair: (member: WorkspaceMemberState) => void;
}) {
  const rows = useTableRowsById(
    api,
    table,
    members.filter(member => member.materialized).map(member => member.id),
  );
  return (
    <TableRead state={rows.state} refresh={rows.refresh}>
      {records => (
        <ul className="divide-y divide-border">
          {members.map(member => {
            const row = records.find(record => record.id === member.id);
            return (
              <li key={member.id} className="space-y-3 py-4">
                <p className="break-words text-sm font-medium">
                  {row
                    ? workspaceMemberLabel(row.values)
                    : member.materialized
                      ? 'Member row unavailable'
                      : 'Member profile not ready'}
                </p>
                <MemberSyncStatus member={member} workspaceId={workspace.id} refresh={refresh} />
                {member.canRepair && (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Access was removed before this profile was ready. Enter the person’s business details to keep the
                      same member identity. This does not restore access.
                    </p>
                    <Button variant="outline" size="sm" onClick={() => repair(member)}>
                      Complete member
                    </Button>
                  </>
                )}
                <Disclosure title="Details">
                  <p className="break-all text-xs text-muted-foreground">Member ID: {member.id}</p>
                </Disclosure>
              </li>
            );
          })}
        </ul>
      )}
    </TableRead>
  );
}
