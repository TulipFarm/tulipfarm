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
  disabled,
}: {
  workspaceId: string;
  data: GovernanceSnapshot;
  disabled: boolean;
}) {
  const [membershipId, setMembershipId] = useState('');
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
  const locked =
    disabled ||
    write.state.kind === 'sending' ||
    write.state.kind === 'uncertain' ||
    read.state.kind !== 'ready' ||
    !!read.state.error ||
    read.state.refreshing;
  return (
    <section className="space-y-4 border-t border-border pt-6">
      <h2 className="text-sm font-medium">Individual table grants</h2>
      <p className="text-sm text-muted-foreground">
        Direct grants add to team permissions. Removing one grant does not remove access supplied by another team or
        grant. Grants belong to the current membership and do not return after leaving and rejoining.
      </p>
      <TableRead state={read.state} refresh={read.refresh}>
        {({ grants }) => {
          const has = (target: GrantInput['target']) =>
            grants.some(
              grant =>
                grant.membershipId === membershipId &&
                grant.target.kind === target.kind &&
                grant.target.id === target.id &&
                grant.target.permission === target.permission,
            );
          const toggle = (target: GrantInput['target'], granted: boolean) => {
            void write.submit({ membershipId, target, granted });
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
                            checked={has(target)}
                            disabled={locked}
                            onCheckedChange={value => toggle(target, value)}
                          />
                        </SettingsRow>
                      );
                    })}
                  </SettingsGroup>
                  {data.tables.map(table => (
                    <SettingsGroup key={table.id} title={table.name}>
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
                              checked={has(target)}
                              disabled={locked}
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
      <WriteFeedback
        state={write.state}
        checkStatus={() => void read.refresh()}
        retry={input => void write.submit(input)}
      />
      {write.state.kind === 'accepted' && (
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
