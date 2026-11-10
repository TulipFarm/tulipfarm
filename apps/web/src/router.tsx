import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { filesSearchSchema, viewerSearchSchema } from '@/features/files/search';
import { tableListSearchSchema, tableRowsSearchSchema } from '@/features/tables/table-search';
import { googleFileIdSchema, googleFilesSearchSchema } from '@/features/files/google-search';
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Link,
  notFound,
  redirect,
  Outlet,
  useLocation,
  useMatch,
  useRouter,
  useRouterState,
  type ErrorComponentProps,
} from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import {
  authClient,
  loadSession,
  releaseGuardSessionHold,
  routeGuardsSaw,
  safeAuthRedirect,
  sessionIdentity,
} from '@/lib/auth';
import {
  forgetSession,
  forgetWorkspace,
  forgetWorkspaceId,
  lastSession,
  rememberSession,
  rememberWorkspaceId,
  workspaceDestination,
  workspaceIdHint,
} from '@/lib/last-workspace';
import { pendingInvitationDestination } from '@/lib/pending-invitation';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { workspaceSlugError } from '@/lib/workspace-slug';
import { currentIntegrationId } from '@/features/integrations/catalog';
import { getWorkspace, listWorkspaces, WorkspaceRequestError } from '@/lib/workspaces';
import { readWorkspaceList, sessionRuntime, WorkspaceListQueryBridge } from '@/features/workspaces/queries';
import { reconcileMembership } from '@/features/governance/queries';
import {
  invitationTokenSchema,
  ownMembershipSchema,
  type OwnMembership,
} from '@tulipfarm/workspaces/governance-contracts';
import { workspaceListSchema, workspaceSchema } from '@tulipfarm/workspaces/contracts';
import { RecoveryNotice, WorkspaceRecoveryPage } from '@/pages/workspace-recovery';
import { workspacePageScroller } from '@/lib/page-scroller';
import { accountCallbackResultSchema } from '@tulipfarm/atlassian/callback-contracts';
import { googleCallbackResultSchema } from '@tulipfarm/google-workspace/callback-contracts';
import { workflowPageSearch } from '@/features/workflows/page-search';
import { calendarSearchSchema } from '@/features/calendar/model';
import { agentTabValues } from '@/features/agents/tab-values';
import { createWorkspaceAccess } from '@/lib/workspace-access';
import { loadOwnMembership, GovernanceRequestError } from '@/lib/governance';
import { hashKey } from '@tanstack/react-query';
import {
  SessionQueryProvider,
  type FeatureScope,
  type QueryKey,
  type SessionIdentity,
  type WorkspaceScope,
} from '@/lib/query';
import { startEarlyReads } from '@/lib/query/early-reads';
import { persistedReads } from '@/lib/query/persisted-reads';
import { holdWrites } from '@/lib/http';
import { measureWorkspaceAdmission } from '@/lib/navigation-performance';
import { UserVisitProvider } from '@/lib/user-visit';
import { analytics, overrides } from '@/extensions';
import { isAssetLoadError, reloadOnceForAssetError } from '@/lib/asset-recovery';
import { routeErrorEvent, routeErrorProperties } from '@/lib/route-error-report';
import { onWindowReturn } from '@/lib/window-return';
import { retryAdmission, temporaryAdmissionError } from '@/lib/admission-retry';

// Admission and 401/403 responses already catch revocation; this only bounds how long a
// background tab can keep showing a workspace after another person removes access.
const accessCheckInterval = 60_000;

const MembersPage = lazyRouteComponent(() => import('@/pages/governance'), 'MembersPage');
const InboxPage = lazyRouteComponent(() => import('@/pages/workspace'), 'InboxPage');
const WorkspaceShell = lazyRouteComponent(() => import('@/pages/workspace'), 'WorkspaceShell');
const LoginPage = lazyRouteComponent(() => import('@/pages/login'), 'LoginPage');
const RegisterPage = lazyRouteComponent(() => import('@/pages/auth'), 'RegisterPage');
const ForgotPasswordPage = lazyRouteComponent(() => import('@/pages/password'), 'ForgotPasswordPage');
const ResetPasswordPage = lazyRouteComponent(() => import('@/pages/password'), 'ResetPasswordPage');
const VerifyEmailPage = lazyRouteComponent(() => import('@/pages/auth'), 'VerifyEmailPage');
const LogoutPage = lazyRouteComponent(() => import('@/pages/auth'), 'LogoutPage');
const CompleteProfilePage = lazyRouteComponent(() => import('@/pages/auth'), 'CompleteProfilePage');
const CreateWorkspacePage = lazyRouteComponent(() => import('@/pages/create-workspace'), 'CreateWorkspacePage');
const OnboardingPage = lazyRouteComponent(() => import('@/pages/onboarding'), 'OnboardingPage');
const OnboardingChatPage = lazyRouteComponent(() => import('@/pages/onboarding'), 'OnboardingChatPage');
const WorkspaceSetupStatusPage = lazyRouteComponent(
  () => import('@/pages/workspace-setup-status'),
  'WorkspaceSetupStatusPage',
);
const JoinWorkspacePage = lazyRouteComponent(() => import('@/pages/governance-invitations'), 'JoinWorkspacePage');
const SlackLinkPage = lazyRouteComponent(() => import('@/pages/slack-link'), 'SlackLinkPage');
const GoogleCallbackPage = lazyRouteComponent(() => import('@/pages/google-callback'), 'GoogleCallbackPage');
const GitHubCallbackPage = lazyRouteComponent(() => import('@/pages/github-callback'), 'GitHubCallbackPage');
const AtlassianCallbackPage = lazyRouteComponent(() => import('@/pages/atlassian-callback'), 'AtlassianCallbackPage');
const WorkspaceHomePage = lazyRouteComponent(() => import('@/pages/workspace-home'), 'WorkspaceHomePage');
const WorkspaceChatsPage = lazyRouteComponent(() => import('@/pages/workspace-chats'), 'WorkspaceChatsPage');
const TeamsPage = lazyRouteComponent(() => import('@/pages/governance'), 'TeamsPage');
const GrantsPage = lazyRouteComponent(() => import('@/pages/governance'), 'GrantsPage');
const InviteMembersPage = lazyRouteComponent(() => import('@/pages/governance'), 'InviteMembersPage');
const EditInvitePage = lazyRouteComponent(() => import('@/pages/governance'), 'EditInvitePage');
const MembersSettingsPage = lazyRouteComponent(() => import('@/pages/governance'), 'MembersSettingsPage');
const MemberDetailPage = lazyRouteComponent(() => import('@/pages/governance'), 'MemberDetailPage');
const TeamDetailPage = lazyRouteComponent(() => import('@/pages/governance'), 'TeamDetailPage');
const TablesPage = lazyRouteComponent(() => import('@/pages/tables'), 'TablesPage');
const TableDetailPage = lazyRouteComponent(() => import('@/pages/tables'), 'TableDetailPage');
const NewTablePage = lazyRouteComponent(() => import('@/pages/tables'), 'NewTablePage');
const EditTablePage = lazyRouteComponent(() => import('@/pages/tables'), 'EditTablePage');
const AgentsPage = lazyRouteComponent(() => import('@/pages/agents'), 'AgentsPage');
const NewAgentPage = lazyRouteComponent(() => import('@/pages/agents'), 'NewAgentPage');
const AgentDetailPage = lazyRouteComponent(() => import('@/pages/agents'), 'AgentDetailPage');
const ProjectsPage = lazyRouteComponent(() => import('@/pages/projects'), 'ProjectsPage');
const FilesPage = lazyRouteComponent(() => import('@/pages/files'), 'FilesPage');
const FilePage = lazyRouteComponent(() => import('@/pages/file'), 'FilePage');
const GoogleFilePage = lazyRouteComponent(() => import('@/pages/google-file'), 'GoogleFilePage');
const ProjectDetailPage = lazyRouteComponent(() => import('@/pages/projects'), 'ProjectDetailPage');
const ProjectSettingsPage = lazyRouteComponent(() => import('@/pages/projects'), 'ProjectSettingsPage');
const SkillsPage = lazyRouteComponent(() => import('@/pages/skills'), 'SkillsPage');
const SystemPackagesPage = lazyRouteComponent(() => import('@/pages/system-packages'), 'SystemPackagesPage');
const PublicPackagePage = lazyRouteComponent(() => import('@/pages/system-packages'), 'PublicPackagePage');
const SystemPackagePage = lazyRouteComponent(() => import('@/pages/system-packages'), 'SystemPackagePage');
const ImportSkillPage = lazyRouteComponent(() => import('@/features/skills/import-flow'), 'ImportSkillPage');
const SkillImportPage = lazyRouteComponent(() => import('@/features/skills/import-flow'), 'SkillImportPage');
const SkillDetailPage = lazyRouteComponent(() => import('@/pages/skills'), 'SkillDetailPage');
const AgentTasksPage = lazyRouteComponent(() => import('@/pages/agent-tasks'), 'AgentTasksPage');
const AgentTaskPage = lazyRouteComponent(() => import('@/pages/agent-tasks'), 'AgentTaskPage');
const IntegrationsPage = lazyRouteComponent(() => import('@/pages/integrations'), 'IntegrationsPage');
const IntegrationDetailPage = lazyRouteComponent(() => import('@/pages/integration-detail'), 'IntegrationDetailPage');
const ModelsPage = lazyRouteComponent(() => import('@/pages/models'), 'ModelsPage');
const SettingsPage = lazyRouteComponent(() => import('@/pages/settings'), 'SettingsPage');
const AccountSettingsPage = lazyRouteComponent(() => import('@/pages/account-settings'), 'AccountSettingsPage');
const SecretsSettingsPage = lazyRouteComponent(() => import('@/pages/secrets-settings'), 'SecretsSettingsPage');

function NotFoundPanel() {
  return (
    <StatePanel
      heading="h1"
      kind="unavailable"
      title="Page not found"
      description="Check the URL or return to a workspace you can access."
    >
      <Button nativeButton={false} render={<Link to="/" />}>
        Back to TulipFarm
      </Button>
      <Button variant="outline" nativeButton={false} render={<Link to="/account/workspace-recovery" />}>
        Recover workspace changes
      </Button>
    </StatePanel>
  );
}

function NotFoundPage() {
  return (
    <main className="flex min-h-svh items-center justify-center">
      <NotFoundPanel />
    </main>
  );
}

/** Inside the admitted workspace shell, the shell owns the main landmark; an unknown workspace has no shell. */
function WorkspaceNotFoundPage() {
  const inShell = useMatch({ from: '/$workspaceSlug', shouldThrow: false })?.status === 'success';
  if (!inShell) return <NotFoundPage />;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
      <NotFoundPanel />
    </div>
  );
}

function SessionLayout() {
  const router = useRouter();
  const pathname = useLocation({ select: location => location.pathname });
  const { data: session, isPending, error } = authClient.useSession();
  useEffect(() => releaseGuardSessionHold(), []);
  const admission = useRouterState({
    select: state => state.matches.find(match => match.routeId === workspaceRoute.id)?.context,
  });
  const previousSession = useRef<string | undefined>(undefined);
  const observedSession = useRef(false);
  const queryAuthorityLost = useCallback(
    (scope: FeatureScope) => {
      const admitted = router.state.matches.find(match => match.routeId === workspaceRoute.id)?.context;
      if (
        admitted?.user?.id === scope.userId &&
        (scope.kind === 'account' ||
          (admitted.workspace?.id === scope.workspaceId && admitted.membershipId === scope.membershipId))
      ) {
        const snapshot = admitted.workspaceAccess.getSnapshot();
        if (snapshot.kind === 'admitted') admitted.workspaceAccess.clear();
      }
      if (scope.kind === 'account') void authClient.getSession({ query: { disableCookieCache: true } });
      void router.invalidate();
    },
    [router],
  );
  const identity = sessionIdentity(session);
  useEffect(() => {
    const access = router.state.matches.find(match => match.routeId === workspaceRoute.id)?.context.workspaceAccess;
    if (error?.status === 401) {
      observedSession.current = true;
      previousSession.current = undefined;
      access?.clear();
      void forgetSession();
      return;
    }
    if (isPending || error || previousSession.current === identity) return;
    const admitted = router.state.matches.find(match => match.routeId === workspaceRoute.id)?.context;
    if (
      !session ||
      (admitted?.user && (admitted.user.id !== session.user.id || admitted.sessionId !== session.session.id))
    )
      access?.clear();
    const alreadyAdmitted =
      previousSession.current === undefined &&
      session &&
      admitted?.user?.id === session.user.id &&
      admitted.sessionId === session.session.id &&
      admitted.user.name === session.user.name &&
      admitted.workspaceAccess.getSnapshot().kind === 'admitted';
    const firstObservation = !observedSession.current;
    observedSession.current = true;
    previousSession.current = identity;
    // Route guards read this same session store, so the first session this layout sees
    // was already checked by them. Later changes, including recovery after a 401, re-run guards.
    if (alreadyAdmitted || (firstObservation && routeGuardsSaw(identity))) return;
    void router.invalidate();
  }, [identity, session, isPending, error, router]);
  useEffect(() => {
    const refresh = () => {
      void router.invalidate();
    };
    let checkedAt = -Infinity;
    const checkAccess = async () => {
      const match = router.state.matches.find(match => match.routeId === workspaceRoute.id);
      const slug = match?.params.workspaceSlug;
      const admitted = match?.context;
      if (!slug || !admitted?.user || !admitted.sessionId || Date.now() - checkedAt < accessCheckInterval) return;
      checkedAt = Date.now();
      const deny = admitted.workspaceAccess.observe({ slug, userId: admitted.user.id, sessionId: admitted.sessionId });
      try {
        const workspace = await getWorkspace(slug);
        if (workspace.status === 'ready') {
          const membership = await loadOwnMembership(workspace.id, AbortSignal.timeout(15_000));
          if (membership.membershipId !== admitted.membershipId) {
            deny(403);
            void router.invalidate();
          } else if (
            reconcileMembership(
              { userId: admitted.user.id, sessionId: admitted.sessionId },
              workspace.id,
              admitted.membership,
              membership,
            )
          )
            void router.invalidate();
        }
      } catch (error) {
        if (
          (error instanceof WorkspaceRequestError || error instanceof GovernanceRequestError) &&
          [401, 403, 404].includes(error.status)
        )
          deny(error.status);
      }
    };
    const stopReturn = onWindowReturn(() => {
      void checkAccess();
    });
    window.addEventListener('tulipfarm:workspace-access-changed', refresh);
    return () => {
      stopReturn();
      window.removeEventListener('tulipfarm:workspace-access-changed', refresh);
    };
  }, [router]);
  const showRecovery =
    !pathname.endsWith('/settings') &&
    !pathname.endsWith('/settings/models') &&
    pathname !== '/account/workspace-recovery';
  const queryIdentity =
    error?.status === 401
      ? null
      : session
        ? { userId: session.user.id, sessionId: session.session.id }
        : (isPending || error) &&
            admission?.user &&
            admission.sessionId &&
            admission.workspaceAccess.getSnapshot().kind === 'admitted'
          ? { userId: admission.user.id, sessionId: admission.sessionId }
          : null;
  const workspaceListChanged = useCallback(() => {
    void router.invalidate();
  }, [router]);
  // A provisional list came from disk; seeding it would let the admission check read it back unchecked.
  const initialWorkspaces =
    !admission?.workspaceProvisional &&
    admission?.user?.id === queryIdentity?.userId &&
    admission?.sessionId === queryIdentity?.sessionId
      ? admission?.workspaces
      : undefined;
  return (
    <SessionQueryProvider identity={queryIdentity} onAuthorityLost={queryAuthorityLost}>
      <UserVisitProvider identity={queryIdentity}>
        {queryIdentity && (
          <WorkspaceListQueryBridge initialWorkspaces={initialWorkspaces} onChanged={workspaceListChanged} />
        )}
        {session && !isPending && !error && showRecovery && (
          <RecoveryNotice key={session.user.id} userId={session.user.id} />
        )}
        <Outlet />
      </UserVisitProvider>
    </SessionQueryProvider>
  );
}

function RouteErrorPage({ error }: ErrorComponentProps) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  const assetFailure = isAssetLoadError(error);
  // Reload only once a route is blocked. A failed background prefetch must not discard unsaved input.
  useEffect(() => {
    if (assetFailure) reloadOnceForAssetError();
  }, [assetFailure]);
  useEffect(() => {
    analytics.capture(routeErrorEvent, routeErrorProperties(error, assetFailure));
  }, [error, assetFailure]);
  return (
    <main className="flex min-h-svh items-center justify-center">
      <StatePanel
        heading="h1"
        kind="error"
        title="Could not open TulipFarm"
        description={
          assetFailure
            ? 'Page code could not load. TulipFarm may have been updated, or the connection dropped. Try again will reload this page.'
            : 'We couldn’t load your account or workspace. Check your connection and try again.'
        }
      >
        <Button
          disabled={retrying}
          aria-busy={retrying}
          onClick={async () => {
            setRetrying(true);
            if (assetFailure) {
              window.location.reload();
              return;
            }
            try {
              await router.invalidate({ sync: true });
            } finally {
              setRetrying(false);
            }
          }}
        >
          {retrying && <Spinner aria-hidden="true" />}
          {retrying ? 'Trying again…' : 'Try again'}
        </Button>
        <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
          Back to TulipFarm
        </Button>
      </StatePanel>
    </main>
  );
}

const rootRoute = createRootRoute({ component: SessionLayout, notFoundComponent: NotFoundPage });
const githubCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/github/callback',
  component: GitHubCallbackPage,
});
// The GitHub App's setup URL: GitHub sends people here after they install or update the App.
const githubSetupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/integrations/github',
  component: GitHubCallbackPage,
});
export const atlassianCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/atlassian/callback',
  component: AtlassianCallbackPage,
  validateSearch: search => {
    const result = accountCallbackResultSchema.safeParse(search);
    return result.success ? result.data : accountCallbackResultSchema.parse({ outcome: 'error' });
  },
});
export const googleCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/google-workspace/callback',
  component: GoogleCallbackPage,
  validateSearch: search => {
    const result = googleCallbackResultSchema.safeParse(search);
    return result.success ? result.data : googleCallbackResultSchema.parse({ outcome: 'invalid-request' });
  },
});
// TanStack Router preloads route components only after every beforeLoad settles. Session
// gates start the matched routes' code at once so it downloads during the session check.
// This fetches public bundle code only; private data still waits for the guards.
function preloadRouteCode(pathname: string): void {
  for (const route of router.getMatchedRoutes(pathname)[0]) void route.options.component?.preload?.();
}
type PageReadModule = typeof import('@/features/chat/early-reads');
let pageReadModule: Promise<PageReadModule> | null = null;
function loadPageReads() {
  pageReadModule ??= import('@/features/chat/early-reads').then(
    module => {
      persistedReads.configure(module.persistedPageReads);
      return module;
    },
    error => {
      pageReadModule = null;
      throw error;
    },
  );
  return pageReadModule;
}
function cachedRead(identity: SessionIdentity, workspaceId: string, key: QueryKey) {
  const scope = ['user', identity.userId, 'workspace', workspaceId];
  const hash = hashKey(key);
  return !!sessionRuntime(identity)
    ?.client.getQueryCache()
    .findAll({ queryKey: scope })
    .some(query => query.state.data !== undefined && hashKey(query.queryKey.slice(scope.length + 2)) === hash);
}
/**
 * Starts the reads the destination page makes first, once the workspace id is known, so they
 * overlap membership admission instead of waiting for the frame to mount. Reads the cache already
 * holds are skipped, and the page only uses a response after admission binds it to the membership.
 * Reads still waiting for their code when admission settles never start, so they cannot race the
 * page's own reads.
 */
function startPageReads(
  identity: SessionIdentity,
  workspaceId: string,
  slug: string,
  location: { pathname: string; search: Record<string, unknown> },
) {
  let settled = false;
  let reads: ReturnType<typeof startEarlyReads> | null = null;
  void loadPageReads().then(
    module => {
      if (settled) return;
      const pending = module
        .workspacePageReads(workspaceId, slug, location.pathname, location.search)
        .filter(read => !cachedRead(identity, workspaceId, read.key));
      if (pending.length) reads = startEarlyReads(identity, workspaceId, pending);
    },
    () => {},
  );
  return {
    workspaceId,
    admit(membershipId: string) {
      settled = true;
      reads?.admit(membershipId);
    },
    discard() {
      settled = true;
      reads?.discard();
    },
  };
}
async function requireProfile(destination: string) {
  const session = await loadSession();
  if (!session) {
    void forgetSession();
    throw redirect({ to: '/login', search: { redirect: destination }, replace: true });
  }
  rememberSession({ userId: session.user.id, sessionId: session.session.id });
  if (!session.user.name.trim())
    throw redirect({ to: '/complete-profile', search: { redirect: safeAuthRedirect(destination) }, replace: true });
  return session;
}
type AuthSession = NonNullable<Awaited<ReturnType<typeof loadSession>>>;
type WorkspaceRead = Awaited<ReturnType<typeof getWorkspace>>;
type WorkspaceContext = {
  user: AuthSession['user'];
  sessionId: string;
  accessRevision: number;
  membershipId: string | null;
  membership: OwnMembership | null;
  workspace: WorkspaceRead;
  workspaces: WorkspaceRead[];
  workspaceStale: boolean;
  /** Shown from disk while the session and membership are still being checked. Writes wait for the check. */
  workspaceProvisional: boolean;
};
const onIntegrationsPage = (slug: string, pathname: string) =>
  pathname === `/${slug}/integrations` || pathname.startsWith(`/${slug}/integrations/`);
/** Workspace reads for a remembered session, started before the session check confirms it. */
function startAdmissionReads(
  identity: SessionIdentity,
  slug: string,
  location: { pathname: string; search: Record<string, unknown> },
  cause: string,
) {
  const controller = new AbortController();
  const hintedId = workspaceIdHint(identity.userId, slug);
  const reads = {
    identity,
    hintedId,
    workspace: getWorkspace(slug, controller.signal),
    list: cause === 'stay' ? listWorkspaces(controller.signal) : readWorkspaceList(identity),
    membership: hintedId ? loadOwnMembership(hintedId, controller.signal) : null,
    pageReads: hintedId ? startPageReads(identity, hintedId, slug, location) : null,
  };
  for (const read of [reads.workspace, reads.list, reads.membership]) void read?.catch(() => {});
  return {
    ...reads,
    discard() {
      controller.abort();
      reads.pageReads?.discard();
    },
  };
}
// Disk reads that take longer than this fall back to waiting for the network.
const provisionalWait = 300;
const admissionSnapshotSchema = z.object({
  user: z.looseObject({ id: z.string().min(1), name: z.string().trim().min(1), email: z.string() }),
  workspace: workspaceSchema,
  workspaces: workspaceListSchema,
  membership: ownMembershipSchema,
});
/**
 * The workspace admission this session last confirmed for the slug, and the reads persisted with it,
 * if they are young enough to show before the session and membership checks return.
 */
async function provisionalAdmission(identity: SessionIdentity, slug: string, pathname: string) {
  // Integration controls change workspace connections, so those pages always wait for the checks.
  if (onIntegrationsPage(slug, pathname)) return null;
  const read = async () => {
    const [, snapshot] = await Promise.all([
      loadPageReads(),
      persistedReads.restoreAdmission(identity.userId, slug, admissionSnapshotSchema),
    ]);
    if (
      !snapshot ||
      snapshot.sessionId !== identity.sessionId ||
      snapshot.read.user.id !== identity.userId ||
      snapshot.read.workspace.status !== 'ready' ||
      snapshot.read.workspace.slug !== slug
    )
      return null;
    const scope: WorkspaceScope = {
      kind: 'workspace',
      userId: identity.userId,
      workspaceId: snapshot.read.workspace.id,
      membershipId: snapshot.read.membership.membershipId,
    };
    return {
      identity,
      scope,
      reads: await persistedReads.restore(scope),
      read: { ...snapshot.read, user: snapshot.read.user as AuthSession['user'] },
    };
  };
  return Promise.race([
    read().catch(() => null),
    new Promise<null>(resolve => setTimeout(resolve, provisionalWait, null)),
  ]);
}
type VerifiedAdmission = { context: WorkspaceContext | null; slug: string; pathname: string; revision: number };
const verifiedAdmissions = new WeakMap<ReturnType<typeof createWorkspaceAccess>, VerifiedAdmission>();
/** A settled provisional check, once, if nothing has admitted or denied the workspace since. */
function takeVerifiedAdmission(access: ReturnType<typeof createWorkspaceAccess>, slug: string, pathname: string) {
  const verified = verifiedAdmissions.get(access);
  if (!verified || verified.slug !== slug) return null;
  verifiedAdmissions.delete(access);
  const snapshot = access.getSnapshot();
  if (verified.pathname !== pathname || snapshot.revision !== verified.revision) return null;
  return verified.context && snapshot.kind === 'admitted' && snapshot.revision === verified.context.accessRevision
    ? verified
    : { ...verified, context: null };
}
async function defaultWorkspaceDestination(destination: string) {
  const session = await requireProfile(destination);
  let workspaces;
  try {
    workspaces = await readWorkspaceList({ userId: session.user.id, sessionId: session.session.id });
  } catch (error) {
    if (error instanceof WorkspaceRequestError && error.status === 401)
      throw redirect({ to: '/login', search: { redirect: destination }, replace: true });
    throw error;
  }
  return workspaceDestination(session.user.id, workspaces);
}
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async () => {
    const destination = await defaultWorkspaceDestination('/');
    throw redirect({ href: pendingInvitationDestination() ?? destination, replace: true });
  },
});
export const slackLinkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/slack/link',
  component: SlackLinkPage,
  validateSearch: search =>
    z.object({ workspaceId: z.uuid(), eventId: z.uuid(), recovery: z.literal('retry').optional() }).parse(search),
  beforeLoad: async ({ location }) => {
    preloadRouteCode(location.pathname);
    await requireProfile(location.href);
  },
});
const createWorkspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/create-workspace',
  validateSearch: authSearch,
  beforeLoad: async ({ location }) => {
    preloadRouteCode(location.pathname);
    const session = await loadSession();
    if (session && !session.user.name.trim())
      throw redirect({ to: '/complete-profile', search: { redirect: location.href }, replace: true });
  },
  component: CreateWorkspacePage,
});
const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding',
  component: OnboardingPage,
  beforeLoad: async ({ location }) => {
    preloadRouteCode(location.pathname);
    await requireProfile(location.href);
  },
});
const onboardingChatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding/chat',
  component: OnboardingChatPage,
  beforeLoad: async ({ location }) => {
    preloadRouteCode(location.pathname);
    await requireProfile(location.href);
  },
});
export const workspaceRecoveryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account/workspace-recovery',
  beforeLoad: async ({ location }) => ({ userId: (await requireProfile(location.href)).user.id }),
  component: WorkspaceRecoveryPage,
});
export const workspaceSetupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspace-setups/$setupId',
  validateSearch: authSearch,
  beforeLoad: async ({ location }) => {
    preloadRouteCode(location.pathname);
    await requireProfile(location.href);
  },
  component: WorkspaceSetupStatusPage,
});
async function redirectAuthenticated({
  search,
  location,
}: {
  search: { redirect?: string };
  location: { pathname: string };
}) {
  preloadRouteCode(location.pathname);
  const session = await loadSession();
  if (!session) return;
  const destination = safeAuthRedirect(search.redirect);
  if (!session.user.name.trim())
    throw redirect({ to: '/complete-profile', search: { redirect: destination }, replace: true });
  throw redirect({ href: destination, replace: true });
}
function authSearch(search: Record<string, unknown>): { redirect?: string } {
  return typeof search.redirect === 'string' ? { redirect: safeAuthRedirect(search.redirect) } : {};
}
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
  validateSearch: authSearch,
  beforeLoad: redirectAuthenticated,
});
const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  component: RegisterPage,
  validateSearch: authSearch,
  beforeLoad: redirectAuthenticated,
});
const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login/forgot-password',
  component: ForgotPasswordPage,
  validateSearch: authSearch,
});
const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login/reset-password',
  component: ResetPasswordPage,
});
const verifyEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/verify-email',
  component: VerifyEmailPage,
});
const logoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/logout',
  component: LogoutPage,
  validateSearch: authSearch,
  beforeLoad: async ({ search, location }) => {
    preloadRouteCode(location.pathname);
    if (!(await loadSession()))
      throw redirect({ to: '/login', search: { redirect: safeAuthRedirect(search.redirect) }, replace: true });
  },
});
const completeProfileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/complete-profile',
  component: CompleteProfilePage,
  validateSearch: authSearch,
  beforeLoad: async ({ search, location }) => {
    preloadRouteCode(location.pathname);
    const session = await loadSession();
    if (!session)
      throw redirect({ to: '/login', search: { redirect: safeAuthRedirect(search.redirect) }, replace: true });
    if (session.user.name.trim()) throw redirect({ href: safeAuthRedirect(search.redirect), replace: true });
  },
});
const accountAliases = [
  { path: '/signup', to: '/register' },
  { path: '/forgot-password', to: '/login' },
  { path: '/reset-password', to: '/login' },
  { path: '/auth', to: '/login' },
  { path: '/callback', to: '/' },
].map(({ path, to }) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    validateSearch: authSearch,
    beforeLoad: ({ search }) => {
      throw redirect({ to, search, replace: true });
    },
  }),
);
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite',
  component: JoinWorkspacePage,
  beforeLoad: async ({ location }) => {
    const legacyToken = invitationTokenSchema.safeParse(location.hash.replace(/^#/, ''));
    if (legacyToken.success) throw redirect({ href: `/invite?token=${legacyToken.data}`, replace: true });
    preloadRouteCode(location.pathname);
    const session = await loadSession();
    if (session && !session.user.name.trim())
      throw redirect({ to: '/complete-profile', search: { redirect: safeAuthRedirect(location.href) }, replace: true });
  },
});

export const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/$workspaceSlug',
  context: () => ({ workspaceAccess: createWorkspaceAccess() }),
  beforeLoad: ({ params, location, cause, context, abortController }) =>
    measureWorkspaceAdmission(async (): Promise<WorkspaceContext> => {
      if (workspaceSlugError(params.workspaceSlug)) throw notFound();
      preloadRouteCode(location.pathname);
      void loadPageReads().catch(() => {});
      const snapshot = context.workspaceAccess.getSnapshot();
      // A provisional render's check has settled: use its admission, or, when it did not confirm one,
      // admit again exactly as a fresh load would.
      const verified =
        cause === 'preload'
          ? null
          : takeVerifiedAdmission(context.workspaceAccess, params.workspaceSlug, location.pathname);
      if (verified?.context) return verified.context;
      const loadCause = verified ? 'enter' : cause;
      const previousWorkspace =
        snapshot.kind === 'admitted' && snapshot.read.workspace.slug === params.workspaceSlug
          ? snapshot.read.workspace
          : null;
      const navigating = snapshot.kind === 'admitted' && snapshot.read.pathname !== location.pathname;
      const earlyReads =
        navigating && previousWorkspace && snapshot.kind === 'admitted'
          ? {
              userId: snapshot.authority.userId,
              sessionId: snapshot.authority.sessionId,
              workspace: getWorkspace(params.workspaceSlug),
              membership:
                previousWorkspace.status === 'ready'
                  ? loadOwnMembership(previousWorkspace.id, abortController.signal)
                  : null,
              list: cause === 'stay' ? listWorkspaces(abortController.signal) : null,
            }
          : null;
      if (earlyReads) {
        const deny = context.workspaceAccess.observe({
          userId: earlyReads.userId,
          sessionId: earlyReads.sessionId,
          slug: params.workspaceSlug,
        });
        for (const read of [earlyReads.workspace, earlyReads.membership, earlyReads.list])
          void read?.catch(error => {
            if (
              (error instanceof WorkspaceRequestError || error instanceof GovernanceRequestError) &&
              [401, 403, 404].includes(error.status)
            )
              deny(error.status);
          });
      }
      // The API checks the session cookie on every read, so a fresh load starts the workspace reads for
      // the session this browser last confirmed while the session check runs. They are only used if
      // the check returns that same session.
      const last = earlyReads ? null : lastSession();
      const speculative = last ? startAdmissionReads(last, params.workspaceSlug, location, loadCause) : null;

      // A retry starts its reads again: the early and speculative reads have already failed.
      const admit = async (session: AuthSession, signal: AbortSignal, reuse = true): Promise<WorkspaceContext> => {
        signal.throwIfAborted();
        const access = context.workspaceAccess.begin({
          userId: session.user.id,
          sessionId: session.session.id,
          slug: params.workspaceSlug,
        });
        const denied = (error: unknown) => {
          if (
            (error instanceof WorkspaceRequestError || error instanceof GovernanceRequestError) &&
            [401, 403, 404].includes(error.status)
          )
            access.deny(error.status);
          throw error;
        };
        const identity = { userId: session.user.id, sessionId: session.session.id };
        let pageReads: ReturnType<typeof startPageReads> | null = null;
        const reads =
          reuse && earlyReads?.userId === session.user.id && earlyReads.sessionId === session.session.id
            ? earlyReads
            : null;
        const started =
          reuse &&
          speculative?.identity.userId === session.user.id &&
          speculative.identity.sessionId === session.session.id
            ? speculative
            : null;
        if (!started) speculative?.discard();
        // On a fresh load, the id this slug had last time lets membership and page reads start
        // alongside the workspace read. Neither is used unless the workspace read returns that id.
        const hintedId = reads
          ? null
          : started
            ? started.hintedId
            : workspaceIdHint(session.user.id, params.workspaceSlug);
        try {
          const hintedMembership = started ? started.membership : hintedId ? loadOwnMembership(hintedId, signal) : null;
          void hintedMembership?.catch(() => {});
          if (started) pageReads = started.pageReads;
          else if (hintedId) pageReads = startPageReads(identity, hintedId, params.workspaceSlug, location);
          const workspaceRequest = (reads?.workspace ?? started?.workspace ?? getWorkspace(params.workspaceSlug)).catch(
            denied,
          );
          const membershipRequest = workspaceRequest.then(workspace => {
            if (workspace.status !== 'ready') return null;
            if (!reads && pageReads?.workspaceId !== workspace.id) {
              pageReads?.discard();
              pageReads = startPageReads(identity, workspace.id, params.workspaceSlug, location);
            }
            return (
              reads?.membership && previousWorkspace?.id === workspace.id
                ? reads.membership
                : hintedMembership && hintedId === workspace.id
                  ? hintedMembership
                  : loadOwnMembership(workspace.id, signal)
            ).catch(denied);
          });
          void membershipRequest.catch(() => {});
          const [workspaceRead, listRead] = await Promise.allSettled([
            workspaceRequest,
            (
              reads?.list ??
              started?.list ??
              (loadCause === 'stay'
                ? listWorkspaces(signal)
                : readWorkspaceList({ userId: session.user.id, sessionId: session.session.id }))
            ).catch(denied),
          ]);
          for (const read of [workspaceRead, listRead]) {
            if (
              read.status === 'rejected' &&
              read.reason instanceof WorkspaceRequestError &&
              [401, 403, 404].includes(read.reason.status)
            )
              throw read.reason;
          }
          if (workspaceRead.status === 'rejected') throw workspaceRead.reason;
          if (listRead.status === 'rejected') throw listRead.reason;
          const workspace = workspaceRead.value;
          const workspaces = listRead.value;
          const membership = await membershipRequest;
          if (!signal.aborted) access.admit({ pathname: location.pathname, workspace, workspaces, membership });
          if (membership && !signal.aborted && pageReads?.workspaceId === workspace.id)
            pageReads.admit(membership.membershipId);
          else pageReads?.discard();
          if (workspace.status === 'ready') rememberWorkspaceId(session.user.id, params.workspaceSlug, workspace.id);
          if (workspace.status === 'ready' && membership && !signal.aborted)
            void persistedReads.saveAdmission(
              identity,
              params.workspaceSlug,
              workspace.id,
              new Date(session.session.expiresAt).getTime(),
              { user: session.user, workspace, workspaces, membership },
            );
          return {
            user: session.user,
            sessionId: session.session.id,
            accessRevision: access.revision,
            membershipId: membership?.membershipId ?? null,
            membership,
            workspace,
            workspaces,
            workspaceStale: false,
            workspaceProvisional: false,
          };
        } catch (error) {
          pageReads?.discard();
          if (
            (error instanceof WorkspaceRequestError || error instanceof GovernanceRequestError) &&
            [403, 404].includes(error.status)
          ) {
            forgetWorkspace(session.user.id);
            forgetWorkspaceId(session.user.id, params.workspaceSlug);
            void persistedReads.forgetAdmission(session.user.id, params.workspaceSlug);
            if (hintedId) void persistedReads.clear(session.user.id, hintedId);
            if (loadCause === 'stay') throw redirect({ to: '/', replace: true });
            throw notFound();
          }
          if (
            (error instanceof WorkspaceRequestError || error instanceof GovernanceRequestError) &&
            error.status === 401
          ) {
            void forgetSession();
            throw redirect({ to: '/login', search: { redirect: location.href }, replace: true });
          }
          const temporary = temporaryAdmissionError(error);
          const previous = access.retained(location.pathname);
          if (temporary && !signal.aborted && loadCause === 'stay' && previous) {
            // Integration controls change workspace connections, so those pages confirm the
            // membership again before showing them. Elsewhere the last admitted read is enough.
            const membership = onIntegrationsPage(params.workspaceSlug, location.pathname)
              ? await loadOwnMembership(previous.workspace.id, signal).catch(denied)
              : previous.membership;
            return {
              user: session.user,
              sessionId: session.session.id,
              accessRevision: access.revision,
              membershipId: membership?.membershipId ?? null,
              membership,
              workspace: previous.workspace,
              workspaces: previous.workspaces,
              workspaceStale: true,
              workspaceProvisional: false,
            };
          }
          throw error;
        }
      };
      const profile = (signal: AbortSignal) =>
        requireProfile(location.href).catch(error => {
          // A busy or unreachable API has not changed the session, so the admitted view stays while admission retries.
          if (!signal.aborted && !temporaryAdmissionError(error)) context.workspaceAccess.clear();
          throw error;
        });

      const provisional =
        last && !verified && !earlyReads && cause !== 'stay' && snapshot.kind !== 'admitted'
          ? await provisionalAdmission(last, params.workspaceSlug, location.pathname)
          : null;
      if (provisional && !abortController.signal.aborted) {
        const { identity, scope, read } = provisional;
        persistedReads.beginProvisional(identity, scope, provisional.reads);
        const access = context.workspaceAccess.begin({ ...identity, slug: params.workspaceSlug });
        access.admit({ pathname: location.pathname, ...read });
        if (speculative?.pageReads?.workspaceId === scope.workspaceId) speculative.pageReads.admit(scope.membershipId);
        // The check runs on after this load returns, so leaving the page does not cancel it.
        const check = new AbortController();
        const verification = retryAdmission(
          fresh => profile(check.signal).then(session => admit(session, check.signal, fresh)),
          check.signal,
        );
        const same = (result: WorkspaceContext) =>
          result.user.id === identity.userId &&
          result.sessionId === identity.sessionId &&
          result.workspace.id === scope.workspaceId &&
          result.membershipId === scope.membershipId;
        holdWrites(
          verification.then(result => {
            if (!same(result)) throw new Error('Workspace access changed');
          }),
        );
        void verification
          .then(
            result => {
              persistedReads.endProvisional();
              if (same(result)) sessionRuntime(identity)?.persistScope(scope);
              else void persistedReads.clear(scope.userId, scope.workspaceId);
              return { context: result };
            },
            () => {
              persistedReads.endProvisional();
              return { context: null };
            },
          )
          .then(outcome => {
            verifiedAdmissions.set(context.workspaceAccess, {
              ...outcome,
              slug: params.workspaceSlug,
              pathname: location.pathname,
              revision: context.workspaceAccess.getSnapshot().revision,
            });
            void router.invalidate();
          });
        return {
          user: read.user,
          sessionId: identity.sessionId,
          accessRevision: access.revision,
          membershipId: scope.membershipId,
          membership: read.membership,
          workspace: read.workspace,
          workspaces: read.workspaces,
          workspaceStale: false,
          workspaceProvisional: true,
        };
      }
      const discard = () => speculative?.discard();
      abortController.signal.addEventListener('abort', discard, { once: true });
      try {
        return await retryAdmission(async fresh => {
          const session = await profile(abortController.signal).catch(error => {
            discard();
            throw error;
          });
          return await admit(session, abortController.signal, fresh);
        }, abortController.signal);
      } finally {
        abortController.signal.removeEventListener('abort', discard);
      }
    }),
  component: WorkspaceShell,
  notFoundComponent: WorkspaceNotFoundPage,
});
const chatScopeSearch = z.object({ project: z.uuid().optional().catch(undefined) });
const publicPackageName = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const publicPackageVersion = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
export const newChatSearch = chatScopeSearch.extend({
  intent: z
    .enum([
      'create-agent',
      'create-table',
      'edit-table',
      'add-rows',
      'create-skill',
      'edit-skill',
      'use-skill',
      'create-workflow',
      'edit-workflow',
      'install-package',
    ])
    .optional()
    .catch(undefined),
  workflowId: z.uuid().optional().catch(undefined),
  tableId: z.uuid().optional().catch(undefined),
  skillId: z.uuid().optional().catch(undefined),
  skillRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
    .catch(undefined),
  skillVersion: z.coerce.number().int().positive().optional().catch(undefined),
  packageName: publicPackageName.optional().catch(undefined),
  packageVersion: publicPackageVersion.optional().catch(undefined),
});
const chatRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/_chat',
  validateSearch: z.object({
    intent: z.literal('install-package'),
    packageName: publicPackageName,
    packageVersion: publicPackageVersion,
  }),
  beforeLoad: async ({ location, search }) => {
    const destination = await defaultWorkspaceDestination(location.href);
    if (destination === '/create-workspace')
      throw redirect({ to: '/create-workspace', search: { redirect: location.href }, replace: true });
    throw redirect({
      to: '/$workspaceSlug',
      params: { workspaceSlug: destination.slice(1) },
      search,
      replace: true,
    });
  },
});
export const workspaceHomeRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/',
  beforeLoad: ({ params, location }) => {
    const legacyChat = z.uuid().safeParse(location.hash.startsWith('chat=') ? location.hash.slice(5) : '');
    if (legacyChat.success)
      throw redirect({
        to: '/$workspaceSlug/chat/$chatId',
        params: { ...params, chatId: legacyChat.data },
        replace: true,
      });
  },
  validateSearch: search => newChatSearch.parse(search),
  component: WorkspaceHomePage,
});
export const workspaceChatsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'chat',
  validateSearch: search => chatScopeSearch.parse(search),
  component: WorkspaceChatsPage,
});
export const workspaceChatRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'chat/$chatId',
  validateSearch: z.object({ package: z.literal('leave-management').optional().catch(undefined) }),
  beforeLoad: ({ params }) => {
    if (!z.uuid().safeParse(params.chatId).success) throw notFound();
  },
  component: WorkspaceHomePage,
});
const workspaceInboxRoute = createRoute({ getParentRoute: () => workspaceRoute, path: 'inbox', component: InboxPage });
const workspaceHelpRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'help',
  component: lazyRouteComponent(() => import('./pages/help'), 'HelpPage'),
});
const workspaceAgentsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'agents',
  component: AgentsPage,
});
const agentTasksRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'agent-tasks',
  component: AgentTasksPage,
});
export const workspaceCalendarRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'calendar',
  validateSearch: search => calendarSearchSchema.parse(search),
  component: lazyRouteComponent(() => import('./pages/calendar')),
});
export const agentTaskRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'agent-tasks/$taskId',
  beforeLoad: ({ params }) => {
    if (!z.uuid().safeParse(params.taskId).success) throw notFound();
  },
  component: AgentTaskPage,
});
export const workspaceProjectsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'projects',
  validateSearch: search =>
    z
      .object({
        new: z.boolean().optional().catch(undefined),
        q: z.string().trim().min(1).max(255).optional().catch(undefined),
        archived: z.literal(true).optional().catch(undefined),
      })
      .parse(search),
  component: ProjectsPage,
});
const filesAndGoogleSearch = (search: Record<string, unknown>) => ({
  ...filesSearchSchema.parse(search),
  ...googleFilesSearchSchema.parse(search),
});
export const filesRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'files',
  validateSearch: filesAndGoogleSearch,
  component: FilesPage,
});
export const fileRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'files/$fileId',
  validateSearch: search => viewerSearchSchema.parse(search),
  beforeLoad: ({ params }) => {
    if (!z.uuid().safeParse(params.fileId).success) throw notFound();
  },
  component: FilePage,
});
export const googleFileRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'files/google/$fileId',
  validateSearch: filesAndGoogleSearch,
  beforeLoad: ({ params }) => {
    if (!googleFileIdSchema.safeParse(params.fileId).success) throw notFound();
  },
  component: GoogleFilePage,
});
export const projectDetailRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'projects/$projectId',
  beforeLoad: ({ params }) => {
    if (!z.uuid().safeParse(params.projectId).success) throw notFound();
  },
  component: ProjectDetailPage,
});
export const projectSettingsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'projects/$projectId/settings',
  beforeLoad: ({ params }) => {
    if (!z.uuid().safeParse(params.projectId).success) throw notFound();
  },
  component: ProjectSettingsPage,
});
const workspaceSkillsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'skills',
  component: SkillsPage,
});
const systemPackagesRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'packages',
  component: SystemPackagesPage,
});
export const publicPackageRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'packages/catalog/$packageName/$packageVersion',
  beforeLoad: ({ params }) => {
    if (
      !publicPackageName.safeParse(params.packageName).success ||
      !publicPackageVersion.safeParse(params.packageVersion).success
    )
      throw notFound();
  },
  component: PublicPackagePage,
});
export const systemPackageRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'packages/$installationId',
  beforeLoad: ({ params }) => {
    if (!z.uuid().safeParse(params.installationId).success) throw notFound();
  },
  component: SystemPackagePage,
});
const newSkillRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'skills/new',
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/$workspaceSlug',
      params: { workspaceSlug: params.workspaceSlug },
      search: { intent: 'create-skill' },
      replace: true,
    });
  },
});
const importSkillRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'skills/import',
  component: ImportSkillPage,
});
export const skillImportRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'skills/import/$importId',
  beforeLoad: ({ params }) => {
    if (!z.uuid().safeParse(params.importId).success) throw notFound();
  },
  component: SkillImportPage,
});
export const skillDetailRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'skills/$skillId',
  beforeLoad: ({ params }) => {
    if (!z.uuid().safeParse(params.skillId).success) throw notFound();
  },
  component: SkillDetailPage,
});
export const newAgentRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'agents/new',
  validateSearch: search =>
    z
      .object({
        setupAgentId: z.uuid().optional().catch(undefined),
        chatId: z.uuid().optional().catch(undefined),
        draftId: z.uuid().optional().catch(undefined),
        step: z.enum(['skills', 'access']).optional().catch(undefined),
      })
      .parse(search),
  component: NewAgentPage,
});
export const agentDetailRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'agents/$agentId',
  validateSearch: search => z.object({ tab: z.enum(agentTabValues).optional().catch(undefined) }).parse(search),
  component: AgentDetailPage,
});
export const workspaceWorkflowsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'workflows',
  validateSearch: search => workflowPageSearch.parse(search),
  component: lazyRouteComponent(() => import('./pages/workflows')),
});
// The workflows page reads this param itself, so opening a workflow keeps the page mounted.
export const workspaceWorkflowRoute = createRoute({
  getParentRoute: () => workspaceWorkflowsRoute,
  path: '$workflowId',
});
const workspaceSettingsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'settings',
  component: SettingsPage,
});
const workspaceSoulRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'settings/soul',
  component: lazyRouteComponent(() => import('@/pages/soul-explorer'), 'SoulExplorerPage'),
});
export const workspaceModelsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'settings/models',
  validateSearch: search =>
    z.object({ tab: z.enum(['access', 'compaction', 'images']).optional().catch(undefined) }).parse(search),
  component: ModelsPage,
});
const workspaceAccountRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'settings/account',
  component: AccountSettingsPage,
});
const workspaceSecretsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'settings/secrets',
  component: SecretsSettingsPage,
});
// A web extension supplies the Usage page; without one the route does not exist.
const UsagePage = overrides.get('usage');
const workspaceUsageRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'settings/usage',
  beforeLoad: () => {
    if (!UsagePage) throw notFound();
  },
  component: () => UsagePage && <UsagePage />,
});
export const tablesRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'tables',
  validateSearch: search => tableListSearchSchema.parse(search),
  component: TablesPage,
});
const newTableRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'tables/new',
  component: NewTablePage,
});
export const tableDetailRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'tables/$tableId',
  validateSearch: search => tableRowsSearchSchema.parse(search),
  component: TableDetailPage,
});
export const tableEditRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'tables/$tableId/edit',
  component: EditTablePage,
});
const workspaceMembersRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'members',
  component: MembersPage,
});
const workspaceInviteMembersRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'members/invite',
  component: InviteMembersPage,
});
const workspaceEditInviteRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'members/invites/$invitationId',
  component: EditInvitePage,
});
const workspaceMembersSettingsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'members/settings',
  component: MembersSettingsPage,
});
const workspaceMemberRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'members/$membershipId',
  component: MemberDetailPage,
});
const workspaceTeamsRoute = createRoute({ getParentRoute: () => workspaceRoute, path: 'teams', component: TeamsPage });
const workspaceTeamRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'teams/$teamId',
  component: TeamDetailPage,
});
const workspaceGrantsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'grants',
  component: GrantsPage,
});
export const knowledgeRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'knowledge',
  component: lazyRouteComponent(() => import('./pages/knowledge')),
});
export const integrationsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'integrations',
  validateSearch: search => z.object({ returnChat: z.uuid().optional().catch(undefined) }).parse(search),
  component: IntegrationsPage,
});
export const integrationDetailRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'integrations/$integrationId',
  validateSearch: search =>
    z
      .object({
        tab: z.enum(['accounts', 'knowledge', 'channels', 'settings', 'advanced']).optional().catch(undefined),
        returnChat: z.uuid().optional().catch(undefined),
      })
      .parse(search),
  beforeLoad: ({ params, search }) => {
    const integrationId = currentIntegrationId(params.integrationId);
    if (integrationId !== params.integrationId)
      throw redirect({
        to: '/$workspaceSlug/integrations/$integrationId',
        params: { ...params, integrationId },
        search,
        replace: true,
      });
  },
  component: IntegrationDetailPage,
});
export const router = createRouter({
  scrollRestoration: true,
  scrollToTopSelectors: ['window', `[data-scroll-restoration-id="${workspacePageScroller}"]`],
  getScrollRestorationKey: location =>
    /\/files\/?$/.test(location.pathname)
      ? location.pathname + location.searchStr
      : (location.state.__TSR_key ?? location.href),
  routeTree: rootRoute.addChildren([
    indexRoute,
    chatRedirectRoute,
    googleCallbackRoute,
    githubCallbackRoute,
    githubSetupRoute,
    atlassianCallbackRoute,
    slackLinkRoute,
    createWorkspaceRoute,
    onboardingRoute,
    onboardingChatRoute,
    workspaceRecoveryRoute,
    workspaceSetupRoute,
    loginRoute,
    registerRoute,
    forgotPasswordRoute,
    resetPasswordRoute,
    verifyEmailRoute,
    logoutRoute,
    completeProfileRoute,
    ...accountAliases,
    inviteRoute,
    workspaceRoute.addChildren([
      workspaceHomeRoute,
      workspaceChatsRoute,
      workspaceChatRoute,
      workspaceInboxRoute,
      workspaceHelpRoute,
      workspaceAgentsRoute,
      agentTasksRoute,
      agentTaskRoute,
      newAgentRoute,
      agentDetailRoute,
      workspaceProjectsRoute,
      filesRoute,
      fileRoute,
      googleFileRoute,
      projectDetailRoute,
      projectSettingsRoute,
      workspaceSkillsRoute,
      systemPackagesRoute,
      publicPackageRoute,
      systemPackageRoute,
      newSkillRoute,
      importSkillRoute,
      skillImportRoute,
      skillDetailRoute,
      workspaceWorkflowsRoute.addChildren([workspaceWorkflowRoute]),
      workspaceCalendarRoute,
      workspaceSettingsRoute,
      workspaceSoulRoute,
      workspaceAccountRoute,
      workspaceSecretsRoute,
      workspaceModelsRoute,
      workspaceUsageRoute,
      workspaceMembersRoute,
      workspaceInviteMembersRoute,
      workspaceEditInviteRoute,
      workspaceMembersSettingsRoute,
      workspaceMemberRoute,
      workspaceTeamsRoute,
      workspaceTeamRoute,
      workspaceGrantsRoute,
      knowledgeRoute,
      integrationsRoute,
      integrationDetailRoute,
      tablesRoute,
      newTableRoute,
      tableDetailRoute,
      tableEditRoute,
    ]),
  ]),
  defaultNotFoundComponent: NotFoundPage,
  defaultErrorComponent: RouteErrorPage,
  defaultPendingMinMs: 0,
  defaultPendingComponent: () => (
    <main role="status" className="flex min-h-svh items-center justify-center gap-2">
      <Spinner />
      Opening TulipFarm…
    </main>
  ),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
