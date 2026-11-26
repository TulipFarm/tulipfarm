import { useMemo } from 'react';
import { Link, Navigate, useNavigate } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { workspaceMemberAccess, workspaceMemberFields } from '@tulipfarm/tables/workspace-members';
import { MemberProfileCard, memberInactive, memberName, memberText, useRemovePerson } from '@/features/access/people';
import { useConfirmation } from '@/features/access/confirm';
import { tableApi, type TableApi } from '@/features/tables/api';
import { TableRead } from '@/features/tables/feedback';
import { useMembersTable, useTableRow, type MembersTable } from '@/features/tables/hooks';
import type { TableValues } from '@/features/tables/review-contracts';
import type { AccessPage } from './governance';

const hasNoAccount = (values: TableValues) => {
  const access = values[workspaceMemberFields.access];
  return access?.kind === 'single-select' && access.optionId === workspaceMemberAccess.none;
};

/** The page title for one person in Members: their name once loaded. */
export function PersonTitle({ workspaceId, memberId }: { workspaceId: string; memberId: string }) {
  const api = useMemo(() => tableApi(workspaceId), [workspaceId]);
  const members = useMembersTable(api, workspaceId);
  return members.state.kind === 'ready' ? (
    <PersonName api={api} members={members.state.data} memberId={memberId} />
  ) : (
    'Person'
  );
}

function PersonName({ api, members, memberId }: { api: TableApi; members: MembersTable; memberId: string }) {
  const row = useTableRow(api, members.table, memberId);
  return row.state.kind === 'ready' && row.state.data ? memberName(row.state.data.values) : 'Person';
}

/** One person in Members. People with an account open their member page when the viewer may see it. */
export function PersonDetail({ page, memberId }: { page: AccessPage; memberId: string }) {
  const api = useMemo(() => tableApi(page.workspaceId), [page.workspaceId]);
  const members = useMembersTable(api, page.workspaceId);
  const account = page.data.directory.find(member => member.workspaceMemberId === memberId);
  if (account && (page.admin || account.id === page.access.membershipId))
    return (
      <Navigate
        to="/$workspaceSlug/members/$membershipId"
        params={{ workspaceSlug: page.workspaceSlug, membershipId: account.id }}
        replace
      />
    );
  return (
    <TableRead state={members.state} refresh={members.refresh}>
      {table => <Person page={page} api={api} members={table} memberId={memberId} />}
    </TableRead>
  );
}

function Person({
  page,
  api,
  members,
  memberId,
}: {
  page: AccessPage;
  api: TableApi;
  members: MembersTable;
  memberId: string;
}) {
  const navigate = useNavigate();
  const confirmation = useConfirmation();
  const remove = useRemovePerson(api, members);
  const row = useTableRow(api, members.table, memberId);
  const current = row.state.kind === 'ready' ? row.state.data : null;
  const workspace = { id: page.workspaceId, slug: page.workspaceSlug, sessionId: page.sessionId };
  const manual = current !== null && hasNoAccount(current.values);
  const name = current ? memberName(current.values) : '';
  const actions = manual && (
    <>
      {page.admin && !memberInactive(current.values) && (
        <Button
          size="sm"
          nativeButton={false}
          render={
            <Link
              to="/$workspaceSlug/members/invite"
              params={{ workspaceSlug: page.workspaceSlug }}
              search={{
                member: current.id,
                email: memberText(current.values, workspaceMemberFields.contactEmail) || undefined,
                name,
              }}
            />
          }
        >
          Invite to workspace
        </Button>
      )}
      {members.permissions.delete && (
        <Button
          size="sm"
          variant="destructive"
          disabled={page.busy}
          onClick={() =>
            confirmation.open({
              title: `Remove ${name}?`,
              description: `${name} and their profile details are removed from Members.`,
              action: 'Remove',
              run: async () => {
                const reason = await remove(current);
                if (reason) return reason;
                page.flash(`Removed ${name} from Members.`);
                void navigate({ to: '/$workspaceSlug/members', params: { workspaceSlug: page.workspaceSlug } });
                return null;
              },
            })
          }
        >
          Remove
        </Button>
      )}
    </>
  );
  return (
    <>
      <MemberProfileCard workspace={workspace} api={api} members={members} memberId={memberId} actions={actions} />
      {confirmation.element}
    </>
  );
}

/** The Members profile card on an account member's page. */
export function AccountProfile({ page, memberId }: { page: AccessPage; memberId: string }) {
  const api = useMemo(() => tableApi(page.workspaceId), [page.workspaceId]);
  const members = useMembersTable(api, page.workspaceId);
  const workspace = { id: page.workspaceId, slug: page.workspaceSlug, sessionId: page.sessionId };
  if (members.state.kind === 'unavailable') return null;
  return (
    <TableRead state={members.state} refresh={members.refresh}>
      {table => <MemberProfileCard workspace={workspace} api={api} members={table} memberId={memberId} />}
    </TableRead>
  );
}
