import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { MoreH } from 'reicon-react/icons/MoreH';
import { Users } from 'reicon-react/icons/Users';
import type { MemberAccess } from '@tulipfarm/workspaces/governance-contracts';
import { Alert, AlertDescription, AlertTitle } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Table } from '@tulipfarm/sprout/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tulipfarm/sprout/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { useFeatureRead } from '@/lib/query';
import { loadMemberAccess } from '@/lib/governance';
import { governanceKeys } from '@/features/governance/queries';
import { useConfirmation } from '@/features/access/confirm';
import { accessPolicies, joinList, type PolicyRow } from '@/features/access/policies';
import { NoPolicies, PolicyEditor, PolicyTable, scopeChoices, type ScopeChoice } from '@/features/access/policy-table';
import type { PolicyPermission } from '@tulipfarm/workspaces/governance-contracts';
import { leaveConfirmation, leaveReason, personName } from './access-members';
import type { AccessPage } from './governance';

export function MemberDetail({ page, membershipId }: { page: AccessPage; membershipId: string }) {
  const self = membershipId === page.access.membershipId;
  const allowed = page.admin || self;
  const read = useFeatureRead({
    key: [...governanceKeys.memberAccess, membershipId],
    load: signal => loadMemberAccess(page.workspaceId, membershipId, signal),
    enabled: allowed,
  });
  if (!allowed || read.state.kind === 'unavailable')
    return (
      <StatePanel
        kind="unavailable"
        title="You can’t view this member’s access"
        description="Only admins can see other people’s access. You can always see your own."
      >
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link to="/$workspaceSlug/members" params={{ workspaceSlug: page.workspaceSlug }} />}
        >
          Back to Members
        </Button>
      </StatePanel>
    );
  if (read.state.kind === 'loading')
    return (
      <div role="status" className="flex flex-col gap-4">
        <span className="sr-only">Loading access…</span>
        <Skeleton shape="panel" />
      </div>
    );
  if (read.state.kind === 'error')
    return (
      <StatePanel kind="error" title="Couldn’t load this member’s access" description={read.state.message}>
        <Button variant="outline" onClick={() => void read.refresh()}>
          Try again
        </Button>
      </StatePanel>
    );
  return <Detail page={page} access={read.state.data} stale={!!read.state.error} />;
}

function Detail({ page, access, stale }: { page: AccessPage; access: MemberAccess; stale: boolean }) {
  const navigate = useNavigate();
  const confirmation = useConfirmation();
  const [editor, setEditor] = useState<{
    initial: { scope: ScopeChoice; permissions: PolicyPermission[] } | null;
  } | null>(null);
  const name = personName(access.member);
  const subject = { kind: 'member' as const, id: access.member.id, name };
  const readOnly = !page.admin;
  const busy = page.busy || stale;
  const rows = accessPolicies(access);
  const direct = rows.filter(row => row.source.kind === 'direct' && row.scope.kind !== 'all');
  const scopeOf = (row: PolicyRow): ScopeChoice | null =>
    row.scope.kind === 'all' ? null : { kind: row.scope.kind, id: row.scope.id, name: row.scope.name };
  const manageable = (team: MemberAccess['teams'][number]) => team.canManage && !(access.self && !page.admin);
  const soleManager = (team: MemberAccess['teams'][number]) =>
    team.role === 'manager' && page.data.teams.find(item => item.id === team.id)?.managerIds.length === 1;
  const addable = page.data.teams.filter(
    team => (page.admin || team.canManage) && !access.teams.some(own => own.id === team.id),
  );
  const failed = (result: Awaited<ReturnType<AccessPage['change']>>) =>
    result === 'saved' ? null : 'Nothing changed. Close this to see why.';
  const teamAction = async (path: string, body: unknown, notice: string) => {
    const result = await page.change(path, 'PUT', body);
    if (result === 'saved') page.notify(notice);
    return result;
  };
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span className="wrap-anywhere">{access.member.email}</span>
        <Badge variant={access.member.role === 'admin' ? 'info' : 'outline'}>
          {access.member.role === 'admin' ? 'Admin' : 'Member'}
        </Badge>
        {access.self && <Badge variant="secondary">You</Badge>}
      </div>
      {access.skipped && page.admin && (
        <Alert>
          <AlertTitle>Some invite choices weren’t applied</AlertTitle>
          <AlertDescription>
            {name} joined, but{' '}
            {joinList([
              ...access.skipped.teams.map(team => `the team ${team.name}`),
              ...access.skipped.policies.map(policy => `the policy on ${policy.name}`),
            ])}{' '}
            no longer existed when they accepted. Add them to a team or create a policy below if they still need that
            access.
          </AlertDescription>
        </Alert>
      )}
      <Tabs defaultValue="policies">
        <TabsList variant="line" aria-label={`${name}’s access`}>
          <TabsTrigger value="policies">Access policies</TabsTrigger>
          <TabsTrigger value="teams">Teams</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="policies">
          <div className="flex flex-col gap-4 pt-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                Everything {access.self ? 'you' : name} can do with tables, and where each permission comes from.
                {readOnly && ' Only admins can change access.'}
              </p>
              {page.admin && (
                <Button disabled={busy} onClick={() => setEditor({ initial: null })}>
                  Create a policy
                </Button>
              )}
            </div>
            <PolicyTable
              label={`Access policies for ${name}`}
              subject={name}
              rows={rows}
              workspaceSlug={page.workspaceSlug}
              editable={row => page.admin && !busy && row.source.kind === 'direct' && row.scope.kind !== 'all'}
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
                  title={access.self ? 'You don’t have access to any tables yet' : `${name} has no table access yet`}
                  description={
                    page.admin
                      ? 'Add them to a team, or create a policy to give access to a table directly.'
                      : 'Ask an admin or a team manager to add you to a team.'
                  }
                  action={
                    page.admin ? (
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
        <TabsContent value="teams">
          <div className="flex flex-col gap-4 pt-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {access.self ? 'Teams you belong to' : `Teams ${name} belongs to`}, and {access.self ? 'your' : 'their'}{' '}
                role in each.
              </p>
              {!(access.self && !page.admin) && addable.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="outline" disabled={busy} />}>
                    Add {access.self ? 'yourself' : name} to a team
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {addable.map(team => (
                      <DropdownMenuItem
                        key={team.id}
                        onClick={() =>
                          void teamAction(
                            `/teams/${team.id}/members/${access.member.id}`,
                            { enrolled: true },
                            `Added ${name} to ${team.name} as a member.`,
                          )
                        }
                      >
                        Add {name} to {team.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            <Table
              aria-label={`Teams for ${name}`}
              narrow="stack"
              data={access.teams}
              getRowId={team => team.id}
              rowLabel={team => team.name}
              empty={
                <StatePanel
                  kind="empty"
                  heading="h3"
                  icon={Users}
                  title={access.self ? 'You’re not on any teams yet' : `${name} isn’t on any teams yet`}
                  description="Teams give their members access to tables."
                />
              }
              columns={[
                {
                  key: 'name',
                  header: 'Team',
                  sort: true,
                  cell: team => (
                    <span className="font-medium wrap-anywhere underline-offset-4 hover:underline">
                      <Link
                        to="/$workspaceSlug/teams/$teamId"
                        params={{ workspaceSlug: page.workspaceSlug, teamId: team.id }}
                      >
                        {team.name}
                      </Link>
                    </span>
                  ),
                },
                {
                  key: 'role',
                  header: 'Team role',
                  sort: true,
                  cell: team =>
                    manageable(team) ? (
                      <span className="flex flex-col items-start gap-1">
                        <Select
                          value={team.role}
                          disabled={busy || soleManager(team)}
                          onValueChange={value =>
                            void teamAction(
                              `/teams/${team.id}/members/${access.member.id}/role`,
                              { role: value },
                              `${name} is now ${value === 'manager' ? 'a manager' : 'a member'} of ${team.name}.`,
                            )
                          }
                        >
                          <SelectTrigger
                            size="sm"
                            aria-label={`Team role for ${name} in ${team.name}`}
                            aria-describedby={soleManager(team) ? `only-manager-${team.id}` : undefined}
                          >
                            <SelectValue>{team.role === 'manager' ? 'Manager' : 'Member'}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="member">Member</SelectItem>
                            <SelectItem value="manager">Manager</SelectItem>
                          </SelectContent>
                        </Select>
                        {soleManager(team) && (
                          <span id={`only-manager-${team.id}`} className="text-xs text-muted-foreground">
                            {access.self ? 'You’re' : `${name} is`} the only manager. Make someone else a manager first.
                          </span>
                        )}
                      </span>
                    ) : team.role === 'manager' ? (
                      'Manager'
                    ) : (
                      'Member'
                    ),
                },
              ]}
              actions={team =>
                manageable(team) ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${name} in ${team.name}`} />
                      }
                    >
                      <MoreH size={16} aria-hidden="true" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={busy || soleManager(team)}
                        onClick={() =>
                          confirmation.open({
                            title: `Remove ${name} from ${team.name}?`,
                            description: `${name} loses the access ${team.name} gives them. Their other teams and direct policies stay.`,
                            action: 'Remove from team',
                            run: async () =>
                              failed(
                                await teamAction(
                                  `/teams/${team.id}/members/${access.member.id}`,
                                  { enrolled: false },
                                  `Removed ${name} from ${team.name}.`,
                                ),
                              ),
                          })
                        }
                      >
                        Remove {name} from {team.name}
                      </DropdownMenuItem>
                      {soleManager(team) && (
                        <p className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">
                          {access.self ? 'You’re' : `${name} is`} the only manager. Make someone else a manager first.
                        </p>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null
              }
            />
          </div>
        </TabsContent>
        <TabsContent value="settings">
          <div className="flex max-w-2xl flex-col gap-6 pt-4">
            {access.self ? (
              <div className="flex flex-col items-start gap-2">
                <h2 className="font-medium">Leave workspace</h2>
                <p className="text-sm text-muted-foreground">
                  {leaveReason(page) ?? 'You’ll lose access to everything in this workspace.'}
                </p>
                <Button
                  variant="destructive"
                  disabled={busy || !access.canLeave}
                  onClick={() => confirmation.open(leaveConfirmation(page))}
                >
                  Leave workspace
                </Button>
              </div>
            ) : page.admin ? (
              <>
                <div className="flex flex-col items-start gap-2">
                  <h2 className="font-medium">Workspace role</h2>
                  <p className="text-sm text-muted-foreground">
                    {access.member.role === 'admin'
                      ? `${name} is an admin and can manage members, teams and access to every table.`
                      : `${name} is a member and uses the tables their teams and policies give them.`}
                    {access.finalAdmin && ` ${name} is the only admin, so their role can’t change.`}
                  </p>
                  <Button
                    variant="outline"
                    disabled={busy || access.finalAdmin}
                    onClick={() =>
                      confirmation.open(
                        access.member.role === 'admin'
                          ? {
                              title: `Make ${name} a member?`,
                              description: `${name} loses Admin access: they can no longer manage members, teams or table access, and keep only what their teams and direct policies give them.`,
                              action: 'Make member',
                              run: async () =>
                                failed(
                                  await page.change(`/members/${access.member.id}/role`, 'PUT', { role: 'member' }),
                                ),
                            }
                          : {
                              title: `Make ${name} an admin?`,
                              description: `${name} will be able to manage members, teams and access to every table in this workspace.`,
                              action: 'Make admin',
                              destructive: false,
                              run: async () =>
                                failed(
                                  await page.change(`/members/${access.member.id}/role`, 'PUT', { role: 'admin' }),
                                ),
                            },
                      )
                    }
                  >
                    {access.member.role === 'admin' ? `Make ${name} a member` : `Make ${name} an admin`}
                  </Button>
                </div>
                <div className="flex flex-col items-start gap-2">
                  <h2 className="font-medium">Remove from workspace</h2>
                  <p className="text-sm text-muted-foreground">
                    {access.finalAdmin
                      ? `${name} is the only admin. Make someone else an admin first.`
                      : `${name} loses access to every table, chat and team here. Tables they created stay.`}
                  </p>
                  <Button
                    variant="destructive"
                    disabled={busy || access.finalAdmin}
                    onClick={() =>
                      confirmation.open({
                        title: `Remove ${name} from this workspace?`,
                        description: `${name} loses access to every table, chat and team here${
                          access.teams.length ? `, including ${joinList(access.teams.map(team => team.name))}` : ''
                        }. Tables they created stay.`,
                        action: 'Remove from workspace',
                        run: async () => {
                          const result = await page.change(`/members/${access.member.id}`, 'DELETE');
                          if (result !== 'saved') return failed(result);
                          page.flash(`Removed ${name} from this workspace.`);
                          void navigate({
                            to: '/$workspaceSlug/members',
                            params: { workspaceSlug: page.workspaceSlug },
                          });
                          return null;
                        },
                      })
                    }
                  >
                    Remove {name} from workspace
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        </TabsContent>
      </Tabs>
      <PolicyEditor
        open={editor !== null}
        onOpenChange={open => {
          if (!open) setEditor(null);
        }}
        subject={name}
        choices={scopeChoices(page.data)}
        initial={editor?.initial ?? null}
        existing={
          new Map(
            direct.flatMap(row => {
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
