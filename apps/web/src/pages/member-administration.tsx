import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { GovernanceSnapshot } from '@tulipfarm/workspaces/governance-contracts';
import { User } from 'reicon-react/icons/User';
import { MembersSample } from '@/components/empty-samples';
import { Button } from '@tulipfarm/sprout/button';
import { Badge } from '@tulipfarm/sprout/badge';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Table } from '@tulipfarm/sprout/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@tulipfarm/sprout/dialog';

export type GovernanceChange = (
  path: string,
  method: string,
  body?: unknown,
) => Promise<
  | 'saved'
  | 'rejected'
  | 'retired'
  | 'uncertain'
  | 'team-details-conflict'
  | 'duplicate-team-name'
  | 'invalid-team-name'
  | 'invalid-team-description'
  | 'team-owns-tables'
  | 'team-owns-agents'
  | 'team-owns-integrations'
>;
export function MemberAdministration({
  data,
  busy,
  change,
  recovery,
}: {
  data: GovernanceSnapshot;
  busy: boolean;
  change: GovernanceChange;
  recovery: ReactNode;
}) {
  const [search, setSearch] = useState('');
  const admins = data.members.filter(member => member.role === 'admin').length;
  const members = data.members.map(member => ({
    ...member,
    teams: data.teams.filter(team => team.membershipIds.includes(member.id)),
  }));
  const visible = members.filter(member =>
    [member.name, member.email, member.role, ...member.teams.map(team => team.name)]
      .join(' ')
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  return (
    <section aria-label="Workspace members" className="flex flex-col gap-4 pt-4">
      <SearchField
        id="member-search"
        label="Search members"
        value={search}
        onChange={setSearch}
        placeholder="Search members"
      />
      {!members.length ? (
        <StatePanel
          kind="empty"
          icon={User}
          title="No members yet"
          description="Invite the people you work with. Each member gets a role, joins teams, and sees only what those teams can access."
          sample={<MembersSample />}
        />
      ) : !visible.length ? (
        <StatePanel
          kind="empty"
          icon={User}
          title="No members match"
          description="Try another name, email, role, or team."
        >
          <Button variant="outline" onClick={() => setSearch('')}>
            Clear search
          </Button>
        </StatePanel>
      ) : (
        <Table
          aria-label="Workspace members"
          narrow="stack"
          data={visible}
          getRowId={member => member.id}
          rowLabel={member => member.name || member.email}
          columns={[
            {
              key: 'name',
              header: 'Name',
              cell: member => (
                <span className="font-medium wrap-anywhere">
                  {member.name || member.email}
                  {member.id === data.actorMembershipId ? ' (you)' : ''}
                </span>
              ),
            },
            {
              key: 'email',
              header: 'Email',
              cell: member => <span className="line-clamp-2 text-muted-foreground wrap-anywhere">{member.email}</span>,
            },
            {
              key: 'teams',
              header: 'Teams',
              cell: member => (
                <span className="line-clamp-2 text-muted-foreground wrap-anywhere">
                  {member.teams.length ? member.teams.map(team => team.name).join(', ') : 'No teams assigned'}
                </span>
              ),
            },
            {
              key: 'role',
              header: 'Role',
              cell: member => {
                const finalAdmin = member.role === 'admin' && admins === 1;
                return (
                  <div className="flex min-w-0 max-w-64 flex-wrap items-center gap-2 whitespace-normal">
                    <Badge variant="secondary">{member.role === 'admin' ? 'Admin' : 'Member'}</Badge>
                    <MemberAction
                      member={member}
                      action="role"
                      disabled={busy || finalAdmin}
                      change={change}
                      recovery={recovery}
                    />
                    <MemberAction
                      member={member}
                      action="remove"
                      disabled={busy || finalAdmin}
                      change={change}
                      recovery={recovery}
                    />
                    {finalAdmin && (
                      <p className="w-full text-sm text-muted-foreground">
                        Last admin. Promote another member before demoting or removing this person.
                      </p>
                    )}
                  </div>
                );
              },
            },
          ]}
        />
      )}
    </section>
  );
}

function MemberAction({
  member,
  action,
  disabled,
  change,
  recovery,
}: {
  member: GovernanceSnapshot['members'][number];
  action: 'role' | 'remove';
  disabled: boolean;
  change: GovernanceChange;
  recovery: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setOpen(false);
    setMessage(null);
  }, [member.role]);
  const role = member.role === 'admin' ? 'member' : 'admin';
  const label = action === 'remove' ? `Remove access for ${member.name || 'member'}` : `Make ${role}`;
  return (
    <Dialog
      open={open}
      onOpenChange={value => {
        if (!pending) setOpen(value);
      }}
    >
      <DialogTrigger
        ref={trigger}
        render={<Button variant={action === 'remove' ? 'destructive' : 'outline'} size="sm" disabled={disabled} />}
      >
        {label}
      </DialogTrigger>
      <DialogContent
        finalFocus={() =>
          trigger.current?.isConnected && !trigger.current.disabled
            ? trigger.current
            : document.getElementById('governance-heading')
        }
      >
        <DialogHeader>
          <DialogTitle>{label}?</DialogTitle>
          <DialogDescription>
            {action === 'remove'
              ? `${member.email} will lose workspace access and all team memberships. Their business member row and existing links stay. They remain assignable until an editor marks that row inactive. Their account and other workspaces remain. Returning requires a new invitation.`
              : role === 'admin'
                ? `${member.email} will be able to invite, remove, and change access for workspace members.`
                : `${member.email} will lose admin authority. Their team memberships remain.`}
          </DialogDescription>
        </DialogHeader>
        {message && <p role="alert">{message}</p>}
        {recovery && <div>{recovery}</div>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant={action === 'remove' ? 'destructive' : 'default'}
            disabled={disabled || pending}
            aria-busy={pending}
            onClick={async () => {
              if (pending) return;
              setPending(true);
              setMessage(null);
              const result = await change(
                `/members/${member.id}${action === 'role' ? '/role' : ''}`,
                action === 'role' ? 'PUT' : 'DELETE',
                action === 'role' ? { role } : undefined,
              );
              setPending(false);
              if (result === 'saved') setOpen(false);
              else
                setMessage(
                  'The change could not be confirmed. Reload access to check the current membership before retrying.',
                );
            }}
          >
            Confirm {action === 'remove' ? 'removal' : 'role change'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
