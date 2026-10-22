import { useState } from 'react';
import { z } from 'zod';
import {
  workspaceMemberLabel,
  workspaceMemberPreservedFields,
  workspaceMemberRestoredValues,
} from '@tulipfarm/tables/workspace-members';
import { Disclosure } from '@/components/disclosure';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Table, type TableColumn } from '@tulipfarm/sprout/table';
import { useCursorPages } from '@/lib/use-cursor-pages';
import { fileIdsOf, ReferenceRetry, TableValueView, useFileNames, type TableWorkspace } from './references';
import { TableRead, UnsavedChanges } from './feedback';
import { useLinkedRows, useTableRowHistory, useWorkspaceMembers } from './hooks';
import { RecordMutationFeedback, useRecordMutation } from './record-mutation';
import type { DeletedRecord, RecordHistoryEntry, RowPermissions, TableDataRow, TableDefinition, TableApi } from './api';

const actorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), userId: z.string() }),
  z.object({ kind: z.literal('agent'), agentId: z.string() }),
  z.object({ kind: z.literal('system'), operation: z.enum(['workspace-member-profile', 'workspace-member-access']) }),
]);
/** Each column reads the field id; the cells look up current, historical and restored values. */
type ValueRow = Record<'id' | 'field' | 'current' | 'historical' | 'restored', string>;

function actorLabel(actor: unknown) {
  const parsed = actorSchema.safeParse(actor);
  if (!parsed.success) return 'Actor details unavailable';
  if (parsed.data.kind === 'system')
    return parsed.data.operation === 'workspace-member-profile' ? 'TulipFarm profile sync' : 'Workspace access update';
  return parsed.data.kind === 'human' ? `Person ${parsed.data.userId}` : `Agent ${parsed.data.agentId}`;
}

export function RecordHistory({
  table,
  record,
  permissions,
  api,
  workspace,
  disabled,
  close,
  saved,
  refresh,
}: {
  table: TableDefinition;
  record: TableDataRow | DeletedRecord;
  permissions: RowPermissions;
  api: TableApi;
  workspace: TableWorkspace;
  disabled: boolean;
  close: () => void;
  saved: () => void;
  refresh: () => Promise<void>;
}) {
  const pages = useCursorPages();
  const read = useTableRowHistory(api, table.id, record.id, pages.after);
  const [selection, setSelection] = useState<{ entry: RecordHistoryEntry; version: 'before' | 'after' } | null>(null);
  const mutation = useRecordMutation(api, saved);
  const locked =
    disabled || mutation.locked || read.state.kind !== 'ready' || !!read.state.error || read.state.refreshing;
  const values = selection
    ? selection.version === 'before'
      ? selection.entry.before_values
      : selection.entry.values
    : null;
  const currentValues = 'values' in record ? record.values : null;
  const isMember = table.systemKind === 'workspace-members';
  const members = useWorkspaceMembers(workspace.id, table.id, { ids: [record.id] }, isMember && currentValues !== null);
  const member =
    members.state.kind === 'ready' ? members.state.data.members.find(item => item.id === record.id) : undefined;
  const memberReady =
    !isMember ||
    currentValues === null ||
    (members.state.kind === 'ready' &&
      !members.state.error &&
      !members.state.refreshing &&
      member?.token === record.token);
  const restoredValues =
    values && memberReady
      ? isMember
        ? workspaceMemberRestoredValues(values, currentValues, member?.accountLinked ?? false)
        : values
      : null;
  const preserved = new Set<string>(
    isMember && memberReady ? workspaceMemberPreservedFields(member?.accountLinked ?? false) : [],
  );
  const refreshReview = async () => {
    await refresh();
    await members.refresh();
  };
  const canRestore = currentValues ? permissions.update : permissions.create;
  const linked = useLinkedRows(api, [currentValues, values]);
  const currentUnavailable = 'unavailableFileIds' in record ? record.unavailableFileIds : [];
  const historicalUnavailable = selection?.entry.unavailable_file_ids ?? [];
  const files = useFileNames(workspace.id, fileIdsOf([currentValues, values]), [
    ...currentUnavailable,
    ...historicalUnavailable,
  ]);
  return (
    <section aria-label="Row history" className="space-y-4 rounded-xl border border-border p-4">
      <UnsavedChanges dirty={mutation.locked} />
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="break-all text-base font-medium">
          History for{' '}
          {isMember ? (currentValues ? workspaceMemberLabel(currentValues) : 'workspace member') : `row ${record.id}`}
        </h3>
        <Button variant="outline" disabled={mutation.locked} onClick={close}>
          Close history
        </Button>
      </div>
      {isMember && (
        <Disclosure title="Details">
          <p className="break-all text-sm text-muted-foreground">Member ID: {record.id}</p>
        </Disclosure>
      )}
      <p className="text-sm text-muted-foreground">
        Historical values are recoverable for 30 days. Restoring creates a new permission-checked change, not a rewind
        of the audit history.
      </p>
      <TableRead state={read.state} refresh={read.refresh}>
        {entries => (
          <>
            {!entries.length ? (
              <StatePanel
                kind="empty"
                title="No history on this page"
                description="Row changes appear here after they are applied. Return to rows to see the current values."
              />
            ) : (
              <ol className="space-y-4">
                {entries.map(entry => (
                  <li
                    key={entry.id}
                    id={`record-history-${entry.id}`}
                    className="space-y-2 border-t border-border pt-3"
                  >
                    <p className="text-sm font-medium">
                      {entry.operation} · {new Date(entry.created_at).toLocaleString()} · {entry.outcome}
                    </p>
                    <p className="break-all text-sm">{actorLabel(entry.actor)}</p>
                    <p className="break-all text-sm">
                      Changed fields{' '}
                      {entry.field_ids
                        .map(id => table.definition.fields.find(field => field.id === id)?.label ?? id)
                        .join(', ') || 'None'}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {Date.parse(entry.recoverable_until) > Date.now()
                        ? `Recovery ends ${new Date(entry.recoverable_until).toLocaleString()}.`
                        : 'Recovery expired. Audit metadata remains; old values are no longer available.'}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {entry.before_values && (
                        <Button
                          variant="outline"
                          disabled={locked || Date.parse(entry.recoverable_until) <= Date.now()}
                          onClick={() => setSelection({ entry, version: 'before' })}
                        >
                          Review values before {entry.operation}
                        </Button>
                      )}
                      {entry.values && (
                        <Button
                          variant="outline"
                          disabled={locked || Date.parse(entry.recoverable_until) <= Date.now()}
                          onClick={() => setSelection({ entry, version: 'after' })}
                        >
                          Review values after {entry.operation}
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {(pages.after || entries.length === 50) && (
              <nav aria-label="History pages" className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={locked || !pages.after}
                  onClick={() => {
                    setSelection(null);
                    pages.previous();
                  }}
                >
                  Previous history
                </Button>
                <Button
                  variant="outline"
                  disabled={locked || entries.length !== 50}
                  onClick={() => {
                    const last = entries.at(-1);
                    if (last) {
                      setSelection(null);
                      pages.next(last.id);
                    }
                  }}
                >
                  Next history
                </Button>
              </nav>
            )}
          </>
        )}
      </TableRead>
      {isMember && currentValues && (
        <TableRead state={members.state} refresh={refreshReview}>
          {() =>
            !member ? (
              <StatePanel
                kind="unavailable"
                heading="h4"
                title="Member unavailable"
                description="The member was deleted or your access changed. Reload before restoring."
              >
                <Button variant="outline" onClick={() => void refreshReview()}>
                  Reload member
                </Button>
              </StatePanel>
            ) : member.token !== record.token ? (
              <StatePanel
                kind="error"
                heading="h4"
                title="Member changed"
                description="Reload the current member and review the values again before restoring."
              >
                <Button variant="outline" onClick={() => void refreshReview()}>
                  Reload member
                </Button>
              </StatePanel>
            ) : null
          }
        </TableRead>
      )}
      {selection && values && read.state.kind === 'ready' && !read.state.error && (
        <section className="space-y-3">
          <h4 className="text-sm font-medium">{canRestore ? 'Review restoration' : 'Historical values'}</h4>
          {canRestore ? (
            <p className="text-sm">
              {isMember
                ? 'The After restore column shows the values that will be saved.'
                : currentValues
                  ? 'These historical values will replace the current row values shown below.'
                  : 'This row is deleted. Restoration will recreate it with the reviewed historical values.'}{' '}
              Changes since this row was loaded will block restoration. Values must still fit the active fields and
              referenced-file permissions.
            </p>
          ) : (
            <p className="text-sm">
              {currentValues
                ? 'You can review these values, but restoring them needs permission to update rows.'
                : 'You can review these values, but restoring a deleted row needs permission to create rows.'}{' '}
              A workspace admin can grant it.
            </p>
          )}
          {isMember && (
            <p className="text-sm text-muted-foreground">
              Only editable fields are restored. Account email and workspace access stay current. A linked account's
              name and photo also stay current. Restoring a deleted person grants no workspace access.
            </p>
          )}
          <ReferenceRetry linked={linked} files={files} />
          <Table
            aria-label="Field values"
            data={[...new Set([...Object.keys(currentValues ?? {}), ...Object.keys(values)])].map((id): ValueRow => ({
              id,
              field: id,
              current: id,
              historical: id,
              restored: id,
            }))}
            getRowId={row => row.id}
            columns={[
              {
                key: 'field',
                header: 'Field',
                cell: ({ id }) => table.definition.fields.find(field => field.id === id)?.label ?? id,
              },
              {
                key: 'current',
                header: 'Current',
                cell: ({ id }) =>
                  currentValues ? (
                    <TableValueView
                      record={{ id: record.id, values: currentValues }}
                      systemKind={table.systemKind}
                      value={currentValues[id]}
                      definition={table.definition}
                      fieldId={id}
                      linked={linked.state}
                      files={files.state}
                      unavailableFileIds={currentUnavailable}
                      workspace={workspace}
                    />
                  ) : (
                    'Deleted'
                  ),
              },
              {
                key: 'historical',
                header: isMember || !canRestore ? 'Historical' : 'Restore',
                cell: ({ id }) => (
                  <TableValueView
                    record={{ id: record.id, values }}
                    systemKind={table.systemKind}
                    value={values[id]}
                    definition={table.definition}
                    fieldId={id}
                    linked={linked.state}
                    files={files.state}
                    unavailableFileIds={historicalUnavailable}
                    workspace={workspace}
                  />
                ),
              },
              ...(isMember && canRestore
                ? [
                    {
                      key: 'restored',
                      header: 'After restore',
                      cell: ({ id }) =>
                        restoredValues ? (
                          <>
                            <TableValueView
                              record={{ id: record.id, values: restoredValues }}
                              systemKind={table.systemKind}
                              value={restoredValues[id]}
                              definition={table.definition}
                              fieldId={id}
                              linked={linked.state}
                              files={files.state}
                              unavailableFileIds={preserved.has(id) ? currentUnavailable : historicalUnavailable}
                              workspace={workspace}
                            />
                            {preserved.has(id) && (
                              <span className="block text-xs text-muted-foreground">
                                {currentValues ? 'Kept current' : 'No account access'}
                              </span>
                            )}
                          </>
                        ) : (
                          'Not ready'
                        ),
                    } satisfies TableColumn<ValueRow>,
                  ]
                : []),
            ]}
          />
          {canRestore && (
            <Button
              disabled={locked || !memberReady || Date.parse(selection.entry.recoverable_until) <= Date.now()}
              aria-busy={mutation.state.kind === 'sending'}
              onClick={() =>
                void mutation.submit({
                  kind: 'restore',
                  requestId: crypto.randomUUID(),
                  tableId: table.id,
                  recordId: record.id,
                  revision: table.revision,
                  expectedToken: record.token,
                  historyId: selection.entry.id,
                  version: selection.version,
                })
              }
            >
              {mutation.state.kind === 'sending' ? 'Restoring row…' : 'Restore reviewed values'}
            </Button>
          )}
        </section>
      )}
      <RecordMutationFeedback mutation={mutation} refresh={refresh} />
    </section>
  );
}
