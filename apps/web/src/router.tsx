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
import { forgetWorkspace, workspaceDestination } from '@/lib/last-workspace';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { workspaceSlugError } from '@/lib/workspace-slug';
import { getWorkspace, listWorkspaces, WorkspaceRequestError } from '@/lib/workspaces';
import { readWorkspaceList, WorkspaceListQueryBridge } from '@/features/workspaces/queries';
import { reconcileMembership } from '@/features/governance/queries';
import { invitationTokenSchema } from '@tulipfarm/workspaces/governance-contracts';
import { RecoveryNotice, WorkspaceRecoveryPage } from '@/pages/workspace-recovery';
import { accountCallbackResultSchema } from '@tulipfarm/atlassian/callback-contracts';
import { googleCallbackResultSchema } from '@tulipfarm/google-workspace/callback-contracts';
import { workflowPageSearch } from '@/features/workflows/page-search';
import { calendarSearchSchema } from '@/features/calendar/model';
import { agentTabValues } from '@/features/agents/tab-values';
import { createWorkspaceAccess } from '@/lib/workspace-access';
import { loadOwnMembership, GovernanceRequestError } from '@/lib/governance';
import { SessionQueryProvider, type FeatureScope } from '@/lib/query';
import { measureWorkspaceAdmission } from '@/lib/navigation-performance';
import { UserVisitProvider } from '@/lib/user-visit';
import { analytics, overrides } from '@/extensions';
import { isAssetLoadError, reloadOnceForAssetError } from '@/lib/asset-recovery';
import { routeErrorEvent, routeErrorProperties } from '@/lib/route-error-report';
import { onWindowReturn } from '@/lib/window-return';

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
const ImportSkillPage = lazyRouteComponent(() => import('@/features/skills/import-flow'), 'ImportSkillPage');
const SkillImportPage = lazyRouteComponent(() => import('@/features/skills/import-flow'), 'SkillImportPage');
const SkillDetailPage = lazyRouteComponent(() => import('@/pages/skills'), 'SkillDetailPage');
const AgentTasksPage = lazyRouteComponent(() => import('@/pages/agent-tasks'), 'AgentTasksPage');
const AgentTaskPage = lazyRouteComponent(() => import('@/pages/agent-tasks'), 'AgentTaskPage');
const IntegrationsPage = lazyRouteComponent(() => import('@/pages/integrations'), 'IntegrationsPage');
const ModelsPage = lazyRouteComponent(() => import('@/pages/models'), 'ModelsPage');
const SettingsPage = lazyRouteComponent(() => import('@/pages/settings'), 'SettingsPage');
const AccountSettingsPage = lazyRouteComponent(() => import('@/pages/account-settings'), 'AccountSettingsPage');

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
  const initialWorkspaces =
    admission?.user?.id === queryIdentity?.userId && admission?.sessionId === queryIdentity?.sessionId
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
async function requireProfile(destination: string) {
  const session = await loadSession();
  if (!session) throw redirect({ to: '/login', search: { redirect: destination }, replace: true });
  if (!session.user.name.trim())
    throw redirect({ to: '/complete-profile', search: { redirect: safeAuthRedirect(destination) }, replace: true });
  return session;
}
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async () => {
    const session = await requireProfile('/');
    let workspaces;
    try {
      workspaces = await readWorkspaceList({ userId: session.user.id, sessionId: session.session.id });
    } catch (error) {
      if (error instanceof WorkspaceRequestError && error.status === 401)
        throw redirect({ to: '/login', search: { redirect: '/' }, replace: true });
      throw error;
    }
    throw redirect({ href: workspaceDestination(session.user.id, workspaces), replace: true });
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
    measureWorkspaceAdmission(async () => {
      if (workspaceSlugError(params.workspaceSlug)) throw notFound();
      preloadRouteCode(location.pathname);
      const snapshot = context.workspaceAccess.getSnapshot();
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
      const session = await requireProfile(location.href).catch(error => {
        if (!abortController.signal.aborted) context.workspaceAccess.clear();
        throw error;
      });
      abortController.signal.throwIfAborted();
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
      try {
        const reads =
          earlyReads?.userId === session.user.id && earlyReads.sessionId === session.session.id ? earlyReads : null;
        const workspaceRequest = (reads?.workspace ?? getWorkspace(params.workspaceSlug)).catch(denied);
        const membershipRequest = workspaceRequest.then(workspace =>
          workspace.status === 'ready'
            ? (reads?.membership && previousWorkspace?.id === workspace.id
                ? reads.membership
                : loadOwnMembership(workspace.id, abortController.signal)
              ).catch(denied)
            : null,
        );
        void membershipRequest.catch(() => {});
        const [workspaceRead, listRead] = await Promise.allSettled([
          workspaceRequest,
          (
            reads?.list ??
            (cause === 'stay'
              ? listWorkspaces(abortController.signal)
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
        if (!abortController.signal.aborted) access.admit({ pathname: location.pathname, workspace, workspaces });
        return {
          user: session.user,
          sessionId: session.session.id,
          accessRevision: access.revision,
          membershipId: membership?.membershipId ?? null,
          membership,
          workspace,
          workspaces,
          workspaceStale: false,
        };
      } catch (error) {
        if (
          (error instanceof WorkspaceRequestError || error instanceof GovernanceRequestError) &&
          [403, 404].includes(error.status)
        ) {
          forgetWorkspace(session.user.id);
          if (cause === 'stay') throw redirect({ to: '/', replace: true });
          throw notFound();
        }
        if ((error instanceof WorkspaceRequestError || error instanceof GovernanceRequestError) && error.status === 401)
          throw redirect({ to: '/login', search: { redirect: location.href }, replace: true });
        const temporary =
          error instanceof TypeError ||
          (error instanceof DOMException && error.name === 'TimeoutError') ||
          (error instanceof WorkspaceRequestError && error.status >= 500);
        const previous = access.retained(location.pathname);
        if (
          temporary &&
          !abortController.signal.aborted &&
          cause === 'stay' &&
          location.pathname === `/${params.workspaceSlug}/integrations` &&
          previous
        ) {
          const membership = await loadOwnMembership(previous.workspace.id, abortController.signal).catch(denied);
          return {
            user: session.user,
            sessionId: session.session.id,
            accessRevision: access.revision,
            membershipId: membership.membershipId,
            membership,
            workspace: previous.workspace,
            workspaces: previous.workspaces,
            workspaceStale: true,
          };
        }
        throw error;
      }
    }),
  component: WorkspaceShell,
  notFoundComponent: WorkspaceNotFoundPage,
});
const chatScopeSearch = z.object({ project: z.uuid().optional().catch(undefined) });
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
export const socialScheduleRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'social/schedule',
  component: lazyRouteComponent(() => import('./pages/social-schedule'), 'SocialSchedulePage'),
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
    z.object({ tab: z.enum(['access', 'compaction']).optional().catch(undefined) }).parse(search),
  component: ModelsPage,
});
const workspaceAccountRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'settings/account',
  component: AccountSettingsPage,
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
const workspaceTeamsRoute = createRoute({ getParentRoute: () => workspaceRoute, path: 'teams', component: TeamsPage });
const workspaceGrantsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'grants',
  component: GrantsPage,
});
export const integrationsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'integrations',
  validateSearch: search => z.object({ returnChat: z.uuid().optional().catch(undefined) }).parse(search),
  component: IntegrationsPage,
});
export const router = createRouter({
  scrollRestoration: true,
  getScrollRestorationKey: location =>
    /\/files\/?$/.test(location.pathname)
      ? location.pathname + location.searchStr
      : (location.state.__TSR_key ?? location.href),
  routeTree: rootRoute.addChildren([
    indexRoute,
    googleCallbackRoute,
    githubCallbackRoute,
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
      newSkillRoute,
      importSkillRoute,
      skillImportRoute,
      skillDetailRoute,
      workspaceWorkflowsRoute,
      workspaceCalendarRoute,
      socialScheduleRoute,
      workspaceSettingsRoute,
      workspaceSoulRoute,
      workspaceAccountRoute,
      workspaceModelsRoute,
      workspaceUsageRoute,
      workspaceMembersRoute,
      workspaceTeamsRoute,
      workspaceGrantsRoute,
      integrationsRoute,
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
