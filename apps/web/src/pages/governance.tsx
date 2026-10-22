import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Add } from 'reicon-react/icons/Add';
import { Database } from 'reicon-react/icons/Database';
import { People } from 'reicon-react/icons/People';
import { ShieldUser } from 'reicon-react/icons/ShieldUser';
import {
  type GovernanceSnapshot,
  type OwnMembership,
  type GrantInput,
  tableGrantPermissionSchema,
} from '@tulipfarm/workspaces/governance-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { Label } from '@tulipfarm/sprout/label';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { SettingsGroup, SettingsRow } from '@tulipfarm/sprout/settings-list';
import { GrantsSample, StatePanel } from '@tulipfarm/sprout/state-panel';
import { changeGovernance, governanceError, GovernanceRequestError } from '@/lib/governance';
import { useGovernance } from '@/features/governance/queries';
import { useGovernanceChanges } from '@/features/governance/changes';
import { workspaceRoute } from '@/router';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tulipfarm/sprout/tabs';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { MemberAdministration, type GovernanceChange } from './member-administration';
import { TeamAdministration, TeamConfirmation } from './team-administration';
import { InvitationList } from './invitation-list';
import { InviteMembersDialog } from './invite-members-dialog';
import { useInvitationAdministration } from './use-invitation-administration';
import { PersonGrants } from '@/features/tables/person-grants';

type Section = 'members' | 'teams' | 'grants';
type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'member' | 'admin'; access: OwnMembership; data: GovernanceSnapshot };
type Change = GovernanceChange;
type AdministrationProps = { data: GovernanceSnapshot; busy: boolean; change: Change };

function GovernancePage({ section }: { section: Section }) {
  const { workspace } = workspaceRoute.useRouteContext();
  return (
    <GovernanceContent key={workspace.id} section={section} workspaceId={workspace.id} workspaceSlug={workspace.slug} />
  );
}

export function GovernanceContent({
  section,
  workspaceId,
  workspaceSlug,
}: {
  section: Section;
  workspaceId: string;
  workspaceSlug: string;
}) {
  const { membership, administration, refresh } = useGovernance(workspaceId);
  const changes = useGovernanceChanges();
  const state: LoadState =
    membership.state.kind === 'ready'
      ? administration.state.kind === 'ready'
        ? {
            kind: membership.state.data.capabilities.manageGovernance ? 'admin' : 'member',
            access: membership.state.data,
            data: administration.state.data,
          }
        : administration.state.kind === 'unavailable'
          ? { kind: 'unavailable', message: 'Administration access changed.' }
          : administration.state
      : membership.state.kind === 'unavailable'
        ? { kind: 'unavailable', message: 'Workspace access changed.' }
        : membership.state;
  const [busy, setBusy] = useState(false);
  const refreshing =
    membership.state.kind === 'loading' ||
    (membership.state.kind === 'ready' && membership.state.refreshing) ||
    (administration.state.kind === 'ready' && administration.state.refreshing);
  const [commandMessage, setMessage] = useState<string | null>(null);
  const readError =
    (membership.state.kind === 'ready' && membership.state.error) ||
    (administration.state.kind === 'ready' && administration.state.error) ||
    null;
  const message = commandMessage ?? readError;
  const [notice, setNotice] = useState<string | null>(null);
  const stale = !!readError;
  const recovery =
    stale || commandMessage ? (
      <Button
        variant="outline"
        size="sm"
        disabled={busy || refreshing}
        aria-busy={refreshing}
        onClick={() => void refresh()}
      >
        {refreshing && <Spinner aria-hidden="true" />}Reload access
      </Button>
    ) : null;
  const [tab, setTab] = useState('members');
  const inviteMock = import.meta.env.DEV && workspaceSlug === 'invite-mock';
  const [inviteOpen, setInviteOpen] = useState(inviteMock);
  const writePending = useRef(false);
  const mounted = useRef(true);
  const onInvitationAccessLost = () => {
    void changes.accessLost();
  };
  const invitations = useInvitationAdministration(
    workspaceId,
    state.kind === 'admin' && section === 'members',
    onInvitationAccessLost,
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const change: Change = async (path, method, body) => {
    if (writePending.current || refreshing || stale) return 'rejected';
    writePending.current = true;
    setBusy(true);
    setMessage(null);
    setNotice(null);
    try {
      await changeGovernance(workspaceId, path, method, body);
      if (
        path === '/leave' ||
        (state.kind === 'admin' && method === 'DELETE' && path === `/members/${state.access.membershipId}`)
      ) {
        changes.removed(workspaceId);
        return 'saved';
      }
      await changes.saved(path, method, body);
      if (!mounted.current) return 'saved';
      setNotice('Change saved.');
      return 'saved';
    } catch (error) {
      if (!mounted.current) return 'uncertain';
      if (error instanceof GovernanceRequestError && [401, 403, 404].includes(error.status)) await changes.accessLost();
      else if (error instanceof GovernanceRequestError && error.code === 'final-admin') await refresh();
      else if (error instanceof GovernanceRequestError && error.code === 'team-details-conflict') {
        await refresh();
        setMessage(governanceError(error));
        return error.code;
      }
      setMessage(governanceError(error));
      if (
        error instanceof GovernanceRequestError &&
        (error.code === 'duplicate-team-name' ||
          error.code === 'invalid-team-name' ||
          error.code === 'invalid-team-description')
      )
        return error.code;
      if (
        error instanceof GovernanceRequestError &&
        (error.code === 'team-owns-tables' ||
          error.code === 'team-owns-agents' ||
          error.code === 'team-owns-integrations')
      )
        return error.code;
      if (error instanceof GovernanceRequestError && error.code === 'team-id-retired') return 'retired';
      return error instanceof GovernanceRequestError && error.status >= 400 && error.status < 500
        ? 'rejected'
        : 'uncertain';
    } finally {
      writePending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageContent>
        <PageHeader
          titleId="governance-heading"
          focusable
          title={section === 'members' ? 'Members' : section === 'teams' ? 'Teams' : 'Table access'}
          description={
            section === 'members'
              ? 'People who belong to this workspace and their roles.'
              : section === 'teams'
                ? 'Group members so you can grant access once per team.'
                : 'Choose what each team can do with each table.'
          }
          actions={
            section === 'members' ? (
              <InviteMembersDialog
                workspaceId={workspaceId}
                authorized={state.kind === 'admin'}
                onAccessLost={onInvitationAccessLost}
                invitations={invitations}
                open={inviteOpen}
                onOpenChange={setInviteOpen}
                onViewInvitations={() => {
                  setInviteOpen(false);
                  setTab('invitations');
                }}
                members={state.kind === 'admin' ? state.data.directory : []}
                initialInput={inviteMock ? 'jessica@example.test\njustin@example.test\njenny@example.test' : ''}
              />
            ) : undefined
          }
        />
        {state.kind === 'loading' && (
          <div role="status" className="flex flex-col gap-4">
            <span className="sr-only">Loading workspace access…</span>
            <Skeleton shape="title" />
            <Skeleton shape="panel" />
          </div>
        )}
        {state.kind === 'error' && (
          <StatePanel kind="error" title="Could not load workspace access" description={state.message}>
            <Button variant="outline" disabled={refreshing} onClick={() => void refresh()}>
              Retry loading
            </Button>
          </StatePanel>
        )}
        {state.kind === 'unavailable' && (
          <StatePanel kind="unavailable" title="Administration unavailable" description={state.message}>
            <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
              Back to TulipFarm
            </Button>
          </StatePanel>
        )}
        {(state.kind === 'admin' || state.kind === 'member') && (
          <>
            {message && (
              <Alert variant="destructive">
                <AlertDescription>{message}</AlertDescription>
              </Alert>
            )}
            {(stale || commandMessage) && (
              <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                <p>
                  {stale
                    ? 'Loaded access may be out of date. Reload before making another change.'
                    : 'Reload to check current access. This does not repeat your change.'}
                </p>
                {recovery}
              </div>
            )}
            {notice && <p role="status">{notice}</p>}
            {busy && (
              <p role="status" className="flex items-center gap-2">
                <Spinner aria-hidden="true" />
                Saving access change…
              </p>
            )}
            {state.kind === 'member' && section === 'members' && (
              <SettingsGroup title="My membership" titleId="my-membership-heading">
                <SettingsRow label="Role" description={`Your role is ${state.access.role}.`} />
                <SettingsRow
                  label="Leave workspace"
                  description={
                    state.access.capabilities.canLeave ? (
                      'Leaving removes your membership and team access in this workspace. Your account and other workspaces remain available.'
                    ) : (
                      <span role="status">Hand off your last team manager or workspace admin role before leaving.</span>
                    )
                  }
                >
                  <TeamConfirmation
                    label="Leave workspace"
                    title="Leave this workspace?"
                    description="You will lose workspace access and all team memberships. Your account and other workspaces remain available."
                    busy={busy || refreshing || stale || !state.access.capabilities.canLeave}
                    recovery={recovery}
                    run={() => change('/leave', 'POST')}
                  />
                </SettingsRow>
              </SettingsGroup>
            )}
            {state.kind === 'member' && section === 'members' && (
              <SettingsGroup title="Workspace directory">
                {state.data.directory.map(member => (
                  <SettingsRow key={member.id} label={member.name} description={member.email} />
                ))}
              </SettingsGroup>
            )}
            {state.kind === 'member' && section === 'grants' && (
              <StatePanel
                kind="unavailable"
                title="Table administration requires an admin"
                description="A workspace admin manages table grants."
              >
                <Button
                  variant="outline"
                  nativeButton={false}
                  render={<Link to="/$workspaceSlug/teams" params={{ workspaceSlug }} />}
                >
                  View your teams
                </Button>
              </StatePanel>
            )}
            {state.kind === 'admin' && (
              <>
                {section === 'members' && (
                  <Tabs
                    value={tab}
                    onValueChange={value => {
                      if (typeof value === 'string') setTab(value);
                    }}
                  >
                    <TabsList aria-label="Members settings">
                      <TabsTrigger value="members">Members ({state.data.members.length})</TabsTrigger>
                      <TabsTrigger value="invitations">Invitations</TabsTrigger>
                    </TabsList>
                    <TabsContent value="members" keepMounted>
                      <MemberAdministration
                        data={state.data}
                        busy={busy || refreshing || stale}
                        change={change}
                        recovery={recovery}
                      />
                    </TabsContent>
                    <TabsContent value="invitations" keepMounted>
                      <InvitationList
                        workspaceId={workspaceId}
                        invitations={invitations}
                        onAccessLost={onInvitationAccessLost}
                        invite={
                          state.kind === 'admin' && (
                            <Button onClick={() => setInviteOpen(true)}>
                              <Add size={16} aria-hidden="true" />
                              Invite members
                            </Button>
                          )
                        }
                      />
                    </TabsContent>
                  </Tabs>
                )}
                {section === 'grants' && (
                  <TableAdministration
                    data={state.data}
                    workspaceId={workspaceId}
                    busy={busy || refreshing || stale}
                    change={change}
                  />
                )}
              </>
            )}
          </>
        )}
        {section === 'teams' && (
          <TeamAdministration
            data={state.kind === 'admin' || state.kind === 'member' ? state.data : null}
            busy={busy || refreshing || stale}
            change={change}
            recovery={recovery}
          />
        )}
      </PageContent>
    </div>
  );
}

const permissionLabels = {
  'table.schema.manage': 'Manage schema',
  'table.row.create': 'Create rows',
  'table.row.read': 'Read rows',
  'table.row.update': 'Update rows',
  'table.row.delete': 'Delete rows',
};

function TableAdministration({ data, workspaceId, busy, change }: AdministrationProps & { workspaceId: string }) {
  const tableData = {
    ...data,
    teams: data.tableTeamIds.map(
      id =>
        data.teams.find(team => team.id === id) ?? {
          id,
          name: `Team ${id}`,
          description: '',
          membershipIds: [],
          managerIds: [],
          canManage: false,
          canLeave: false,
        },
    ),
  };
  return (
    <>
      <GrantAdministration data={tableData} busy={busy} change={change} />
      <PersonGrants workspaceId={workspaceId} data={tableData} disabled={busy} />
    </>
  );
}

function GrantAdministration({ data, busy, change }: AdministrationProps) {
  const { workspaceSlug } = workspaceRoute.useParams();
  const [teamId, setTeamId] = useState('');
  const [feedback, setFeedback] = useState('');
  const selected = data.teams.find(team => team.id === teamId);
  const granted = (target: GrantInput['target']) =>
    data.grants.some(
      grant =>
        grant.teamId === teamId &&
        grant.target.kind === target.kind &&
        grant.target.id === target.id &&
        grant.target.permission === target.permission,
    );
  const toggle = async (target: GrantInput['target'], granted: boolean) => {
    const label =
      target.kind === 'table'
        ? `${permissionLabels[target.permission]} for ${data.tables.find(resource => resource.id === target.id)?.name ?? 'this table'}`
        : `Create tables owned by ${data.teams.find(team => team.id === target.id)?.name ?? 'this team'}`;
    setFeedback(`Saving ${label.toLowerCase()}…`);
    const result = await change('/grants', 'PUT', { teamId, target, granted });
    setFeedback(
      result === 'saved'
        ? `${label} ${granted ? 'granted to' : 'removed from'} ${selected?.name}.`
        : `${label} was not confirmed. Reload access to check the saved permissions before changing it again.`,
    );
  };
  return (
    <section className="flex flex-col gap-6">
      <h2 className="text-sm font-medium">Team table grants</h2>
      <p className="text-sm text-muted-foreground">Changes save immediately. There is no separate Save button.</p>
      <p className="text-sm text-muted-foreground">
        A person's table access combines their teams' grants with any individual grants below. Permissions apply to
        every row in the table. Owning a table does not grant row access.
      </p>
      {feedback && (
        <p role="status" className="text-base">
          {feedback}
        </p>
      )}
      {!data.teams.length ? (
        <StatePanel
          kind="empty"
          heading="h3"
          icon={ShieldUser}
          title="No team grants yet"
          description="Team grants give everyone in a team the same table access. Create a team to grant access to several people at once, or give one person access in Individual table grants below."
          sample={<GrantsSample />}
        >
          <Button nativeButton={false} render={<Link to="/$workspaceSlug/teams" params={{ workspaceSlug }} />}>
            <People size={16} aria-hidden="true" />
            Go to Teams
          </Button>
        </StatePanel>
      ) : (
        <div className="flex flex-col gap-2">
          <Label htmlFor="grant-team">Team receiving access</Label>
          <Select value={selected?.id ?? ''} onValueChange={value => setTeamId(value ?? '')}>
            <SelectTrigger id="grant-team">
              <SelectValue>{selected?.name ?? 'Select a team'}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Select a team</SelectItem>
              {data.teams.map(team => (
                <SelectItem key={team.id} value={team.id}>
                  {team.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {selected && (
        <>
          <fieldset disabled={busy} className="flex flex-col gap-3">
            <legend className="mb-3 text-base font-medium">Create tables in a destination team</legend>
            {data.teams.map(team => {
              const target = {
                kind: 'collection',
                id: team.id,
                permission: 'table.create',
              } satisfies GrantInput['target'];
              return (
                <div key={team.id} className="flex items-center gap-3">
                  <Checkbox
                    id={`collection-${team.id}`}
                    checked={granted(target)}
                    onCheckedChange={value => toggle(target, value)}
                  />
                  <Label htmlFor={`collection-${team.id}`}>Create tables owned by {team.name}</Label>
                </div>
              );
            })}
          </fieldset>
          {!data.tables.length && (
            <StatePanel
              kind="empty"
              heading="h3"
              icon={Database}
              title="No tables to grant yet"
              description="Table-specific permissions appear after a table is created. Collection creation grants can be assigned now."
            />
          )}
          {data.tables.map(resource => {
            const owner = data.teams.find(team => team.id === resource.owningTeamId);
            return (
              <article key={resource.id} className="flex flex-col gap-4 border-t border-border pt-4">
                <h3 className="text-base font-medium">{resource.name}</h3>
                <p className="text-sm text-muted-foreground">
                  {selected.name} grants:{' '}
                  {tableGrantPermissionSchema.options
                    .filter(permission => granted({ kind: 'table', id: resource.id, permission }))
                    .map(permission => permissionLabels[permission])
                    .join(', ') || 'None'}
                  . Other team grants still apply.
                </p>
                <fieldset disabled={busy} className="flex flex-wrap gap-6">
                  <legend className="sr-only">Permissions for {resource.name}</legend>
                  {tableGrantPermissionSchema.options.map(permission => {
                    const target = { kind: 'table', id: resource.id, permission } satisfies GrantInput['target'];
                    return (
                      <div key={permission} className="space-y-1">
                        <div className="flex items-center gap-3">
                          <Checkbox
                            id={`${resource.id}-${permission}`}
                            checked={granted(target)}
                            onCheckedChange={value => void toggle(target, value)}
                            aria-describedby={
                              permission === 'table.row.create' || permission === 'table.row.update'
                                ? `${resource.id}-read-dependency`
                                : undefined
                            }
                          />
                          <Label htmlFor={`${resource.id}-${permission}`}>{permissionLabels[permission]}</Label>
                        </div>
                      </div>
                    );
                  })}
                </fieldset>
                <p id={`${resource.id}-read-dependency`} className="text-sm text-muted-foreground">
                  Create and update also require Read rows from this team or another team the member belongs to. Manage
                  schema does not include Read rows.
                </p>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`owner-${resource.id}`}>Owning team</Label>
                  <Select
                    value={resource.owningTeamId}
                    disabled={busy}
                    onValueChange={value => {
                      if (value) void change(`/tables/${resource.id}/owner`, 'PUT', { teamId: value });
                    }}
                  >
                    <SelectTrigger id={`owner-${resource.id}`}>
                      <SelectValue>{owner?.name ?? 'Unavailable team'}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {data.teams.map(team => (
                        <SelectItem key={team.id} value={team.id}>
                          {team.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-muted-foreground">Ownership saves immediately and preserves explicit grants.</p>
                </div>
              </article>
            );
          })}
        </>
      )}
    </section>
  );
}

export const MembersPage = () => <GovernancePage section="members" />;
export const TeamsPage = () => <GovernancePage section="teams" />;
export const GrantsPage = () => <GovernancePage section="grants" />;
