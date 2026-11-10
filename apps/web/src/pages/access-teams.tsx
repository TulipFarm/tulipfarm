import { useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { MoreH } from 'reicon-react/icons/MoreH';
import { People } from 'reicon-react/icons/People';
import type { PolicyPermission, Team } from '@tulipfarm/workspaces/governance-contracts';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Label } from '@tulipfarm/sprout/label';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Table } from '@tulipfarm/sprout/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tulipfarm/sprout/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { useInvitations, type Invitation } from '@/features/governance/invitations';
import { useConfirmation } from '@/features/access/confirm';
import { joinList, teamPolicies, type PolicyRow } from '@/features/access/policies';
import { NoPolicies, PolicyEditor, PolicyTable, scopeChoices, type ScopeChoice } from '@/features/access/policy-table';
import { fieldError, TeamConfirmation, TeamFields, type Details, type FieldError } from '@/features/access/team-fields';
import { personName } from './access-members';
import type { AccessPage } from './governance';

const deleteFailure = (result: string) =>
  result === 'team-owns-tables'
    ? 'This team owns tables. Give them another owning team in Table access first.'
    : result === 'team-owns-archived-tables'
      ? 'This team owns archived tables. Restore them from Archived tables and give them another owning team first.'
      : result === 'team-owns-agents'
        ? 'This team owns active agents. Move them to another team first.'
        : result === 'team-owns-integrations'
          ? 'This team owns active integrations. Move them to another team first.'
          : 'Nothing changed. Close this to see why.';

const openInvitations = (items: Invitation[] | undefined) =>
  (items ?? []).filter(item => item.kind === 'email' && item.email && item.status === 'active');

function deleteDescription(team: Team, invitations: Invitation[]) {
  const members = team.membershipIds.length;
  const invitees = invitations
    .filter(item => item.teams.some(choice => choice.id === team.id))
    .map(item => item.email!);
  return [
    members
      ? `${members === 1 ? 'Its member loses' : `Its ${members} members lose`} the access ${team.name} gives them.`
      : 'It has no members.',
    invitees.length &&
      (invitees.length === 1
        ? `${invitees[0]} has a pending invite and will still join the workspace, but not this team.`
        : `${invitees.length} people with pending invites${
            invitees.length <= 3 ? `, ${joinList(invitees)},` : ''
          } will still join the workspace, but not this team.`),
    'This can’t be undone.',
  ]
    .filter(Boolean)
    .join(' ');
}

function CreateTeam({ page, open, setOpen }: { page: AccessPage; open: boolean; setOpen: (open: boolean) => void }) {
  const navigate = useNavigate();
  const [details, setDetails] = useState<Details>({ name: '', description: '' });
  const [error, setError] = useState<FieldError>(null);
  const [saving, setSaving] = useState(false);
  // An unconfirmed create retries with the same id, so it never makes two teams.
  const command = useRef<string | null>(null);
  async function create() {
    if (saving || page.busy) return;
    const name = details.name.trim();
    if (!name) {
      setError('invalid-team-name');
      return;
    }
    setSaving(true);
    const id = command.current ?? crypto.randomUUID();
    command.current = id;
    const result = await page.change(`/teams/${id}`, 'PUT', { name, description: details.description.trim() });
    setSaving(false);
    setError(fieldError(result));
    if (result === 'uncertain') return;
    command.current = null;
    if (result !== 'saved') return;
    page.flash(`Created the team ${name}. You’re its manager.`);
    setOpen(false);
    void navigate({ to: '/$workspaceSlug/teams/$teamId', params: { workspaceSlug: page.workspaceSlug, teamId: id } });
  }
  return (
    <Dialog
      open={open}
      onOpenChange={value => {
        if (!saving) setOpen(value);
      }}
    >
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>Create a team</DialogTitle>
          <DialogDescription>
            Teams group people so you can give them access to tables together. You’ll be its manager.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={event => {
            event.preventDefault();
            void create();
          }}
        >
          <TeamFields id="new-team" details={details} setDetails={setDetails} disabled={saving} error={error} />
          <DialogFooter>
            <Button variant="ghost" disabled={saving} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || page.busy} aria-busy={saving}>
              {saving ? 'Creating…' : 'Create team'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type TeamRow = Team & { managers: string; members: number; policies: number };

export function TeamsList({ page }: { page: AccessPage }) {
  const { data, workspaceSlug } = page;
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const confirmation = useConfirmation();
  const invitations = useInvitations(page.workspaceId, page.admin, page.accessLost, '', true);
  const names = new Map(data.directory.map(member => [member.id, personName(member)]));
  const needle = search.trim().toLowerCase();
  const rows: TeamRow[] = data.teams
    .filter(team => !needle || team.name.toLowerCase().includes(needle))
    .map(team => ({
      ...team,
      managers: team.managerIds.map(id => names.get(id) ?? 'Former member').join(', '),
      members: team.membershipIds.length,
      policies: team.policyCount,
    }));
  const create = (
    <Button disabled={page.busy} onClick={() => setCreating(true)}>
      Create a team
    </Button>
  );
  return (
    <section aria-labelledby="teams-heading" className="flex flex-col gap-4">
      <h2 id="teams-heading" className="sr-only">
        Teams
      </h2>
      {data.teams.length === 0 ? (
        <StatePanel
          kind="empty"
          heading="h3"
          icon={People}
          title="No teams yet"
          description="Teams group people so you can give them access to tables together."
        >
          {create}
        </StatePanel>
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <SearchField
              id="team-search"
              label="Search teams"
              value={search}
              onChange={setSearch}
              placeholder="Search teams"
            />
            {create}
          </div>
          {!page.admin && <p className="text-sm text-muted-foreground">You can see the teams you belong to.</p>}
          <Table
            aria-label="Teams"
            narrow="stack"
            data={rows}
            getRowId={team => team.id}
            rowLabel={team => team.name}
            empty={
              <StatePanel
                kind="empty"
                heading="h3"
                icon={People}
                title="No teams match that search"
                description="Try another name."
              />
            }
            columns={[
              {
                key: 'name',
                header: 'Name',
                sort: true,
                cell: team => (
                  <span className="flex flex-col">
                    <span className="font-medium wrap-anywhere underline-offset-4 hover:underline">
                      <Link to="/$workspaceSlug/teams/$teamId" params={{ workspaceSlug, teamId: team.id }}>
                        {team.name}
                      </Link>
                    </span>
                    {team.description && (
                      <span className="line-clamp-1 text-xs text-muted-foreground">{team.description}</span>
                    )}
                  </span>
                ),
              },
              {
                key: 'managers',
                header: 'Managers',
                sort: true,
                cell: team => team.managers || <span className="text-muted-foreground">No manager</span>,
              },
              { key: 'members', header: 'Members', sort: true, align: 'right' },
              { key: 'policies', header: 'Access policies', sort: true, align: 'right' },
            ]}
            actions={team => (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${team.name}`} />}
                >
                  <MoreH size={16} aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" size="menu">
                  <DropdownMenuItem
                    onClick={() =>
                      void navigate({ to: '/$workspaceSlug/teams/$teamId', params: { workspaceSlug, teamId: team.id } })
                    }
                  >
                    <span className="min-w-0 wrap-anywhere">
                      {team.canManage ? `Manage ${team.name}` : `View ${team.name}`}
                    </span>
                  </DropdownMenuItem>
                  {team.canManage && (
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={page.busy}
                      onClick={() =>
                        confirmation.open({
                          title: `Delete ${team.name}?`,
                          description: deleteDescription(team, openInvitations(invitations.data?.items)),
                          action: 'Delete team',
                          run: async () => {
                            const result = await page.change(`/teams/${team.id}`, 'DELETE');
                            if (result === 'saved') {
                              page.notify(`Deleted the team ${team.name}.`);
                              return null;
                            }
                            return deleteFailure(result);
                          },
                        })
                      }
                    >
                      <span className="min-w-0 wrap-anywhere">Delete {team.name}</span>
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          />
        </>
      )}
      <CreateTeam page={page} open={creating} setOpen={setCreating} />
      {confirmation.element}
    </section>
  );
}

type RosterRow = {
  id: string;
  kind: 'member' | 'invite';
  name: string;
  email: string;
  sortName: string;
  role: 'member' | 'manager';
  self: boolean;
};

export function TeamDetail({ page, teamId }: { page: AccessPage; teamId: string }) {
  const team = page.data.teams.find(item => item.id === teamId);
  if (!team)
    return (
      <StatePanel
        kind="unavailable"
        title="You can’t view this team"
        description="It may have been deleted, or you aren’t on it. Admins can see every team."
      >
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link to="/$workspaceSlug/teams" params={{ workspaceSlug: page.workspaceSlug }} />}
        >
          Back to Teams
        </Button>
      </StatePanel>
    );
  return <Detail page={page} team={team} />;
}

function Detail({ page, team }: { page: AccessPage; team: Team }) {
  const { data, admin, busy, workspaceSlug } = page;
  const navigate = useNavigate();
  const confirmation = useConfirmation();
  const invitations = useInvitations(page.workspaceId, admin, page.accessLost, '', true);
  const [adding, setAdding] = useState(false);
  const [editor, setEditor] = useState<{
    initial: { scope: ScopeChoice; permissions: PolicyPermission[] } | null;
  } | null>(null);
  const open = openInvitations(invitations.data?.items);
  const people = new Map(data.directory.map(member => [member.id, member]));
  const roster: RosterRow[] = [
    ...team.membershipIds.map(id => {
      const member = people.get(id);
      const name = member ? personName(member) : 'Former member';
      return {
        id,
        kind: 'member' as const,
        name,
        email: member?.email ?? '',
        sortName: name.toLowerCase(),
        role: team.managerIds.includes(id) ? ('manager' as const) : ('member' as const),
        self: id === page.access.membershipId,
      };
    }),
    ...open.flatMap(item => {
      const choice = item.teams.find(choice => choice.id === team.id);
      return choice
        ? [
            {
              id: item.id,
              kind: 'invite' as const,
              name: item.email!,
              email: item.email!,
              sortName: item.email!.toLowerCase(),
              role: choice.role,
              self: false,
            },
          ]
        : [];
    }),
  ];
  const managers = roster.filter(row => row.kind === 'member' && row.role === 'manager').length;
  const subject = { kind: 'team' as const, id: team.id, name: team.name };
  const policies = teamPolicies(data, team.id);
  const scopeOf = (row: PolicyRow): ScopeChoice | null =>
    row.scope.kind === 'all' ? null : { kind: row.scope.kind, id: row.scope.id, name: row.scope.name };
  const path = (row: RosterRow) =>
    row.kind === 'member' ? `/teams/${team.id}/members/${row.id}` : `/teams/${team.id}/invitations/${row.id}`;
  async function setRole(row: RosterRow, role: 'member' | 'manager') {
    const result =
      row.kind === 'member'
        ? await page.change(`${path(row)}/role`, 'PUT', { role })
        : await page.change(path(row), 'PUT', { enrolled: true, role });
    if (result === 'saved') {
      if (row.kind === 'invite') void invitations.refresh();
      const roleName = role === 'manager' ? 'a manager' : 'a member';
      page.notify(
        row.kind === 'invite'
          ? `${row.name} will join ${team.name} as ${roleName}.`
          : `${row.name} is now ${roleName} of ${team.name}.`,
      );
    }
  }
  return (
    <div className="flex flex-col gap-6">
      {team.description && <p className="max-w-3xl text-muted-foreground">{team.description}</p>}
      <Tabs defaultValue="members">
        <TabsList variant="line" aria-label={`${team.name} sections`}>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="policies">Access policies</TabsTrigger>
          {(team.canManage || team.membershipIds.includes(page.access.membershipId)) && (
            <TabsTrigger value="settings">Settings</TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="members">
          <div className="flex flex-col gap-4 pt-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {team.canManage
                  ? 'Managers can add and remove people and change their team role.'
                  : 'Only this team’s managers and workspace admins can change who is on it.'}
              </p>
              {team.canManage && (
                <Button disabled={busy} onClick={() => setAdding(true)}>
                  Add members
                </Button>
              )}
            </div>
            <Table
              aria-label={`Members of ${team.name}`}
              narrow="stack"
              data={roster}
              getRowId={row => `${row.kind}:${row.id}`}
              rowLabel={row => row.name}
              empty={
                <StatePanel
                  kind="empty"
                  heading="h3"
                  icon={People}
                  title="No one is on this team yet"
                  description="Add members to give them the access this team has."
                />
              }
              columns={[
                {
                  key: 'sortName',
                  header: 'Name / email',
                  sort: true,
                  cell: row => (
                    <span className="flex min-w-0 flex-col items-start">
                      {row.kind === 'member' && (admin || row.self) ? (
                        <span className="font-medium wrap-anywhere underline-offset-4 hover:underline">
                          <Link
                            to="/$workspaceSlug/members/$membershipId"
                            params={{ workspaceSlug, membershipId: row.id }}
                          >
                            {row.name}
                            {row.self && ' (you)'}
                          </Link>
                        </span>
                      ) : (
                        <span className="font-medium wrap-anywhere">
                          {row.name}
                          {row.self && ' (you)'}
                        </span>
                      )}
                      {row.kind === 'member' && row.email && row.email !== row.name && (
                        <span className="text-xs text-muted-foreground wrap-anywhere">{row.email}</span>
                      )}
                      {row.kind === 'invite' && <Badge variant="warning">Joins on accept</Badge>}
                    </span>
                  ),
                },
                {
                  key: 'role',
                  header: 'Team role',
                  sort: true,
                  cell: row => {
                    const lastManager = row.kind === 'member' && row.role === 'manager' && managers === 1;
                    return team.canManage && !(row.kind === 'invite' && !admin) ? (
                      <span className="flex flex-col items-start gap-1">
                        <Select
                          value={row.role}
                          disabled={busy || lastManager}
                          onValueChange={value => void setRole(row, value as 'member' | 'manager')}
                        >
                          <SelectTrigger
                            size="sm"
                            aria-label={`Team role for ${row.name} in ${team.name}`}
                            aria-describedby={lastManager ? `only-manager-${row.id}` : undefined}
                          >
                            <SelectValue>{row.role === 'manager' ? 'Manager' : 'Member'}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="member">Member</SelectItem>
                            <SelectItem value="manager">Manager</SelectItem>
                          </SelectContent>
                        </Select>
                        {lastManager && (
                          <span id={`only-manager-${row.id}`} className="text-xs text-muted-foreground">
                            {row.self ? 'You’re' : `${row.name} is`} the only manager. Make someone else a manager
                            first.
                          </span>
                        )}
                      </span>
                    ) : row.role === 'manager' ? (
                      'Manager'
                    ) : (
                      'Member'
                    );
                  },
                },
              ]}
              actions={row => {
                const lastManager = row.kind === 'member' && row.role === 'manager' && managers === 1;
                if (!team.canManage || (row.kind === 'invite' && !admin)) return null;
                if (row.self) return null;
                return (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.name} in ${team.name}`} />
                      }
                    >
                      <MoreH size={16} aria-hidden="true" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" size="menu">
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={busy || lastManager}
                        onClick={() =>
                          confirmation.open({
                            title:
                              row.kind === 'invite'
                                ? `Remove ${row.name} from ${team.name}?`
                                : `Remove ${row.name} from ${team.name}?`,
                            description:
                              row.kind === 'invite'
                                ? `${row.name} won’t join ${team.name} when they accept. Their invite to the workspace stays.`
                                : `${row.name} loses the access ${team.name} gives them. Their other teams and direct policies stay.`,
                            action: 'Remove from team',
                            run: async () => {
                              const result = await page.change(path(row), 'PUT', { enrolled: false });
                              if (result !== 'saved') return 'Nothing changed. Close this to see why.';
                              if (row.kind === 'invite') void invitations.refresh();
                              page.notify(
                                row.kind === 'invite'
                                  ? `${row.name} won’t join ${team.name} when they accept.`
                                  : `Removed ${row.name} from ${team.name}.`,
                              );
                              return null;
                            },
                          })
                        }
                      >
                        <span className="min-w-0 wrap-anywhere">
                          Remove {row.name} from {team.name}
                        </span>
                      </DropdownMenuItem>
                      {lastManager && (
                        <p className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">
                          {row.name} is the only manager. Make someone else a manager first.
                        </p>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                );
              }}
            />
          </div>
        </TabsContent>
        <TabsContent value="policies">
          <div className="flex flex-col gap-4 pt-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                Everyone on {team.name} gets this access.{!admin && ' Only admins can change it.'}
              </p>
              {admin && (
                <Button disabled={busy} onClick={() => setEditor({ initial: null })}>
                  Create a policy
                </Button>
              )}
            </div>
            <PolicyTable
              label={`Access policies for ${team.name}`}
              subject={team.name}
              rows={policies}
              workspaceSlug={workspaceSlug}
              showSource={false}
              editable={() => admin && !busy}
              onEdit={row => {
                const scope = scopeOf(row);
                if (scope) setEditor({ initial: { scope, permissions: row.permissions } });
              }}
              onRemove={row => {
                const scope = scopeOf(row);
                return scope ? page.policy(subject, scope, []) : Promise.resolve({ ok: true as const });
              }}
              empty={
                <NoPolicies
                  title={`${team.name} has no access yet`}
                  description={
                    admin
                      ? 'Create a policy to give everyone on this team access to a table.'
                      : 'An admin can give this team access to tables.'
                  }
                  action={
                    admin ? (
                      <Button disabled={busy} onClick={() => setEditor({ initial: null })}>
                        Create a policy
                      </Button>
                    ) : undefined
                  }
                />
              }
            />
          </div>
        </TabsContent>
        <TabsContent value="settings">
          <div className="flex max-w-2xl flex-col gap-8 pt-4">
            {team.canManage && <RenameTeam page={page} team={team} />}
            {team.membershipIds.includes(page.access.membershipId) && (
              <div className="flex flex-col items-start gap-2">
                <h2 className="font-medium">Leave team</h2>
                <p className="text-sm text-muted-foreground">
                  {team.canLeave
                    ? `You’ll lose the access ${team.name} gives you. A manager can add you back.`
                    : 'You’re the only manager. Make someone else a manager before you leave.'}
                </p>
                <TeamConfirmation
                  label="Leave team"
                  title={`Leave ${team.name}?`}
                  description={`You’ll lose the access ${team.name} gives you. A manager can add you back.`}
                  busy={busy || !team.canLeave}
                  recovery={page.recovery}
                  run={() => page.change(`/teams/${team.id}/leave`, 'POST')}
                />
              </div>
            )}
            {team.canManage && (
              <div className="flex flex-col items-start gap-2">
                <h2 className="font-medium">Delete team</h2>
                <p className="text-sm text-muted-foreground">
                  Everyone on {team.name} loses the access it gives them. A team that owns tables, agents or
                  integrations can’t be deleted.
                </p>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() =>
                    confirmation.open({
                      title: `Delete ${team.name}?`,
                      description: deleteDescription(team, open),
                      action: 'Delete team',
                      run: async () => {
                        const result = await page.change(`/teams/${team.id}`, 'DELETE');
                        if (result !== 'saved') return deleteFailure(result);
                        page.flash(`Deleted the team ${team.name}.`);
                        void navigate({ to: '/$workspaceSlug/teams', params: { workspaceSlug } });
                        return null;
                      },
                    })
                  }
                >
                  Delete {team.name}
                </Button>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
      {team.canManage && <AddMembers page={page} team={team} open={adding} setOpen={setAdding} invitations={open} />}
      <PolicyEditor
        open={editor !== null}
        onOpenChange={value => {
          if (!value) setEditor(null);
        }}
        subject={team.name}
        choices={scopeChoices(data)}
        initial={editor?.initial ?? null}
        existing={
          new Map(
            policies.flatMap(row => {
              const scope = scopeOf(row);
              return scope ? [[`${scope.kind}:${scope.id}`, row.permissions] as const] : [];
            }),
          )
        }
        save={(scope, permissions) => page.policy(subject, scope, permissions)}
      />
      {confirmation.element}
    </div>
  );
}

function AddMembers({
  page,
  team,
  open,
  setOpen,
  invitations,
}: {
  page: AccessPage;
  team: Team;
  open: boolean;
  setOpen: (open: boolean) => void;
  invitations: Invitation[];
}) {
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const needle = search.trim().toLowerCase();
  const candidates = [
    ...page.data.directory
      .filter(member => !team.membershipIds.includes(member.id))
      .map(member => ({
        key: `member:${member.id}`,
        id: member.id,
        kind: 'member' as const,
        label: personName(member),
        email: member.email,
      })),
    ...(page.admin
      ? invitations
          .filter(item => !item.teams.some(choice => choice.id === team.id))
          .map(item => ({
            key: `invite:${item.id}`,
            id: item.id,
            kind: 'invite' as const,
            label: item.email!,
            email: item.email!,
          }))
      : []),
  ];
  const visible = candidates.filter(
    item => !needle || item.label.toLowerCase().includes(needle) || item.email.toLowerCase().includes(needle),
  );
  async function add() {
    if (saving || !selection.length) return;
    setSaving(true);
    setFailure(null);
    const added: string[] = [];
    for (const key of selection) {
      const item = candidates.find(candidate => candidate.key === key);
      if (!item) continue;
      const result = await page.change(
        item.kind === 'member' ? `/teams/${team.id}/members/${item.id}` : `/teams/${team.id}/invitations/${item.id}`,
        'PUT',
        item.kind === 'member' ? { enrolled: true } : { enrolled: true, role: 'member' },
      );
      if (result !== 'saved') {
        setFailure(
          `${added.length ? `Added ${joinList(added)}. ` : ''}Couldn’t add ${item.label}, so the rest weren’t added. The reason is shown at the top of the page.`,
        );
        setSelection(current =>
          current.filter(value => !added.some(label => candidates.find(c => c.key === value)?.label === label)),
        );
        setSaving(false);
        return;
      }
      added.push(item.label);
    }
    setSaving(false);
    setSelection([]);
    setOpen(false);
    page.notify(`Added ${joinList(added)} to ${team.name}.`);
  }
  return (
    <Dialog
      open={open}
      onOpenChange={value => {
        if (!saving) {
          setOpen(value);
          if (!value) setFailure(null);
        }
      }}
    >
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>Add members to {team.name}</DialogTitle>
          <DialogDescription>
            They get the access {team.name} has. People who haven’t accepted their invite yet join the team when they
            do.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <SearchField
            id="add-team-search"
            label="Search people"
            value={search}
            onChange={setSearch}
            placeholder="Name or email"
          />
          {!candidates.length ? (
            <p className="text-sm text-muted-foreground">Everyone you can add is already on {team.name}.</p>
          ) : !visible.length ? (
            <p className="text-sm text-muted-foreground">No one matches that search.</p>
          ) : (
            <ul className="flex max-h-80 flex-col divide-y overflow-y-auto rounded-lg border" aria-label="People">
              {visible.map(item => (
                <li key={item.key} className="px-3 py-2">
                  <div className="flex items-center gap-3">
                    <Checkbox
                      id={`add-member-${item.key}`}
                      aria-describedby={item.kind === 'invite' ? `add-member-${item.key}-pending` : undefined}
                      checked={selection.includes(item.key)}
                      disabled={saving}
                      onCheckedChange={checked =>
                        setSelection(current =>
                          checked ? [...current, item.key] : current.filter(value => value !== item.key),
                        )
                      }
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <Label htmlFor={`add-member-${item.key}`}>
                        <span className="wrap-anywhere">{item.label}</span>
                      </Label>
                      {item.kind === 'member' && item.email !== item.label && (
                        <span className="text-xs text-muted-foreground wrap-anywhere">{item.email}</span>
                      )}
                    </span>
                    {item.kind === 'invite' && (
                      <span id={`add-member-${item.key}-pending`}>
                        <Badge variant="warning">Joins on accept</Badge>
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {failure && (
            <Alert variant="destructive">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={saving} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={saving || !selection.length || page.busy} aria-busy={saving} onClick={() => void add()}>
            {saving ? 'Adding…' : selection.length > 1 ? `Add ${selection.length} people` : 'Add to team'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameTeam({ page, team }: { page: AccessPage; team: Team }) {
  const current = { name: team.name, description: team.description };
  const [details, setDetails] = useState<Details>(current);
  const [expected, setExpected] = useState<Details>(current);
  const [error, setError] = useState<FieldError>(null);
  const [saving, setSaving] = useState(false);
  const dirty = details.name !== current.name || details.description !== current.description;
  return (
    <form
      className="flex flex-col gap-4"
      aria-label={`Name and description of ${team.name}`}
      onSubmit={async event => {
        event.preventDefault();
        if (saving || !dirty) return;
        setSaving(true);
        const result = await page.change(`/teams/${team.id}/name`, 'PUT', { ...details, expected });
        setSaving(false);
        setError(fieldError(result));
        if (result === 'saved') {
          setExpected(details);
          page.notify(`Saved the name and description for ${details.name}.`);
        } else if (result === 'team-details-conflict') {
          setDetails(current);
          setExpected(current);
        }
      }}
    >
      <h2 className="font-medium">Name and description</h2>
      <TeamFields
        id={`team-${team.id}`}
        details={details}
        setDetails={setDetails}
        disabled={saving || page.busy}
        error={error}
      />
      <div className="flex gap-2">
        <Button type="submit" disabled={!dirty || saving || page.busy} aria-busy={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {dirty && (
          <Button variant="ghost" disabled={saving} onClick={() => setDetails(current)}>
            Discard changes
          </Button>
        )}
      </div>
    </form>
  );
}
