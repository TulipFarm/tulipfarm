import { useState } from 'react';
import { EntityAvatar } from '@tulipfarm/sprout/avatar';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@tulipfarm/sprout/sheet';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { AvatarImagePicker } from '@/features/avatar/image-picker';
import { apiOrigin } from '@/lib/auth';
import { workspaceMemberFields, workspaceMemberLabel } from '@tulipfarm/tables/workspace-members';
import { TableRequestError } from './request-state';
import {
  workspaceMembersApi,
  type TableApi,
  type TableDataRow,
  type TableDefinition,
  type WorkspaceMemberState,
} from './api';
import { TableRead, UnsavedChanges } from './feedback';
import { useTableRow, useWorkspaceMembers } from './hooks';
import { RecordMutationFeedback, useRecordMutation } from './record-mutation';
import type { TableWorkspace } from './references';
import type { TableValue } from './review-contracts';

export function memberPhotoSource(workspaceId: string, value: TableValue | undefined) {
  return value?.kind === 'text' && value.value.startsWith(`/v1/workspaces/${workspaceId}/workspace-members/`)
    ? `${apiOrigin}${value.value}`
    : null;
}

export function MemberPhoto({
  workspaceId,
  value,
  record,
}: {
  workspaceId: string;
  value: TableValue | undefined;
  record?: Pick<TableDataRow, 'id' | 'values'> | undefined;
}) {
  const image = memberPhotoSource(workspaceId, value);
  if (value !== null && value !== undefined && !image)
    return <span className="text-sm text-muted-foreground">Photo unavailable</span>;
  return (
    <EntityAvatar
      seed={record?.id ?? image ?? 'workspace-member'}
      name={record ? workspaceMemberLabel(record.values) : 'Member'}
      image={image}
      size="sm"
    />
  );
}

const profileLabels: Record<WorkspaceMemberState['profile'], string> = {
  manual: 'Managed here',
  current: 'Profile synced',
  pending: 'Profile pending',
  failed: 'Sync needs retry',
  'repair-required': 'Member setup needed',
};

export function MemberSyncStatus({
  workspaceId,
  member,
  refresh,
}: {
  workspaceId: string;
  member: WorkspaceMemberState;
  refresh: () => Promise<void>;
}) {
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  async function retry() {
    if (sending) return;
    setSending(true);
    setMessage('');
    setFailed(false);
    try {
      await workspaceMembersApi(workspaceId).retry(member.id);
      setMessage('Profile sync queued. It can finish after you leave. Check status to see the result.');
      await refresh();
    } catch (error) {
      setFailed(true);
      setMessage(
        error instanceof TableRequestError
          ? error.message
          : 'Could not confirm the sync request. Check status before trying again.',
      );
    } finally {
      setSending(false);
    }
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={
            member.profile === 'failed' || member.profile === 'repair-required'
              ? 'warning'
              : member.profile === 'current'
                ? 'success'
                : 'secondary'
          }
        >
          {profileLabels[member.profile]}
        </Badge>
        {member.canRetry && (
          <Button variant="outline" size="sm" disabled={sending} aria-busy={sending} onClick={() => void retry()}>
            {sending ? 'Queuing profile sync…' : member.profile === 'failed' ? 'Retry profile sync' : 'Sync profile'}
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={sending} onClick={() => void refresh()}>
          Check status
        </Button>
      </div>
      {message && (
        <p
          role={failed ? 'alert' : 'status'}
          className={`text-sm ${failed ? 'text-destructive' : 'text-muted-foreground'}`}
        >
          {message}
        </p>
      )}
    </div>
  );
}

export function MemberProfilePanel({
  record,
  table,
  api,
  workspace,
  close,
  refresh,
}: {
  record: TableDataRow;
  table: TableDefinition;
  api: TableApi;
  workspace: TableWorkspace;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const read = useWorkspaceMembers(workspace.id, table.id, { ids: [record.id] });
  const row = useTableRow(api, table, record.id);
  const current = row.state.kind === 'ready' ? row.state.data : null;
  const [notice, setNotice] = useState('');
  const reload = async () => {
    await read.refresh();
    await row.refresh();
    await refresh();
  };
  const write = useRecordMutation(api, () => {
    setNotice('Member photo saved.');
    void reload();
  });
  const locked =
    write.locked ||
    row.state.kind !== 'ready' ||
    !!row.state.error ||
    row.state.refreshing ||
    read.state.kind !== 'ready' ||
    !!read.state.error ||
    read.state.refreshing;
  return (
    <Sheet
      open
      onOpenChange={open => {
        if (!open && !write.locked) close();
      }}
    >
      <SheetContent size="lg" showCloseButton={!write.locked}>
        <SheetHeader>
          <SheetTitle>Member profile</SheetTitle>
          <SheetDescription>{workspaceMemberLabel(current?.values ?? record.values)}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-6">
          <UnsavedChanges dirty={write.locked} />
          <TableRead state={read.state} refresh={reload}>
            {data => {
              const member = data.members[0];
              return !member ? (
                <StatePanel
                  kind="unavailable"
                  title="Member unavailable"
                  description="This member was deleted or your access changed."
                />
              ) : (
                <>
                  <MemberSyncStatus workspaceId={workspace.id} member={member} refresh={reload} />
                  <p className="text-sm text-muted-foreground">
                    {member.accountLinked
                      ? 'Name and photo follow this person’s TulipFarm profile. Business fields stay in this table.'
                      : 'This person has no active account link. An editor can manage their name and photo here. This does not grant workspace access.'}
                  </p>
                  <TableRead state={row.state} refresh={reload}>
                    {loaded =>
                      !loaded ? (
                        <StatePanel
                          kind="unavailable"
                          title="Profile not ready"
                          description="The member’s row is not available yet. Check profile status again."
                        />
                      ) : member.canEditProfile ? (
                        <section aria-label="Member photo" className="space-y-3">
                          <h3 className="text-sm font-medium">Photo</h3>
                          <AvatarImagePicker
                            seed={loaded.id}
                            name={workspaceMemberLabel(loaded.values)}
                            image={memberPhotoSource(workspace.id, loaded.values[workspaceMemberFields.photo])}
                            shape="circle"
                            disabled={locked}
                            onChange={image => {
                              if (locked) return;
                              setNotice('');
                              void write.submit({
                                kind: 'member-photo',
                                requestId: crypto.randomUUID(),
                                tableId: table.id,
                                revision: table.revision,
                                recordId: loaded.id,
                                expectedToken: loaded.token,
                                image,
                              });
                            }}
                          />
                          <p className="text-sm text-muted-foreground">
                            PNG, JPEG, or WebP, up to 2 MB. Resized to 128 px. Photo changes save separately from
                            business fields.
                          </p>
                        </section>
                      ) : (
                        <MemberPhoto
                          workspaceId={workspace.id}
                          record={loaded}
                          value={loaded.values[workspaceMemberFields.photo]}
                        />
                      )
                    }
                  </TableRead>
                </>
              );
            }}
          </TableRead>
          {notice && (
            <p role="status" className="text-sm">
              {notice}
            </p>
          )}
          <RecordMutationFeedback mutation={write} refresh={reload} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
