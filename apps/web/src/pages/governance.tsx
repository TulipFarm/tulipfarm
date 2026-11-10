import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  policyChangeSchema,
  type GovernanceSnapshot,
  type OwnMembership,
  type PolicyPermission,
} from '@tulipfarm/workspaces/governance-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@tulipfarm/sprout/tabs';
import {
  governanceError,
  governancePath,
  governanceRequest,
  GovernanceRequestError,
  loadGovernance,
} from '@/lib/governance';
import { useGovernance } from '@/features/governance/queries';
import { useGovernanceChanges } from '@/features/governance/changes';
import { workspaceRoute } from '@/router';
import { describeChange, permissionSummary, scopeObject, sortPermissions } from '@/features/access/policies';
import type { SaveResult, ScopeChoice } from '@/features/access/policy-table';
import { MembersList, MembersSettings } from './access-members';
import { InviteMembers } from './access-invite';
import { MemberDetail } from './access-member';
import { TeamDetail, TeamsList } from './access-teams';
import { TableAccess } from './access-tables';

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
  | 'team-owns-archived-tables'
  | 'team-owns-agents'
  | 'team-owns-integrations'
>;

type Section = 'members' | 'teams' | 'settings' | 'grants' | 'invite' | 'edit-invite' | 'member' | 'team';
type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'member' | 'admin'; access: OwnMembership; data: GovernanceSnapshot };

/** Everything a members, teams or table-access page needs from the shared access shell. */
export type AccessPage = {
  workspaceId: string;
  workspaceSlug: string;
  admin: boolean;
  access: OwnMembership;
  data: GovernanceSnapshot;
  /** True while a change saves, access reloads, or loaded access is stale. */
  busy: boolean;
  change: GovernanceChange;
  /** Saves one policy and announces exactly what changed. */
  policy: (
    subject: { kind: 'team' | 'member'; id: string; name: string },
    scope: ScopeChoice,
    permissions: PolicyPermission[],
  ) => Promise<SaveResult>;
  notify: (message: string) => void;
  /** Shows a message on the next access page, such as after an invite returns to Members. */
  flash: (message: string) => void;
  accessLost: () => void;
  recovery: ReactNode;
};

// How long a save with an unknown outcome keeps trying to read the policy back.
const policyCheckLimit = 60_000;

/** The permissions a team or person holds on one policy scope in a snapshot. */
function heldPermissions(
  data: GovernanceSnapshot,
  subject: { kind: 'team' | 'member'; id: string },
  scope: ScopeChoice,
): PolicyPermission[] {
  const grants =
    subject.kind === 'team'
      ? data.grants.filter(grant => grant.teamId === subject.id)
      : data.personGrants.filter(grant => grant.membershipId === subject.id);
  return sortPermissions(
    grants
      .filter(grant => grant.target.kind === scope.kind && grant.target.id === scope.id)
      .map(grant => grant.target.permission),
  );
}

const samePermissions = (a: readonly PolicyPermission[], b: readonly PolicyPermission[]) =>
  a.length === b.length && a.every(permission => b.includes(permission));

/** Resolves after `delay`, or sooner when the browser comes back online. */
const reachable = (delay: number) =>
  new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener('online', done);
      resolve();
    };
    const timer = setTimeout(done, delay);
    window.addEventListener('online', done);
  });

// Survives the route change from one access page to another.
let flashed: { workspaceId: string; message: string } | null = null;

function AccessShell({ section }: { section: Section }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const params = useParams({ strict: false }) as { membershipId?: string; teamId?: string; invitationId?: string };
  return (
    <AccessContent
      key={`${workspace.id}:${section}:${params.membershipId ?? ''}:${params.teamId ?? ''}:${params.invitationId ?? ''}`}
      section={section}
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      membershipId={params.membershipId}
      teamId={params.teamId}
      invitationId={params.invitationId}
    />
  );
}

function AccessContent({
  section,
  workspaceId,
  workspaceSlug,
  membershipId,
  teamId,
  invitationId,
}: {
  section: Section;
  workspaceId: string;
  workspaceSlug: string;
  membershipId: string | undefined;
  teamId: string | undefined;
  invitationId: string | undefined;
}) {
  const navigate = useNavigate();
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
          ? { kind: 'unavailable', message: 'Your access to this workspace changed.' }
          : administration.state
      : membership.state.kind === 'unavailable'
        ? { kind: 'unavailable', message: 'Your access to this workspace changed.' }
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
  const [notice, setNotice] = useState<string | null>(() => {
    if (flashed?.workspaceId !== workspaceId) return null;
    const value = flashed.message;
    flashed = null;
    return value;
  });
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
  const ready = state.kind === 'admin' || state.kind === 'member';
  const writePending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const change: GovernanceChange = async (path, method, body) => {
    if (writePending.current || refreshing || stale) return 'rejected';
    writePending.current = true;
    setBusy(true);
    setMessage(null);
    setNotice(null);
    try {
      await governanceRequest(`${governancePath(workspaceId)}${path}`, method, body);
      if (
        path === '/leave' ||
        (state.kind !== 'loading' &&
          'access' in state &&
          method === 'DELETE' &&
          path === `/members/${state.access.membershipId}`)
      ) {
        changes.removed(workspaceId);
        return 'saved';
      }
      await changes.saved(path, method, body);
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
          error.code === 'invalid-team-description' ||
          error.code === 'team-owns-tables' ||
          error.code === 'team-owns-archived-tables' ||
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
  const policy: AccessPage['policy'] = async (subject, scope, permissions) => {
    if (writePending.current || refreshing || stale || (state.kind !== 'admin' && state.kind !== 'member'))
      return { ok: false, message: 'Another change is saving, or access needs reloading. Try again in a moment.' };
    writePending.current = true;
    setBusy(true);
    setMessage(null);
    setNotice(null);
    const before = heldPermissions(state.data, subject, scope);
    const done = () => {
      writePending.current = false;
      if (mounted.current) setBusy(false);
    };
    try {
      const result = policyChangeSchema.parse(
        await governanceRequest(`${governancePath(workspaceId)}/policies`, 'PUT', {
          subject: { kind: subject.kind, id: subject.id },
          scope: { kind: scope.kind, id: scope.id },
          permissions,
        }),
      );
      await changes.saved('/policies', 'PUT');
      if (mounted.current) setNotice(describeChange(subject.name, scopeObject(scope), result.added, result.removed));
      done();
      return { ok: true };
    } catch (error) {
      if (error instanceof GovernanceRequestError && [401, 403, 404].includes(error.status)) {
        done();
        void changes.accessLost();
        return { ok: false, message: 'You no longer have access to change this policy. Nothing was saved.' };
      }
      if (error instanceof GovernanceRequestError && error.status >= 400 && error.status < 500) {
        done();
        return { ok: false, message: `Nothing was saved. ${governanceError(error)}` };
      }
      // The outcome is unknown: read the policy back once TulipFarm is reachable and report what it is now.
      return {
        ok: false,
        message: 'We couldn’t confirm the change. Checking whether it was saved…',
        checking: confirmPolicy(subject, scope, before, permissions).finally(done),
      };
    }
  };
  async function confirmPolicy(
    subject: Parameters<AccessPage['policy']>[0],
    scope: ScopeChoice,
    before: PolicyPermission[],
    requested: PolicyPermission[],
  ): Promise<SaveResult> {
    const deadline = Date.now() + policyCheckLimit;
    const target = scopeObject(scope);
    for (let wait = 1000; ; wait = Math.min(wait * 2, 8000)) {
      try {
        const now = heldPermissions(
          await loadGovernance(workspaceId, AbortSignal.timeout(policyCheckLimit)),
          subject,
          scope,
        );
        await changes.saved('/policies', 'PUT');
        if (samePermissions(now, requested)) {
          const added = now.filter(permission => !before.includes(permission));
          const removed = before.filter(permission => !now.includes(permission));
          if (mounted.current) setNotice(describeChange(subject.name, target, added, removed));
          return { ok: true };
        }
        if (samePermissions(now, before))
          return {
            ok: false,
            message: before.length
              ? `Your change wasn’t saved. The policy for ${subject.name} on ${target} is unchanged: ${permissionSummary(now)}. Try again.`
              : `Your change wasn’t saved. There’s still no policy for ${subject.name} on ${target}. Try again.`,
          };
        return {
          ok: false,
          message: now.length
            ? `Your change may not have been saved because this policy was changed while you were editing. It now gives ${subject.name}: ${permissionSummary(now)} on ${target}. Check it before you save again.`
            : `Your change may not have been saved because this policy was changed while you were editing. There’s now no policy for ${subject.name} on ${target}. Check it before you save again.`,
        };
      } catch (error) {
        if (error instanceof GovernanceRequestError && [401, 403, 404].includes(error.status)) {
          void changes.accessLost();
          return { ok: false, message: 'You no longer have access to this policy, so we can’t check whether your change was saved. Ask a workspace admin to check it.' };
        }
        if (Date.now() + wait > deadline)
          return {
            ok: false,
            message:
              'We still can’t confirm whether your change was saved. Check your connection, then reload this page to see the current policy.',
          };
        await reachable(wait);
      }
    }
  }
  const listing = section === 'members' || section === 'teams' || section === 'settings';
  const page: AccessPage | null = ready
    ? {
        workspaceId,
        workspaceSlug,
        admin: state.kind === 'admin',
        access: state.access,
        data: state.data,
        busy: busy || refreshing || stale,
        change,
        policy,
        notify: value => setNotice(value),
        flash: value => {
          flashed = { workspaceId, message: value };
        },
        accessLost: () => void changes.accessLost(),
        recovery,
      }
    : null;
  const members = { label: 'Members', link: <Link to="/$workspaceSlug/members" params={{ workspaceSlug }} /> };
  const header =
    section === 'grants' ? (
      <PageHeader
        titleId="governance-heading"
        focusable
        title="Table access"
        description="Who can use each table, and which policy gives them that access."
      />
    ) : listing ? (
      <PageHeader
        titleId="governance-heading"
        focusable
        title="Members"
        description="People in this workspace, the teams they belong to, and what they can access."
      />
    ) : section === 'invite' ? (
      <PageHeader titleId="governance-heading" focusable parent={members} title="Invite members" />
    ) : section === 'edit-invite' ? (
      <PageHeader titleId="governance-heading" focusable parent={members} title="Edit invite" />
    ) : section === 'member' ? (
      <PageHeader
        titleId="governance-heading"
        focusable
        parent={members}
        title={
          (ready &&
            (state.data.directory.find(member => member.id === membershipId)?.name ||
              state.data.directory.find(member => member.id === membershipId)?.email)) ||
          'Member'
        }
      />
    ) : (
      <PageHeader
        titleId="governance-heading"
        focusable
        parent={{ label: 'Teams', link: <Link to="/$workspaceSlug/teams" params={{ workspaceSlug }} /> }}
        title={(ready && state.data.teams.find(team => team.id === teamId)?.name) || 'Team'}
      />
    );
  return (
    <PageContent>
      {header}
      {listing && (
        <Tabs
          value={section}
          onValueChange={value => {
            if (value === 'members') void navigate({ to: '/$workspaceSlug/members', params: { workspaceSlug } });
            if (value === 'teams') void navigate({ to: '/$workspaceSlug/teams', params: { workspaceSlug } });
            if (value === 'settings')
              void navigate({ to: '/$workspaceSlug/members/settings', params: { workspaceSlug } });
          }}
        >
          <TabsList variant="line" aria-label="Members sections">
            <TabsTrigger value="members">All members</TabsTrigger>
            <TabsTrigger value="teams">Teams</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      {state.kind === 'loading' && (
        <div role="status" className="flex flex-col gap-4">
          <span className="sr-only">Loading workspace access…</span>
          <Skeleton shape="title" />
          <Skeleton shape="panel" />
        </div>
      )}
      {state.kind === 'error' && (
        <StatePanel kind="error" title="Couldn’t load workspace access" description={state.message}>
          <Button variant="outline" disabled={refreshing} onClick={() => void refresh()}>
            Try again
          </Button>
        </StatePanel>
      )}
      {state.kind === 'unavailable' && (
        <StatePanel kind="unavailable" title="You can’t view this page" description={state.message}>
          <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
            Back to TulipFarm
          </Button>
        </StatePanel>
      )}
      {page && (
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
                  ? 'Access shown here may be out of date. Reload before making another change.'
                  : 'Reload to check current access. Reloading doesn’t repeat your change.'}
              </p>
              {recovery}
            </div>
          )}
          {/* Always rendered with a reserved line so saving and saved messages don't move the controls below. */}
          <p role="status" className="flex min-h-6 items-center gap-2">
            {busy ? (
              <>
                <Spinner aria-hidden="true" />
                Saving…
              </>
            ) : (
              notice
            )}
          </p>
          {section === 'members' && <MembersList page={page} />}
          {section === 'teams' && <TeamsList page={page} />}
          {section === 'settings' && <MembersSettings page={page} />}
          {section === 'invite' && <InviteMembers page={page} />}
          {section === 'edit-invite' && invitationId && (
            <InviteMembers key={invitationId} page={page} invitationId={invitationId} />
          )}
          {section === 'member' && membershipId && <MemberDetail page={page} membershipId={membershipId} />}
          {section === 'team' && teamId && <TeamDetail page={page} teamId={teamId} />}
          {section === 'grants' && <TableAccess page={page} />}
        </>
      )}
    </PageContent>
  );
}

export const MembersPage = () => <AccessShell section="members" />;
export const MembersSettingsPage = () => <AccessShell section="settings" />;
export const InviteMembersPage = () => <AccessShell section="invite" />;
export const EditInvitePage = () => <AccessShell section="edit-invite" />;
export const MemberDetailPage = () => <AccessShell section="member" />;
export const TeamsPage = () => <AccessShell section="teams" />;
export const TeamDetailPage = () => <AccessShell section="team" />;
export const GrantsPage = () => <AccessShell section="grants" />;
