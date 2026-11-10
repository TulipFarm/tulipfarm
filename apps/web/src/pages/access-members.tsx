import { useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { MoreH } from 'reicon-react/icons/MoreH';
import { User } from 'reicon-react/icons/User';
import { CheckIcon } from 'lucide-react';
import { createdInvitationSchema, invitationLinkSchema } from '@tulipfarm/workspaces/governance-contracts';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Table } from '@tulipfarm/sprout/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { governanceError, governancePath, governanceRequest, GovernanceRequestError } from '@/lib/governance';
import { useInvitations, type Invitation } from '@/features/governance/invitations';
import { WorkspaceMemberPicker } from '@/features/tables/member-picker';
import { useConfirmation } from '@/features/access/confirm';
import { joinList } from '@/features/access/policies';
import type { AccessPage } from './governance';

const date = (value: string) =>
  new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
export const personName = (person: { name: string; email: string }) => person.name || person.email;
const failed = (result: Awaited<ReturnType<AccessPage['change']>>) =>
  result === 'saved' ? null : 'Nothing changed. Close this to see why.';

type Row = {
  id: string;
  kind: 'member' | 'invite';
  name: string;
  email: string;
  sortName: string;
  admin: string;
  teams: string[];
  status: 'Active' | 'Pending' | 'Expired';
  self: boolean;
  invitation?: Invitation;
};

// Keeps one request id per invitation until a resend is confirmed, so retrying never sends twice.
const resendRequests = new Map<string, string>();

/** Admin count from the directory, which every member can read. */
export const adminCount = (page: AccessPage) => page.data.directory.filter(member => member.role === 'admin').length;

export function MembersList({ page }: { page: AccessPage }) {
  const { workspaceId, workspaceSlug, admin, data, access, busy, change } = page;
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const confirmation = useConfirmation();
  const invitations = useInvitations(workspaceId, admin, page.accessLost, '', true);
  const resendMember = useRef('');
  const admins = adminCount(page);
  const teamsOf = (membershipId: string) =>
    data.teams.filter(team => team.membershipIds.includes(membershipId)).map(team => team.name);
  const members: Row[] = data.directory.map(member => ({
    id: member.id,
    kind: 'member',
    name: member.name,
    email: member.email,
    sortName: personName(member).toLowerCase(),
    admin: member.role === 'admin' ? 'Admin' : '',
    teams: teamsOf(member.id),
    status: 'Active',
    self: member.id === access.membershipId,
  }));
  const invites: Row[] = admin
    ? (invitations.data?.items ?? [])
        .filter(item => item.kind === 'email' && item.email && (item.status === 'active' || item.status === 'expired'))
        .map(item => ({
          id: item.id,
          kind: 'invite',
          name: '',
          email: item.email!,
          sortName: item.email!.toLowerCase(),
          admin: item.role === 'admin' ? 'Admin' : '',
          teams: item.teams.map(team => team.name),
          status: item.status === 'active' ? 'Pending' : 'Expired',
          self: false,
          invitation: item,
        }))
    : [];
  const needle = search.trim().toLowerCase();
  const rows = [...members, ...invites].filter(
    row => !needle || row.name.toLowerCase().includes(needle) || row.email.toLowerCase().includes(needle),
  );

  const base = (id: string) => `${governancePath(workspaceId)}/invitations/${id}`;
  async function invitationAction(row: Row, action: 'copy' | 'resend' | 'revoke'): Promise<string | null> {
    const item = row.invitation!;
    try {
      if (action === 'copy') {
        const { url } = invitationLinkSchema.parse(await governanceRequest(`${base(item.id)}/link`));
        try {
          await navigator.clipboard.writeText(url);
          page.notify(`Copied the invite link for ${row.email}.`);
        } catch {
          page.notify(`Couldn’t copy the link. Invite link for ${row.email}: ${url}`);
        }
        return null;
      }
      if (action === 'resend') {
        const memberId = item.workspaceMemberId ?? resendMember.current;
        if (!memberId) return 'Choose the workspace member this invite is for.';
        const requestId = resendRequests.get(item.id) ?? crypto.randomUUID();
        resendRequests.set(item.id, requestId);
        const result = createdInvitationSchema.parse(
          await governanceRequest(`${base(item.id)}/resend`, 'POST', { requestId, workspaceMemberId: memberId }),
        );
        resendRequests.delete(item.id);
        if (result.outcome !== 'already-member') invitations.record(result.invitation, item);
        void invitations.refresh();
        page.notify(
          result.outcome === 'already-member'
            ? `${row.email} has already joined. There was no invite to resend.`
            : `Resending the invite to ${row.email}. Their old link no longer works.`,
        );
        return null;
      }
      await governanceRequest(`${base(item.id)}/revoke`, 'POST');
      invitations.record({ ...item, status: 'revoked', canCopy: false });
      void invitations.refresh();
      page.notify(`Revoked the invite for ${row.email}. Their link no longer works.`);
      return null;
    } catch (error) {
      if (error instanceof GovernanceRequestError && error.status === 401) {
        page.accessLost();
        return 'You were signed out. Nothing changed.';
      }
      if (error instanceof GovernanceRequestError && error.status === 404) {
        void invitations.refresh();
        return 'This invite is no longer available. The list has been refreshed.';
      }
      if (error instanceof GovernanceRequestError && error.status >= 400 && error.status < 500)
        return governanceError(error);
      return action === 'copy'
        ? governanceError(error)
        : 'We couldn’t confirm this change. Close this and check the invite’s status before trying again.';
    }
  }

  function menu(row: Row) {
    const who = row.kind === 'invite' ? row.email : personName(row);
    const items: React.ReactNode[] = [];
    if (row.kind === 'invite') {
      const item = row.invitation!;
      if (item.status === 'active')
        items.push(
          <DropdownMenuItem
            key="edit"
            disabled={busy}
            onClick={() =>
              void navigate({
                to: '/$workspaceSlug/members/invites/$invitationId',
                params: { workspaceSlug, invitationId: item.id },
              })
            }
          >
            <span className="min-w-0 wrap-anywhere">Edit invite for {row.email}</span>
          </DropdownMenuItem>,
        );
      items.push(
        <DropdownMenuItem
          key="resend"
          disabled={busy}
          onClick={() => {
            resendMember.current = '';
            confirmation.open({
              title: `Resend the invite to ${row.email}?`,
              description: `We’ll email ${row.email} a new link that lasts seven days. Their old link stops working.`,
              action: 'Resend invite',
              destructive: false,
              body: item.workspaceMemberId ? undefined : (
                <ResendMember
                  workspaceId={workspaceId}
                  workspaceSlug={workspaceSlug}
                  id={`resend-member-${item.id}`}
                  onChange={value => (resendMember.current = value)}
                />
              ),
              run: () => invitationAction(row, 'resend'),
            });
          }}
        >
          <span className="min-w-0 wrap-anywhere">Resend invite to {row.email}</span>
        </DropdownMenuItem>,
      );
      if (item.canCopy && item.status === 'active')
        items.push(
          <DropdownMenuItem key="copy" onClick={() => void invitationAction(row, 'copy')}>
            <span className="min-w-0 wrap-anywhere">Copy invite link for {row.email}</span>
          </DropdownMenuItem>,
        );
      if (item.status === 'active' || item.status === 'expired')
        items.push(
          <DropdownMenuSeparator key="separator" />,
          <DropdownMenuItem
            key="revoke"
            variant="destructive"
            disabled={busy}
            onClick={() =>
              confirmation.open({
                title: `Revoke the invite for ${row.email}?`,
                description: `${row.email} can no longer join with their link, and won’t get the teams or access chosen for them. You can invite them again later.`,
                action: 'Revoke invite',
                run: () => invitationAction(row, 'revoke'),
              })
            }
          >
            <span className="min-w-0 wrap-anywhere">Revoke invite for {row.email}</span>
          </DropdownMenuItem>,
        );
      return items;
    }
    if (row.self || admin)
      items.push(
        <DropdownMenuItem
          key="view"
          onClick={() =>
            void navigate({
              to: '/$workspaceSlug/members/$membershipId',
              params: { workspaceSlug, membershipId: row.id },
            })
          }
        >
          <span className="min-w-0 wrap-anywhere">
            {row.self ? 'View your access' : admin ? `View and edit access for ${who}` : `View access for ${who}`}
          </span>
        </DropdownMenuItem>,
      );
    const finalAdmin = row.admin && admins === 1;
    if (admin && !row.self) {
      items.push(
        <DropdownMenuItem
          key="role"
          disabled={busy || !!finalAdmin}
          onClick={() =>
            confirmation.open(
              row.admin
                ? {
                    title: `Make ${who} a member?`,
                    description: `${who} loses Admin access: they can no longer manage members, teams or table access, and keep only what their teams and direct policies give them.`,
                    action: 'Make member',
                    run: async () => failed(await change(`/members/${row.id}/role`, 'PUT', { role: 'member' })),
                  }
                : {
                    title: `Make ${who} an admin?`,
                    description: `${who} will be able to manage members, teams and access to every table in this workspace.`,
                    action: 'Make admin',
                    destructive: false,
                    run: async () => failed(await change(`/members/${row.id}/role`, 'PUT', { role: 'admin' })),
                  },
            )
          }
        >
          <span className="min-w-0 wrap-anywhere">{row.admin ? `Make ${who} a member` : `Make ${who} an admin`}</span>
        </DropdownMenuItem>,
        <DropdownMenuSeparator key="separator" />,
        <DropdownMenuItem
          key="remove"
          variant="destructive"
          disabled={busy || !!finalAdmin}
          onClick={() =>
            confirmation.open({
              title: `Remove ${who} from this workspace?`,
              description: `${who} loses access to every table, chat and team here${row.teams.length ? `, including ${joinList(row.teams)}` : ''}. Tables they created stay.`,
              action: 'Remove from workspace',
              run: async () => failed(await change(`/members/${row.id}`, 'DELETE')),
            })
          }
        >
          <span className="min-w-0 wrap-anywhere">Remove {who} from workspace</span>
        </DropdownMenuItem>,
      );
    }
    if (row.self)
      items.push(
        <DropdownMenuSeparator key="separator" />,
        <DropdownMenuItem
          key="leave"
          variant="destructive"
          disabled={busy || !access.capabilities.canLeave}
          onClick={() => confirmation.open(leaveConfirmation(page))}
        >
          <span className="min-w-0 wrap-anywhere">Leave workspace</span>
        </DropdownMenuItem>,
        ...(access.capabilities.canLeave
          ? []
          : [
              <p key="leave-reason" className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">
                {leaveReason(page)}
              </p>,
            ]),
      );
    return items;
  }
  const invite = admin ? (
    <Button nativeButton={false} render={<Link to="/$workspaceSlug/members/invite" params={{ workspaceSlug }} />}>
      Invite members
    </Button>
  ) : null;
  return (
    <section aria-labelledby="members-heading" className="flex flex-col gap-4">
      <h2 id="members-heading" className="sr-only">
        All members
      </h2>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SearchField
          id="member-search"
          label="Search by name or email"
          value={search}
          onChange={setSearch}
          placeholder="Search by name or email"
        />
        {invite}
      </div>
      {admin && invitations.error && (
        <p className="text-sm text-muted-foreground">
          Pending invites couldn’t load.{' '}
          <Button variant="link" size="sm" onClick={() => void invitations.refresh()}>
            Try again
          </Button>
        </p>
      )}
      <Table
        aria-label="Workspace members"
        narrow="stack"
        data={rows}
        getRowId={row => `${row.kind}:${row.id}`}
        rowLabel={row => (row.kind === 'invite' ? row.email : personName(row))}
        empty={
          <StatePanel
            kind="empty"
            heading="h3"
            icon={User}
            title={needle ? 'No one matches that search' : 'No members yet'}
            description={needle ? 'Try another name or email.' : 'Invite people to work in this workspace.'}
          />
        }
        columns={[
          {
            key: 'sortName',
            header: 'Name / email',
            sort: true,
            cell: row => (
              <span className="flex min-w-0 flex-col">
                {row.kind === 'member' && (row.self || admin) ? (
                  <span className="font-medium wrap-anywhere underline-offset-4 hover:underline">
                    <Link to="/$workspaceSlug/members/$membershipId" params={{ workspaceSlug, membershipId: row.id }}>
                      {personName(row)}
                      {row.self && ' (you)'}
                    </Link>
                  </span>
                ) : (
                  <span className="font-medium wrap-anywhere">
                    {row.kind === 'invite' ? row.email : personName(row)}
                  </span>
                )}
                {row.kind === 'member' && row.name && (
                  <span className="text-xs text-muted-foreground wrap-anywhere">{row.email}</span>
                )}
                {row.kind === 'invite' && <Delivery invitation={row.invitation!} />}
              </span>
            ),
          },
          {
            key: 'admin',
            header: 'Admin',
            sort: true,
            cell: row =>
              row.admin ? (
                <span className="flex items-center gap-2">
                  <CheckIcon aria-hidden className="size-4 text-primary" />
                  <span className="sr-only">Admin</span>
                  {admins === 1 && row.kind === 'member' && (
                    <span className="text-xs text-muted-foreground">Only admin</span>
                  )}
                </span>
              ) : (
                <span className="sr-only">Member</span>
              ),
          },
          {
            key: 'teams',
            header: 'Teams',
            cell: row => {
              const skipped = row.invitation?.skipped?.teams ?? [];
              return skipped.length ? (
                <span className="flex flex-col gap-1">
                  <TeamChips teams={row.teams} />
                  <span className="text-xs text-muted-foreground wrap-anywhere">
                    Won’t join deleted {skipped.length === 1 ? 'team' : 'teams'}:{' '}
                    {joinList(skipped.map(team => team.name))}
                  </span>
                </span>
              ) : (
                <TeamChips teams={row.teams} />
              );
            },
          },
          {
            key: 'status',
            header: 'Status',
            sort: true,
            cell: row => (
              <span className="flex flex-col items-start gap-0.5">
                <Badge
                  variant={row.status === 'Active' ? 'success' : row.status === 'Pending' ? 'warning' : 'secondary'}
                >
                  {row.status}
                </Badge>
                {row.invitation && row.status === 'Pending' && (
                  <span className="text-xs text-muted-foreground">Expires {date(row.invitation.expiresAt)}</span>
                )}
                {row.invitation && row.status === 'Expired' && (
                  <span className="text-xs text-muted-foreground">Expired {date(row.invitation.expiresAt)}</span>
                )}
              </span>
            ),
          },
        ]}
        actions={row => {
          const items = menu(row);
          const who = row.kind === 'invite' ? row.email : personName(row);
          const finalAdmin = admin && !row.self && row.kind === 'member' && row.admin && admins === 1;
          if (!items.length) return null;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${who}`} />}>
                <MoreH size={16} aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" size="menu">
                {items}
                {finalAdmin && (
                  <p className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">
                    {who} is the only admin. Make someone else an admin first.
                  </p>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        }}
      />
      {admin && invitations.data?.nextCursor && (
        <div>
          <Button
            variant="outline"
            disabled={invitations.busy}
            onClick={() => void invitations.refresh(invitations.data!.nextCursor!)}
          >
            Show more invites
          </Button>
        </div>
      )}
      {confirmation.element}
    </section>
  );
}

function ResendMember(props: {
  workspaceId: string;
  workspaceSlug: string;
  id: string;
  onChange: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <WorkspaceMemberPicker
      workspaceId={props.workspaceId}
      workspaceSlug={props.workspaceSlug}
      id={props.id}
      value={value}
      disabled={false}
      onChange={next => {
        setValue(next);
        props.onChange(next);
      }}
    />
  );
}

/** Email delivery, kept apart from the invite's own status so "sent" is shown only once it is. */
function Delivery({ invitation }: { invitation: Invitation }) {
  const text =
    invitation.delivery === 'pending' || invitation.delivery === 'sending'
      ? 'Invite email on its way'
      : invitation.delivery === 'failed'
        ? 'Invite email wasn’t delivered. Resend the invite or copy its link.'
        : invitation.delivery === 'sent'
          ? 'Invite email sent'
          : null;
  if (!text) return null;
  return (
    <span className={invitation.delivery === 'failed' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
      {text}
    </span>
  );
}

export function TeamChips({ teams, limit = 2 }: { teams: string[]; limit?: number }) {
  if (!teams.length) return <span className="text-muted-foreground">—</span>;
  const shown = teams.slice(0, limit);
  const rest = teams.slice(limit);
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map(team => (
        <Badge key={team} variant="outline">
          {team}
        </Badge>
      ))}
      {rest.length > 0 && (
        <Badge variant="secondary" title={rest.join(', ')} aria-label={`and ${joinList(rest)}`}>
          +{rest.length}
        </Badge>
      )}
    </span>
  );
}

/** Why you can't leave yet, or null when you can. */
export function leaveReason(page: AccessPage) {
  if (page.access.capabilities.canLeave) return null;
  if (page.access.role === 'admin' && adminCount(page) === 1)
    return 'You’re the only admin. Make someone else an admin before you leave.';
  const me = page.data.actorMembershipId;
  const teams = page.data.teams.filter(team => team.managerIds.length === 1 && team.managerIds.includes(me));
  return teams.length
    ? `You’re the only manager of ${joinList(teams.map(team => team.name))}. Make someone else a manager before you leave.`
    : 'You can’t leave this workspace yet.';
}

export function leaveConfirmation(page: AccessPage) {
  const teams = page.access.teams.map(team => team.name).filter(name => name !== '_admin');
  return {
    title: 'Leave this workspace?',
    description: `You lose access to every table, chat and team here${teams.length ? `, including ${joinList(teams)}` : ''}. An admin must invite you again to come back.`,
    action: 'Leave workspace',
    run: async () => failed(await page.change('/leave', 'POST')),
  };
}

/** The Members → Settings tab: your role and leaving. */
export function MembersSettings({ page }: { page: AccessPage }) {
  const confirmation = useConfirmation();
  const { access } = page;
  return (
    <section aria-labelledby="members-settings-heading" className="flex max-w-2xl flex-col gap-6">
      <h2 id="members-settings-heading" className="sr-only">
        Settings
      </h2>
      <div className="flex flex-col gap-1">
        <h3 className="font-medium">Your role</h3>
        <p className="text-sm text-muted-foreground">
          {access.role === 'admin'
            ? 'Admin. You can manage members, teams and access to every table.'
            : 'Member. You can use the tables your teams and policies give you, and create teams.'}{' '}
          <span className="underline underline-offset-4">
            <Link
              to="/$workspaceSlug/members/$membershipId"
              params={{ workspaceSlug: page.workspaceSlug, membershipId: access.membershipId }}
            >
              View your access
            </Link>
          </span>
        </p>
      </div>
      <div className="flex flex-col items-start gap-2">
        <h3 className="font-medium">Leave workspace</h3>
        <p className="text-sm text-muted-foreground">
          {leaveReason(page) ?? 'You’ll lose access to everything in this workspace.'}
        </p>
        <Button
          variant="destructive"
          disabled={page.busy || !access.capabilities.canLeave}
          onClick={() => confirmation.open(leaveConfirmation(page))}
        >
          Leave workspace
        </Button>
      </div>
      {confirmation.element}
    </section>
  );
}
