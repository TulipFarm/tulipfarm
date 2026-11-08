import { useState } from 'react';
import {
  tableGrantPermissionSchema,
  type GovernanceSnapshot,
  type GrantInput,
} from '@tulipfarm/workspaces/governance-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Label } from '@tulipfarm/sprout/label';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { SettingsGroup, SettingsRow } from '@tulipfarm/sprout/settings-list';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { tableLabels } from '@/features/governance/table-labels';
import {
  changesNotSaved,
  othersNotSaved,
  savingStatus,
  useGrantQueue,
  waitingStatus,
} from '@/features/governance/grant-queue';
import { changeGovernance, GovernanceRequestError, governanceError } from '@/lib/governance';
import { TableRequestError } from './request-state';
import { TableRead, WriteFeedback } from './feedback';
import { useTablePersonGrants } from './hooks';
import { useTableChanges } from './changes';
import { useTableWrite } from './use-table-write';

const labels = {
  'table.schema.manage': 'Manage schema',
  'table.row.create': 'Create rows',
  'table.row.read': 'Read rows',
  'table.row.update': 'Update rows',
  'table.row.delete': 'Delete rows',
};
type PersonGrant = { membershipId: string; target: GrantInput['target']; granted: boolean };

export function PersonGrants({
  workspaceId,
  data,
  busy,
  stale,
}: {
  workspaceId: string;
  data: GovernanceSnapshot;
  busy: boolean;
  stale: boolean;
}) {
  const [membershipId, setMembershipId] = useState('');
  const [feedback, setFeedback] = useState('');
  const read = useTablePersonGrants(workspaceId);
  const changes = useTableChanges();
  const write = useTableWrite(
    async (input: PersonGrant) => {
      try {
        await changeGovernance(workspaceId, '/person-grants', 'PUT', input);
      } catch (error) {
        if (error instanceof GovernanceRequestError)
          throw new TableRequestError(error.status, error.code, governanceError(error));
        throw error;
      }
      await changes.grants(input.membershipId);
      await read.refresh();
      window.dispatchEvent(new Event('tulipfarm:workspace-access-changed'));
    },
    () => {},
  );
  const selected = data.members.find(member => member.id === membershipId);
  const names = tableLabels(data.tables, data.teams);
  const saved = (holder: string, target: GrantInput['target']) =>
    read.state.kind === 'ready' &&
    read.state.data.grants.some(
      grant =>
        grant.membershipId === holder &&
        grant.target.kind === target.kind &&
        grant.target.id === target.id &&
        grant.target.permission === target.permission,
    );
  const grantLabel = (target: GrantInput['target']) =>
    target.kind === 'table'
      ? `${labels[target.permission].toLowerCase()} for ${names.get(target.id) ?? 'this table'}`
      : `create tables owned by ${data.teams.find(team => team.id === target.id)?.name ?? 'this team'}`;
  const unavailable = stale || write.state.kind === 'uncertain' || read.state.kind !== 'ready' || !!read.state.error;
  const grantQueue = useGrantQueue({
    saved,
    save: entry => write.submit({ membershipId: entry.holder, target: entry.target, granted: entry.granted }),
    wait: busy || write.state.kind === 'sending' || (read.state.kind === 'ready' && read.state.refreshing),
    stale: unavailable,
    settled: result =>
      setFeedback(
        !result.entry ? changesNotSaved(result.dropped) : result.dropped ? othersNotSaved(result.dropped) : '',
      ),
  });
  const locked = unavailable || grantQueue.pending;
  const status = grantQueue.saving
    ? savingStatus(grantLabel(grantQueue.saving.target), grantQueue.waiting)
    : grantQueue.waiting
      ? waitingStatus(grantQueue.waiting)
      : '';
  return (
    <section className="space-y-4 border-t border-border pt-6">
      <h2 className="text-sm font-medium">Individual table grants</h2>
      <p className="text-sm text-muted-foreground">
        Direct grants add to team permissions. Removing one grant does not remove access supplied by another team or
        grant. Grants belong to the current membership and do not return after leaving and rejoining.
      </p>
      {status && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Spinner aria-hidden="true" />
          {status}
        </p>
      )}
      <TableRead state={read.state} refresh={read.refresh}>
        {() => {
          const toggle = (target: GrantInput['target'], granted: boolean) => {
            if (selected) grantQueue.toggle(membershipId, selected.name, target, granted);
          };
          return (
            <div className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="grant-person">Person receiving access</Label>
                <Select
                  value={selected?.id ?? ''}
                  disabled={locked}
                  onValueChange={value => setMembershipId(value ?? '')}
                >
                  <SelectTrigger id="grant-person">
                    <SelectValue>{selected ? `${selected.name} (${selected.email})` : 'Select a person'}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Select a person</SelectItem>
                    {data.members.map(member => (
                      <SelectItem key={member.id} value={member.id}>
                        {member.name} ({member.email})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {selected?.role === 'admin' && (
                <p className="text-sm">
                  Workspace admins already have access to all business tables. These grants apply if their role changes.
                </p>
              )}
              {selected && (
                <>
                  <SettingsGroup title="Create tables for a team">
                    {data.teams.map(team => {
                      const target = {
                        kind: 'collection',
                        id: team.id,
                        permission: 'table.create',
                      } satisfies GrantInput['target'];
                      return (
                        <SettingsRow
                          key={team.id}
                          label={<Label htmlFor={`person-create-${team.id}`}>{team.name}</Label>}
                        >
                          <Checkbox
                            id={`person-create-${team.id}`}
                            checked={grantQueue.checked(membershipId, target)}
                            disabled={unavailable}
                            onCheckedChange={value => toggle(target, value)}
                          />
                        </SettingsRow>
                      );
                    })}
                  </SettingsGroup>
                  {data.tables.map(table => (
                    <SettingsGroup
                      key={table.id}
                      title={
                        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="min-w-0 wrap-anywhere">{names.get(table.id) ?? table.name}</span>
                          {grantQueue.tablePending(membershipId, table.id) && (
                            <span
                              aria-hidden="true"
                              className="flex shrink-0 items-center gap-2 font-normal text-muted-foreground"
                            >
                              <Spinner />
                              Saving…
                            </span>
                          )}
                        </span>
                      }
                      titleId={`person-table-${table.id}-heading`}
                    >
                      {tableGrantPermissionSchema.options.map(permission => {
                        const target = { kind: 'table', id: table.id, permission } satisfies GrantInput['target'];
                        return (
                          <SettingsRow
                            key={permission}
                            label={<Label htmlFor={`person-${table.id}-${permission}`}>{labels[permission]}</Label>}
                            description={
                              permission === 'table.schema.manage'
                                ? 'Schema authority does not grant row reads or data changes.'
                                : undefined
                            }
                          >
                            <Checkbox
                              id={`person-${table.id}-${permission}`}
                              checked={grantQueue.checked(membershipId, target)}
                              disabled={unavailable}
                              onCheckedChange={value => toggle(target, value)}
                            />
                          </SettingsRow>
                        );
                      })}
                    </SettingsGroup>
                  ))}
                </>
              )}
            </div>
          );
        }}
      </TableRead>
      {write.state.kind !== 'sending' && (
        <WriteFeedback
          state={write.state}
          checkStatus={() => void read.refresh()}
          retry={input => void write.submit(input)}
        />
      )}
      {feedback && !grantQueue.pending && (
        <p role="status" className="text-sm">
          {feedback}
        </p>
      )}
      {write.state.kind === 'accepted' && !grantQueue.pending && (
        <p role="status" className="text-sm">
          Individual grant saved.
        </p>
      )}
      {write.state.kind === 'rejected' && (
        <Button variant="outline" onClick={() => void read.refresh()}>
          Reload individual grants
        </Button>
      )}
    </section>
  );
}
