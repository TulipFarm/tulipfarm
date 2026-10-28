import { lazy, Suspense, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { CalendarDays } from 'lucide-react';
import { Link, Outlet, useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import { Add } from 'reicon-react/icons/Add';
import { BranchDown } from 'reicon-react/icons/BranchDown';
import { Check } from 'reicon-react/icons/Check';
import { ChevronDown } from 'reicon-react/icons/ChevronDown';
import { ChevronLeft } from 'reicon-react/icons/ChevronLeft';
import { BookOpen } from 'reicon-react/icons/BookOpen';
import { Folder } from 'reicon-react/icons/Folder';
import { Files } from 'reicon-react/icons/Files';
import { Checklist } from 'reicon-react/icons/Checklist';
import { Cpu } from 'reicon-react/icons/Cpu';
import { ChartBar } from 'reicon-react/icons/ChartBar';
import { Database } from 'reicon-react/icons/Database';
import { HelpCircle } from 'reicon-react/icons/HelpCircle';
import { People } from 'reicon-react/icons/People';
import { Setting2 } from 'reicon-react/icons/Setting2';
import { ShieldUser } from 'reicon-react/icons/ShieldUser';
import { User } from 'reicon-react/icons/User';
import { UserAdd } from 'reicon-react/icons/UserAdd';
import { UserCircle } from 'reicon-react/icons/UserCircle';
import { Inbox } from 'reicon-react/icons/Inbox';
import { Plug } from 'reicon-react/icons/Plug';
import { Book } from 'reicon-react/icons/Book';
import { Logout } from 'reicon-react/icons/Logout';
import { Monitor } from 'reicon-react/icons/Monitor';
import { Moon } from 'reicon-react/icons/Moon';
import { PenSquare } from 'reicon-react/icons/PenSquare';
import { ChatRound } from 'reicon-react/icons/ChatRound';
import { Search3 } from 'reicon-react/icons/Search3';
import { Sun } from 'reicon-react/icons/Sun';
import { Users } from 'reicon-react/icons/Users';
import { workspaceRoute } from '@/router';
import { WorkspaceSetup } from './workspace-setup';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { rememberWorkspace } from '@/lib/last-workspace';
import { workspacePageScroller } from '@/lib/page-scroller';
import { saveLastWorkspace } from '@/lib/workspaces';
import { requestSignal } from '@/lib/http';
import { readTheme, saveTheme, type Theme } from '@/lib/theme';
import { EntityAvatar } from '@tulipfarm/sprout/avatar';
import { Button } from '@tulipfarm/sprout/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@tulipfarm/sprout/sidebar';
import { SidebarLeft } from 'reicon-react/icons/SidebarLeft';
import { TooltipProvider } from '@tulipfarm/sprout/tooltip';
import { authClient } from '@/lib/auth';
import { SearchPalette, useSearchShortcut } from '@/features/search/search-palette';
import { overrides } from '@/extensions';
import { PageChromeContext } from '@tulipfarm/sprout/page-header';
import { ChatHeaderContext } from '@/features/chat/header-context';
import { BudProvider } from '@/features/chat/bud-provider';
import { WorkspaceQueryProvider } from '@/lib/query';
import { setAnalyticsWorkspace } from '@/lib/analytics';
import { setFlagWorkspace, useFlag } from '@/lib/feature-flags';
import { useWorkspaceSettings } from '@/features/settings/queries';
import type { RecentSection } from '@/features/navigation/recent-queries';
import { ReauthorizationBanner } from '@/features/integrations/reauthorization-banner';
import { ReconnectBanner } from '@/features/workspaces/reconnect-banner';

export type WorkspacePath =
  | '/$workspaceSlug/settings/soul'
  | '/$workspaceSlug'
  | '/$workspaceSlug/chat'
  | '/$workspaceSlug/inbox'
  | '/$workspaceSlug/calendar'
  | '/$workspaceSlug/agents'
  | '/$workspaceSlug/projects'
  | '/$workspaceSlug/skills'
  | '/$workspaceSlug/agent-tasks'
  | '/$workspaceSlug/files'
  | '/$workspaceSlug/knowledge'
  | '/$workspaceSlug/workflows'
  | '/$workspaceSlug/settings'
  | '/$workspaceSlug/settings/account'
  | '/$workspaceSlug/settings/models'
  | '/$workspaceSlug/settings/usage'
  | '/$workspaceSlug/teams'
  | '/$workspaceSlug/grants'
  | '/$workspaceSlug/members'
  | '/$workspaceSlug/tables'
  | '/$workspaceSlug/integrations'
  | '/$workspaceSlug/help';
export type Page = { label: string; to: WorkspacePath; icon?: typeof Add; recent?: RecentSection };
const SidebarCredits = overrides.get('credits');
const creditsShown = overrides.overriddenBy('credits') !== undefined;
const SidebarNavItem = lazy(() =>
  import('@/features/navigation/sidebar-nav-item').then(module => ({ default: module.SidebarNavItem })),
);
const SidebarMockNavItem = import.meta.env.DEV
  ? lazy(() => import('@/features/navigation/sidebar-mock').then(module => ({ default: module.SidebarMockNavItem })))
  : null;
const SidebarMockPage = import.meta.env.DEV
  ? lazy(() => import('@/features/navigation/sidebar-mock').then(module => ({ default: module.SidebarMockPage })))
  : null;

const newChat: Page = { label: 'New chat', to: '/$workspaceSlug', icon: PenSquare };
const chats: Page = { label: 'Chats', to: '/$workspaceSlug/chat', icon: ChatRound, recent: 'chat' };
function preloadChatsCode() {
  void import('./workspace-chats').catch(() => {});
}
const inbox: Page = { label: 'Inbox', to: '/$workspaceSlug/inbox', icon: Inbox };
const settings: Page = { label: 'Settings', to: '/$workspaceSlug/settings', icon: Setting2 };
const account: Page = { label: 'Account', to: '/$workspaceSlug/settings/account', icon: UserCircle };
const members: Page = { label: 'Members', to: '/$workspaceSlug/members', icon: User };
const workspaceGroups: { label: string; pages: Page[] }[] = [
  {
    label: 'Daily work',
    pages: [
      { label: 'Calendar', to: '/$workspaceSlug/calendar', icon: CalendarDays },
      { label: 'Projects', to: '/$workspaceSlug/projects', icon: Folder, recent: 'projects' },
      { label: 'My agent tasks', to: '/$workspaceSlug/agent-tasks', icon: Checklist, recent: 'agent-tasks' },
    ],
  },
  {
    label: 'Agents & workflows',
    pages: [
      { label: 'Agents', to: '/$workspaceSlug/agents', icon: Users, recent: 'agents' },
      { label: 'Skills', to: '/$workspaceSlug/skills', icon: BookOpen },
      { label: 'Workflows', to: '/$workspaceSlug/workflows', icon: BranchDown, recent: 'workflows' },
    ],
  },
  {
    label: 'Data & integrations',
    pages: [
      { label: 'Tables', to: '/$workspaceSlug/tables', icon: Database, recent: 'tables' },
      { label: 'Files', to: '/$workspaceSlug/files', icon: Files, recent: 'files' },
      { label: 'Knowledge', to: '/$workspaceSlug/knowledge', icon: Book },
      { label: 'Integrations', to: '/$workspaceSlug/integrations', icon: Plug },
    ],
  },
];
const workspacePages = workspaceGroups.flatMap(group => group.pages);
const models: Page = { label: 'Models', to: '/$workspaceSlug/settings/models', icon: Cpu };
// Usage exists only when a web extension supplies the page.
const usage: Page[] = overrides.get('usage')
  ? [{ label: 'Usage', to: '/$workspaceSlug/settings/usage', icon: ChartBar }]
  : [];
const soul: Page = { label: 'Soul repository', to: '/$workspaceSlug/settings/soul', icon: Files };
const administrationPages: Page[] = [
  members,
  { label: 'Teams', to: '/$workspaceSlug/teams', icon: People },
  { label: 'Table access', to: '/$workspaceSlug/grants', icon: ShieldUser },
];
const settingsPages: Page[] = [
  { label: 'General', to: settings.to, icon: Setting2 },
  ...administrationPages,
  models,
  ...usage,
  soul,
];
const pages = [
  newChat,
  chats,
  inbox,
  account,
  models,
  ...usage,
  soul,
  settings,
  { label: 'Help and support', to: '/$workspaceSlug/help' } satisfies Page,
  ...administrationPages,
  ...workspacePages,
];
export const searchPages = [
  newChat,
  chats,
  ...workspacePages,
  settings,
  ...administrationPages,
  models,
  ...usage,
  account,
];

function useCurrentPage(): Page {
  const { workspace } = workspaceRoute.useRouteContext();
  const pathname = useLocation({ select: location => location.pathname.replace(/\/$/, '') });
  return (
    pages.find(page => {
      const path = page.to.replace('$workspaceSlug', workspace.slug);
      return pathname === path || (page !== newChat && pathname.startsWith(`${path}/`));
    }) ?? newChat
  );
}

function useGoToSettingsShortcut() {
  const { workspace } = workspaceRoute.useRouteContext();
  const navigate = useNavigate();
  useEffect(() => {
    let pendingG = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('input, textarea, select, [contenteditable="true"]')
      )
        return;
      const key = event.key.toLowerCase();
      if (key === 's' && Date.now() - pendingG < 1000) {
        pendingG = 0;
        event.preventDefault();
        void navigate({ to: settings.to, params: { workspaceSlug: workspace.slug } });
        return;
      }
      pendingG = key === 'g' ? Date.now() : 0;
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, workspace.slug]);
}

function NavItem({ page }: { page: Page }) {
  const { workspace } = workspaceRoute.useRouteContext();
  if (SidebarMockNavItem && workspace.slug === 'sidebar-mock')
    return (
      <Suspense fallback={<StandardNavItem page={page} />}>
        <SidebarMockNavItem page={page} />
      </Suspense>
    );
  if (page.recent && workspace.status === 'ready')
    return (
      <Suspense fallback={<StandardNavItem page={page} />}>
        <SidebarNavItem
          key={workspace.id}
          page={page}
          section={page.recent}
          workspaceId={workspace.id}
          slug={workspace.slug}
          onIntent={page === chats ? preloadChatsCode : undefined}
        />
      </Suspense>
    );
  return <StandardNavItem page={page} />;
}

function StandardNavItem({ page }: { page: Page }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const { setOpenMobile } = useSidebar();
  const active = useCurrentPage().to === page.to;
  const Icon = page.icon;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        icon={Icon && <Icon size={16} aria-hidden="true" />}
        tooltip={page.label}
        isActive={active}
        aria-current={active ? 'page' : undefined}
        nativeButton={false}
        render={
          <Link
            to={page.to}
            params={{ workspaceSlug: workspace.slug }}
            activeOptions={{ exact: page === newChat }}
            preload={false}
            onPointerEnter={page === chats ? preloadChatsCode : undefined}
            onFocus={page === chats ? preloadChatsCode : undefined}
          />
        }
        onClick={() => setOpenMobile(false)}
      >
        {page.label}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function WorkspaceMenu() {
  const { workspace, workspaces: choices } = workspaceRoute.useRouteContext();
  const { setOpenMobile } = useSidebar();
  const params = { workspaceSlug: workspace.slug };
  const close = () => setOpenMobile(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Workspace menu, ${workspace.name}`}
        render={
          <SidebarMenuButton
            tooltip={workspace.name}
            icon={
              <EntityAvatar seed={workspace.id} name={workspace.name} image={workspace.icon} size="sm" shape="square" />
            }
            badge={<ChevronDown size={12} aria-hidden="true" />}
          />
        }
      >
        {workspace.name}
      </DropdownMenuTrigger>
      <DropdownMenuContent size="menu">
        <DropdownMenuItem render={<Link to={settings.to} params={params} />} onClick={close}>
          <Setting2 size={14} aria-hidden="true" />
          Settings<DropdownMenuShortcut>G then S</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem render={<Link to={members.to} params={params} />} onClick={close}>
          <UserAdd size={14} aria-hidden="true" />
          Invite and manage members
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Switch workspace</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {choices.map(item => (
              <DropdownMenuItem
                key={item.slug}
                render={<Link to="/$workspaceSlug" params={{ workspaceSlug: item.slug }} />}
                onClick={close}
              >
                <EntityAvatar seed={item.id} name={item.name} image={item.icon} size="sm" shape="square" />
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                {item.slug === workspace.slug && <Check size={14} aria-label="Current workspace" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link to="/create-workspace" />} onClick={close}>
              <Add size={14} aria-hidden="true" />
              Create workspace
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const themeOptions: { value: Theme; label: string; icon: typeof Add }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

function ProfileMenu() {
  const { user, workspace } = workspaceRoute.useRouteContext();
  const name = user.name || user.email;
  const [theme, setTheme] = useState<Theme>(readTheme);
  const { setOpenMobile } = useSidebar();
  const destination = useLocation({ select: location => location.href });
  return (
    <DropdownMenu
      onOpenChange={open => {
        if (open) setTheme(readTheme());
      }}
    >
      <DropdownMenuTrigger
        aria-label="Account menu"
        render={
          <SidebarMenuButton
            tooltip="Account"
            icon={<EntityAvatar seed={user.id} name={name} image={user.image} size="sm" />}
          />
        }
      >
        {name}
      </DropdownMenuTrigger>
      <DropdownMenuContent size="menu" side="top">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <span className="block truncate">{user.email}</span>
          </DropdownMenuLabel>
          <DropdownMenuItem
            render={<Link to={account.to} params={{ workspaceSlug: workspace.slug }} />}
            onClick={() => setOpenMobile(false)}
          >
            <UserCircle size={14} aria-hidden="true" />
            Account settings
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          render={<Link to="/$workspaceSlug/help" params={{ workspaceSlug: workspace.slug }} />}
          onClick={() => setOpenMobile(false)}
        >
          <HelpCircle size={14} aria-hidden="true" />
          Help and support
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Monitor size={14} aria-hidden="true" />
            Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={theme}
              onValueChange={value => {
                const option = themeOptions.find(item => item.value === value);
                if (!option) return;
                saveTheme(option.value);
                setTheme(option.value);
              }}
            >
              {themeOptions.map(({ value, label, icon: Icon }) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  <Icon size={14} aria-hidden="true" />
                  {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          render={<Link to="/logout" search={{ redirect: destination }} />}
          onClick={() => setOpenMobile(false)}
        >
          <Logout size={14} aria-hidden="true" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function useSettingsMode() {
  const current = useCurrentPage();
  return current === account || settingsPages.some(page => page.to === current.to);
}

function SettingsNavigation() {
  const { workspace } = workspaceRoute.useRouteContext();
  const soulEnabled = useFlag('soul-repository-explorer');
  const settings = useWorkspaceSettings(workspace.id);
  const soulVisible =
    soulEnabled &&
    settings.state.kind === 'ready' &&
    !settings.state.error &&
    settings.state.data.settings.canManage &&
    settings.state.data.membership.role === 'admin';
  const { setOpenMobile } = useSidebar();
  return (
    <>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              icon={<ChevronLeft size={16} aria-hidden="true" />}
              tooltip="Back to app"
              nativeButton={false}
              render={<Link to="/$workspaceSlug" params={{ workspaceSlug: workspace.slug }} />}
              onClick={() => setOpenMobile(false)}
            >
              Back to app
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Settings">
          <SidebarGroup>
            <SidebarGroupLabel>Personal</SidebarGroupLabel>
            <SidebarMenu>
              <NavItem page={account} />
            </SidebarMenu>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>{workspace.name}</SidebarGroupLabel>
            <SidebarMenu>
              {settingsPages
                .filter(page => page !== soul || soulVisible)
                .map(page => (
                  <NavItem key={page.to} page={page} />
                ))}
            </SidebarMenu>
          </SidebarGroup>
        </nav>
      </SidebarContent>
    </>
  );
}

function WorkspaceNavigation({ onSearch }: { onSearch: () => void }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const { setOpenMobile } = useSidebar();
  const settingsMode = useSettingsMode();
  return (
    <Sidebar collapsible="icon" label="Workspace sidebar">
      <>
        {settingsMode ? (
          <SettingsNavigation />
        ) : (
          <>
            <SidebarHeader>
              <SidebarMenu>
                <SidebarMenuItem>
                  <WorkspaceMenu />
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarHeader>
            <SidebarContent>
              <nav aria-label="Workspace navigation">
                <SidebarGroup>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        icon={<Search3 size={16} aria-hidden="true" />}
                        tooltip="Jump to…"
                        aria-keyshortcuts="Meta+K Control+K"
                        onClick={() => {
                          setOpenMobile(false);
                          onSearch();
                        }}
                      >
                        Jump to…
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <NavItem page={newChat} />
                    <NavItem page={chats} />
                  </SidebarMenu>
                </SidebarGroup>
                {workspaceGroups.map(group => (
                  <SidebarGroup key={group.label}>
                    <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                    <SidebarMenu>
                      {group.pages.map(page => (
                        <NavItem key={page.to} page={page} />
                      ))}
                    </SidebarMenu>
                  </SidebarGroup>
                ))}
              </nav>
            </SidebarContent>
          </>
        )}
        <SidebarFooter>
          <SidebarMenu>
            {creditsShown && workspace.status === 'ready' && (
              <SidebarMenuItem>
                <SidebarCredits key={workspace.id} workspaceId={workspace.id} slug={workspace.slug} />
              </SidebarMenuItem>
            )}
            <SidebarMenuItem>
              <ProfileMenu />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </>
    </Sidebar>
  );
}

export function WorkspaceShell() {
  const { user, sessionId, workspace, membershipId, workspaceAccess, accessRevision } =
    workspaceRoute.useRouteContext();
  const { data: session, isPending, error } = authClient.useSession();
  const access = useSyncExternalStore(
    workspaceAccess.subscribe,
    workspaceAccess.getSnapshot,
    workspaceAccess.getSnapshot,
  );
  const destination = useLocation({ select: location => location.href });
  const router = useRouter();
  const admitted = useCallback(() => {
    const current = workspaceAccess.getSnapshot();
    return current.kind === 'admitted' && current.revision === accessRevision;
  }, [workspaceAccess, accessRevision]);
  if (error?.status === 401 || (access.kind === 'denied' && access.status === 401))
    return (
      <StatePanel
        kind="unavailable"
        title="Sign in to continue"
        description="Your session has expired. Sign in again to open your workspace."
      >
        <Button nativeButton={false} render={<Link to="/login" search={{ redirect: destination }} />}>
          Sign in
        </Button>
      </StatePanel>
    );
  if (session ? session.user.id !== user.id || session.session.id !== sessionId : !isPending && !error)
    return (
      <div role="status">
        <Spinner aria-label="Opening workspace" />
      </div>
    );
  if (access.kind === 'denied')
    return (
      <StatePanel
        kind="unavailable"
        title="Workspace access changed"
        description="You no longer have access to this workspace. Return to a workspace you can access."
      >
        <Button nativeButton={false} render={<Link to="/" />}>
          Back to TulipFarm
        </Button>
      </StatePanel>
    );
  if (access.kind !== 'admitted' || access.revision !== accessRevision)
    return (
      <StatePanel
        kind="unavailable"
        title="Workspace access changed"
        description="Check your workspace access before continuing."
      >
        <Button onClick={() => void router.invalidate()}>Check workspace access again</Button>
        <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
          Back to TulipFarm
        </Button>
      </StatePanel>
    );
  if (!membershipId) return <WorkspaceShellContent key={`${sessionId}:${user.id}`} />;
  return (
    <WorkspaceQueryProvider
      scope={{ kind: 'workspace', userId: user.id, workspaceId: workspace.id, membershipId }}
      admitted={admitted}
      subscribe={workspaceAccess.subscribe}
    >
      <WorkspaceShellContent key={`${sessionId}:${user.id}`} />
    </WorkspaceQueryProvider>
  );
}

function WorkspaceShellContent() {
  const { user, workspace, workspaceStale } = workspaceRoute.useRouteContext();
  // Integration pages explain the stale state themselves and pause their controls.
  const onIntegrations = useLocation({
    select: location =>
      location.pathname === `/${workspace.slug}/integrations` ||
      location.pathname.startsWith(`/${workspace.slug}/integrations/`),
  });
  useEffect(() => {
    setAnalyticsWorkspace({ id: workspace.id, slug: workspace.slug, name: workspace.name });
    return () => setAnalyticsWorkspace(undefined);
  }, [workspace.id, workspace.slug, workspace.name]);
  useEffect(() => setFlagWorkspace(workspace.slug), [workspace.slug]);
  const [headerElement, setHeaderElement] = useState<HTMLDivElement | null>(null);
  const [actionsElement, setActionsElement] = useState<HTMLDivElement | null>(null);
  const chrome = useMemo(
    () => ({ title: headerElement, actions: actionsElement, documentTitle: (title: string) => `${title} · TulipFarm` }),
    [headerElement, actionsElement],
  );
  const currentPage = useCurrentPage(),
    onCalendar = currentPage.to === '/$workspaceSlug/calendar';
  const onNewChat = currentPage === newChat;
  const [navigationOpen, setNavigationOpen] = useState(true);
  const [calendarNavigationOpen, setCalendarNavigationOpen] = useState(false);
  useEffect(() => {
    if (onNewChat) document.title = 'New chat · TulipFarm';
  }, [onNewChat]);
  const navigate = useNavigate();
  const [searchOpen, setSearchOpen] = useState(false);
  useGoToSettingsShortcut();
  useSearchShortcut(useCallback(() => setSearchOpen(open => !open), []));
  useEffect(() => {
    const controller = new AbortController();
    rememberWorkspace(user.id, workspace.id);
    void saveLastWorkspace(workspace.slug, requestSignal(controller.signal)).catch(error => {
      if (!controller.signal.aborted) console.error('Could not save your last workspace. Reload to try again.', error);
    });
    return () => controller.abort();
  }, [user.id, workspace.id, workspace.slug]);
  return (
    <TooltipProvider>
      {/* The analytics consent banner reserves --consent-inset at the bottom of the viewport. */}
      <div className="grid h-svh grid-rows-1 overflow-hidden pb-(--consent-inset,0px)">
        <SidebarProvider
          open={onCalendar ? calendarNavigationOpen : navigationOpen}
          onOpenChange={onCalendar ? setCalendarNavigationOpen : setNavigationOpen}
        >
          <WorkspaceNavigation onSearch={() => setSearchOpen(true)} />
          <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
            {workspaceStale && <ReconnectBanner showMessage={!onIntegrations} />}
            {workspace.status === 'ready' && (
              <ReauthorizationBanner key={workspace.id} workspaceId={workspace.id} slug={workspace.slug} />
            )}
            <header
              aria-label="Workspace header"
              className={`@container flex h-(--sprout-bar-height) shrink-0 items-center gap-2 border-b px-3 ${onCalendar ? 'pointer-coarse:h-14' : ''}`}
            >
              <SidebarTrigger>
                <SidebarLeft size={16} aria-hidden="true" />
              </SidebarTrigger>
              <div ref={setHeaderElement} className="flex min-w-0 flex-1 items-center gap-2" />
              <div ref={setActionsElement} className="flex shrink-0 items-center gap-2" />
              {/* Under 20rem the page title needs the room; the navigation sheet still names the workspace. */}
              {!onCalendar && (
                <span
                  title={workspace.name}
                  className="max-w-24 truncate text-xs text-muted-foreground md:hidden @max-xs:hidden"
                >
                  {workspace.name}
                </span>
              )}
            </header>
            <PageChromeContext value={chrome}>
              <ChatHeaderContext value={headerElement}>
                {workspace.status === 'provisioning' ? (
                  <WorkspaceSetup key={workspace.slug} name={workspace.name} slug={workspace.slug} />
                ) : SidebarMockPage && workspace.slug === 'sidebar-mock' ? (
                  <Suspense fallback={<p role="status">Opening mock...</p>}>
                    <SidebarMockPage />
                  </Suspense>
                ) : (
                  <BudProvider key={workspace.id} headerActions={actionsElement}>
                    {/* Pages scroll here; full-height pages such as chat fill it and scroll their own panes. */}
                    <div
                      data-scroll-restoration-id={workspacePageScroller}
                      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
                    >
                      <Outlet />
                    </div>
                  </BudProvider>
                )}
              </ChatHeaderContext>
            </PageChromeContext>
          </main>
          <SearchPalette
            open={searchOpen}
            onOpenChange={setSearchOpen}
            pages={searchPages}
            onOpen={to => void navigate({ to, params: { workspaceSlug: workspace.slug } })}
          />
        </SidebarProvider>
      </div>
    </TooltipProvider>
  );
}

/** Inbox has no backend yet, so a direct link explains that and points to where waiting work lives today. */
export function InboxPage() {
  const { workspace } = workspaceRoute.useRouteContext();
  const params = { workspaceSlug: workspace.slug };
  return (
    <section aria-label={inbox.label} className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
      <StatePanel
        heading="h1"
        kind="unavailable"
        title={`${inbox.label} isn’t available yet`}
        description="There is no single inbox yet. Tasks waiting for your answer or review are listed in Tasks, workflow runs waiting for a person are in each workflow’s run history, and your conversations are in Chats."
      >
        <div className="flex flex-wrap justify-center gap-2">
          <Button nativeButton={false} render={<Link to="/$workspaceSlug/agent-tasks" params={params} />}>
            Open tasks
          </Button>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link to="/$workspaceSlug/workflows" params={params} />}
          >
            Open workflows
          </Button>
          <Button variant="outline" nativeButton={false} render={<Link to="/$workspaceSlug/chat" params={params} />}>
            Open chats
          </Button>
        </div>
      </StatePanel>
    </section>
  );
}
