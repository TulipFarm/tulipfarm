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
import { governanceError, governancePath, governanceRequest, GovernanceRequestError } from '@/lib/governance';
import { useGovernance } from '@/features/governance/queries';
import { useGovernanceChanges } from '@/features/governance/changes';
import { workspaceRoute } from '@/router';
import { describeChange, scopeObject } from '@/features/access/policies';
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

type Section = 'members' | 'teams' | 'settings' | 'grants' | 'invite' | 'member' | 'team';
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

// Survives the route change from one access page to another.
let flashed: { workspaceId: string; message: string } | null = null;

function AccessShell({ section }: { section: Section }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const params = useParams({ strict: false }) as { membershipId?: string; teamId?: string };
  return (
    <AccessContent
      key={`${workspace.id}:${section}:${params.membershipId ?? ''}:${params.teamId ?? ''}`}
      section={section}
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      membershipId={params.membershipId}
      teamId={params.teamId}
    />
  );
}

function AccessContent({
  section,
  workspaceId,
  workspaceSlug,
  membershipId,
  teamId,
}: {
  section: Section;
  workspaceId: string;
  workspaceSlug: string;
  membershipId: string | undefined;
  teamId: string | undefined;
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
    if (writePending.current || refreshing || stale)
      return { ok: false, message: 'Another change is saving, or access needs reloading. Try again in a moment.' };
    writePending.current = true;
    setBusy(true);
    setMessage(null);
    setNotice(null);
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
      return { ok: true };
    } catch (error) {
      if (error instanceof GovernanceRequestError && [401, 403, 404].includes(error.status)) {
        void changes.accessLost();
        return { ok: false, message: 'You no longer have access to change this policy. Nothing was saved.' };
      }
      if (error instanceof GovernanceRequestError && error.status >= 400 && error.status < 500)
        return { ok: false, message: `Nothing was saved. ${governanceError(error)}` };
      return {
        ok: false,
        message:
          'We couldn’t confirm the change. Close this and reload access to check the policy before trying again.',
      };
    } finally {
      writePending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const ready = state.kind === 'admin' || state.kind === 'member';
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
export const MemberDetailPage = () => <AccessShell section="member" />;
export const TeamsPage = () => <AccessShell section="teams" />;
export const TeamDetailPage = () => <AccessShell section="team" />;
export const GrantsPage = () => <AccessShell section="grants" />;
