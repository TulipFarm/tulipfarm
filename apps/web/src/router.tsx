import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
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
import { devAutoSignIn } from '@/lib/dev-auto-sign-in';
import { forgetSession } from '@/lib/last-workspace';
import { loadSignedInSession, requireProfile } from '@/lib/profile-guard';
import { loadSessionLayer, useSessionLayer } from '@/lib/session-layer';
import { pendingInvitationDestination } from '@/lib/pending-invitation';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { workspaceSlugError } from '@/lib/workspace-slug';
import { currentIntegrationId } from '@/features/integrations/former-ids';
import { invitationTokenSchema } from '@tulipfarm/workspaces/invitation-token';
import { workspacePageScroller } from '@/lib/page-scroller';
import { accountCallbackResultSchema } from '@tulipfarm/atlassian/callback-contracts';
import { googleCallbackResultSchema } from '@tulipfarm/google-workspace/callback-contracts';
import { workflowPageSearch } from '@/features/workflows/page-search';
import { calendarSearchSchema } from '@/features/calendar/search';
import type { UsageSearch } from '@/features/usage/search';
import { agentTabValues } from '@/features/agents/tab-values';
import { createWorkspaceAccess } from '@/lib/workspace-access';
import type { FeatureScope } from '@/lib/query/scope';
import { measureWorkspaceAdmission } from '@/lib/navigation-performance';
import type { WorkspaceContext } from '@/session-layer';
import { analytics } from '@/extensions';
import { isAssetLoadError, reloadOnceForAssetError } from '@/lib/asset-recovery';
import { routeErrorEvent, routeErrorProperties } from '@/lib/route-error-report';
import { onWindowReturn } from '@/lib/window-return';

// Admission and 401/403 responses already catch revocation; this only bounds how long a
// background tab can keep showing a workspace after another person removes access.
const accessCheckInterval = 60_000;

type RoutePages = typeof import('./route-pages');
let routePages: Promise<RoutePages> | null = null;
/** A page's loader. Page loaders live in their own module, fetched the first time a page other than sign-in loads. */
function routePage<K extends keyof RoutePages>(name: K): RoutePages[K] {
  const load = () => {
    routePages ??= import('./route-pages').catch(error => {
      routePages = null;
      throw error;
    });
    return routePages.then(pages => (pages[name] as () => Promise<unknown>)());
  };
  return load as unknown as RoutePages[K];
}

const MembersPage = lazyRouteComponent(routePage('governance'), 'MembersPage');
const InboxPage = lazyRouteComponent(routePage('workspace'), 'InboxPage');
const WorkspaceShell = lazyRouteComponent(routePage('workspace'), 'WorkspaceShell');
const WorkspaceRecoveryPage = lazyRouteComponent(routePage('workspaceRecovery'), 'WorkspaceRecoveryPage');
const RecoveryNotice = lazy(() =>
  routePage('workspaceRecovery')().then(module => ({ default: module.RecoveryNotice })),
);
const LoginPage = lazyRouteComponent(() => import('@/pages/login'), 'LoginPage');
const RegisterPage = lazyRouteComponent(routePage('auth'), 'RegisterPage');
const ForgotPasswordPage = lazyRouteComponent(routePage('password'), 'ForgotPasswordPage');
const ResetPasswordPage = lazyRouteComponent(routePage('password'), 'ResetPasswordPage');
const VerifyEmailPage = lazyRouteComponent(routePage('auth'), 'VerifyEmailPage');
const LogoutPage = lazyRouteComponent(routePage('auth'), 'LogoutPage');
const CompleteProfilePage = lazyRouteComponent(routePage('auth'), 'CompleteProfilePage');
const CreateWorkspacePage = lazyRouteComponent(routePage('createWorkspace'), 'CreateWorkspacePage');
const OnboardingPage = lazyRouteComponent(routePage('onboarding'), 'OnboardingPage');
const OnboardingChatPage = lazyRouteComponent(routePage('onboarding'), 'OnboardingChatPage');
const WorkspaceSetupStatusPage = lazyRouteComponent(routePage('workspaceSetupStatus'), 'WorkspaceSetupStatusPage');
const JoinWorkspacePage = lazyRouteComponent(routePage('governanceInvitations'), 'JoinWorkspacePage');
const SlackLinkPage = lazyRouteComponent(routePage('slackLink'), 'SlackLinkPage');
const GoogleCallbackPage = lazyRouteComponent(routePage('googleCallback'), 'GoogleCallbackPage');
const McpCallbackPage = lazyRouteComponent(routePage('mcpCallback'), 'McpCallbackPage');
const GitHubCallbackPage = lazyRouteComponent(routePage('githubCallback'), 'GitHubCallbackPage');
const AtlassianCallbackPage = lazyRouteComponent(routePage('atlassianCallback'), 'AtlassianCallbackPage');
const WorkspaceHomePage = lazyRouteComponent(routePage('workspaceHome'), 'WorkspaceHomePage');
const WorkspaceChatsPage = lazyRouteComponent(routePage('workspaceChats'), 'WorkspaceChatsPage');
const TeamsPage = lazyRouteComponent(routePage('governance'), 'TeamsPage');
const GrantsPage = lazyRouteComponent(routePage('governance'), 'GrantsPage');
const InviteMembersPage = lazyRouteComponent(routePage('governance'), 'InviteMembersPage');
const EditInvitePage = lazyRouteComponent(routePage('governance'), 'EditInvitePage');
const MembersSettingsPage = lazyRouteComponent(routePage('governance'), 'MembersSettingsPage');
const MemberDetailPage = lazyRouteComponent(routePage('governance'), 'MemberDetailPage');
const TeamDetailPage = lazyRouteComponent(routePage('governance'), 'TeamDetailPage');
const TablesPage = lazyRouteComponent(routePage('tables'), 'TablesPage');
const TableDetailPage = lazyRouteComponent(routePage('tables'), 'TableDetailPage');
const NewTablePage = lazyRouteComponent(routePage('tables'), 'NewTablePage');
const EditTablePage = lazyRouteComponent(routePage('tables'), 'EditTablePage');
const AgentsPage = lazyRouteComponent(routePage('agents'), 'AgentsPage');
const NewAgentPage = lazyRouteComponent(routePage('agents'), 'NewAgentPage');
const AgentDetailPage = lazyRouteComponent(routePage('agents'), 'AgentDetailPage');
const ProjectsPage = lazyRouteComponent(routePage('projects'), 'ProjectsPage');
const FilesPage = lazyRouteComponent(routePage('files'), 'FilesPage');
const FilePage = lazyRouteComponent(routePage('file'), 'FilePage');
const GoogleFilePage = lazyRouteComponent(routePage('googleFile'), 'GoogleFilePage');
const ProjectDetailPage = lazyRouteComponent(routePage('projects'), 'ProjectDetailPage');
const ProjectSettingsPage = lazyRouteComponent(routePage('projects'), 'ProjectSettingsPage');
const SkillsPage = lazyRouteComponent(routePage('skills'), 'SkillsPage');
const SystemPackagesPage = lazyRouteComponent(routePage('systemPackages'), 'SystemPackagesPage');
const PublicPackagePage = lazyRouteComponent(routePage('systemPackages'), 'PublicPackagePage');
const SystemPackagePage = lazyRouteComponent(routePage('systemPackages'), 'SystemPackagePage');
const ImportSkillPage = lazyRouteComponent(routePage('skillsImportFlow'), 'ImportSkillPage');
const SkillImportPage = lazyRouteComponent(routePage('skillsImportFlow'), 'SkillImportPage');
const SkillDetailPage = lazyRouteComponent(routePage('skills'), 'SkillDetailPage');
const AgentTasksPage = lazyRouteComponent(routePage('agentTasks'), 'AgentTasksPage');
const AgentTaskPage = lazyRouteComponent(routePage('agentTasks'), 'AgentTaskPage');
const IntegrationsPage = lazyRouteComponent(routePage('integrations'), 'IntegrationsPage');
const IntegrationDetailPage = lazyRouteComponent(routePage('integrationDetail'), 'IntegrationDetailPage');
const ModelsPage = lazyRouteComponent(routePage('models'), 'ModelsPage');
const SettingsPage = lazyRouteComponent(routePage('settings'), 'SettingsPage');
const AccountSettingsPage = lazyRouteComponent(routePage('accountSettings'), 'AccountSettingsPage');
const SecretsSettingsPage = lazyRouteComponent(routePage('secretsSettings'), 'SecretsSettingsPage');
const UsagePage = lazyRouteComponent(routePage('usage'), 'UsagePage');

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
      const layer = await loadSessionLayer().catch(() => null);
      await layer?.recheckWorkspaceAccess(
        slug,
        {
          userId: admitted.user.id,
          sessionId: admitted.sessionId,
          membership: admitted.membership,
          membershipId: admitted.membershipId,
        },
        deny,
        refresh,
      );
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
  const layer = useSessionLayer(queryIdentity !== null);
  if (!queryIdentity || !layer) return <Outlet />;
  return (
    <layer.SessionScope
      identity={queryIdentity}
      onAuthorityLost={queryAuthorityLost}
      initialWorkspaces={initialWorkspaces}
      onWorkspaceListChanged={workspaceListChanged}
    >
      {session && !isPending && !error && showRecovery && (
        <Suspense fallback={null}>
          <RecoveryNotice key={session.user.id} userId={session.user.id} />
        </Suspense>
      )}
      <Outlet />
    </layer.SessionScope>
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
export const mcpCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mcp/callback',
  component: McpCallbackPage,
  validateSearch: search =>
    z
      .object({
        outcome: z.enum(['connected', 'sign-in-required', 'denied', 'expired', 'failed']).catch('failed'),
        workspaceId: z.uuid().optional().catch(undefined),
        integrationId: z.uuid().optional().catch(undefined),
      })
      .parse(search),
});
// TanStack Router preloads route components only after every beforeLoad settles. Session
// gates start the matched routes' code at once so it downloads during the session check.
// This fetches public bundle code only; private data still waits for the guards.
export function preloadRouteCode(pathname: string): Promise<unknown> {
  return Promise.all(
    router.getMatchedRoutes(pathname)[0].map(route => route.options.component?.preload?.()?.catch(() => {})),
  );
}
async function defaultWorkspaceDestination(destination: string) {
  const session = await requireProfile(destination);
  return (await loadSessionLayer()).defaultWorkspaceDestination(destination, session);
}
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async ({ location }) => {
    const destination = await defaultWorkspaceDestination(location.href);
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
    const session = await loadSignedInSession();
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
  validateSearch: search => ({
    ...authSearch(search),
    ...(typeof search.error === 'string' && { error: search.error }),
  }),
  beforeLoad: async options => {
    await redirectAuthenticated(options);
    if (!options.search.error) await devAutoSignIn(safeAuthRedirect(options.search.redirect));
  },
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
    if (!(await loadSignedInSession()))
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
    const session = await loadSignedInSession();
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
    const session = await loadSignedInSession();
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
      const layer = await loadSessionLayer();
      return layer.admitWorkspace({
        params,
        location,
        cause,
        context,
        abortController,
        shownAdmission: () =>
          router.state.matches.find(match => match.routeId === workspaceRoute.id)?.context as
            | Partial<WorkspaceContext>
            | undefined,
        invalidate: () => void router.invalidate(),
      });
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
  component: lazyRouteComponent(routePage('help'), 'HelpPage'),
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
  component: lazyRouteComponent(routePage('calendar')),
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
  component: lazyRouteComponent(routePage('skillsCreateForm'), 'CreateSkillPage'),
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
  component: lazyRouteComponent(routePage('workflows')),
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
  component: lazyRouteComponent(routePage('soulExplorer'), 'SoulExplorerPage'),
});
const appsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'apps',
  component: lazyRouteComponent(routePage('appsList'), 'AppsPage'),
});
const newAppRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'apps/new',
  component: lazyRouteComponent(routePage('appsNew'), 'NewAppPage'),
});
const appPageSearch = z.object({ row: z.uuid().optional().catch(undefined) });
const appRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'apps/$appSlug',
  validateSearch: search => appPageSearch.parse(search),
  component: lazyRouteComponent(routePage('appsPagesRoute'), 'AppHomePage'),
});
const appVersionsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'apps/$appSlug/versions',
  component: lazyRouteComponent(routePage('appsVersions'), 'AppVersionsPage'),
});
const appEditRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'apps/$appSlug/edit',
  validateSearch: search =>
    appPageSearch.extend({ page: z.string().max(80).optional().catch(undefined) }).parse(search),
  component: lazyRouteComponent(routePage('appsEditPage'), 'AppEditPage'),
});
const appSettingsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'apps/$appSlug/settings',
  component: lazyRouteComponent(routePage('appsSettings'), 'AppSettingsPage'),
});
const appPageRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'apps/$appSlug/$page',
  validateSearch: search => appPageSearch.parse(search),
  component: lazyRouteComponent(routePage('appsPagesRoute'), 'AppPagePage'),
});
export const workspaceModelsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'settings/models',
  validateSearch: search =>
    z
      .object({
        // The model source or setting shown: a plan shared with the member is `plan:<connection id>`.
        tab: z
          .union([
            z.enum(['access', 'chatgpt', 'claude', 'copilot', 'keys', 'compaction', 'images']),
            z.templateLiteral(['plan:', z.uuid()]),
          ])
          .optional()
          .catch(undefined),
        // The outcome of a ChatGPT sign-in that finished on this server's loopback address.
        chatgpt: z.string().max(64).optional().catch(undefined),
      })
      .parse(search),
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
const workspaceUsageRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'settings/usage',
  // The explorer checks these values itself, which keeps its schema out of the startup bundle.
  validateSearch: (search: Record<string, unknown>) => search as UsageSearch,
  component: UsagePage,
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
  component: lazyRouteComponent(routePage('knowledge')),
});
export const integrationsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'integrations',
  validateSearch: search =>
    z
      .object({
        returnChat: z.uuid().optional().catch(undefined),
        view: z.string().max(64).optional().catch(undefined),
      })
      .parse(search),
  component: IntegrationsPage,
});
export const integrationDetailRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'integrations/$integrationId',
  validateSearch: search =>
    z
      .object({
        tab: z
          .enum(['tools', 'access', 'accounts', 'knowledge', 'channels', 'settings', 'advanced'])
          .optional()
          .catch(undefined),
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
    mcpCallbackRoute,
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
      appsRoute,
      newAppRoute,
      appRoute,
      appVersionsRoute,
      appEditRoute,
      appSettingsRoute,
      appPageRoute,
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
