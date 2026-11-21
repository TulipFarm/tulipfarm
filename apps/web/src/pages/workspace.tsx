import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type CSSProperties,
} from 'react';
import {
  AddIcon,
  AgentIcon,
  AppsIcon,
  ChartBarIcon,
  ChatIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronUpIcon,
  CodeIcon,
  ComposeIcon,
  CpuIcon,
  DatabaseIcon,
  FilesIcon,
  FolderIcon,
  GlobeIcon,
  HelpCircleIcon,
  InboxIcon,
  LockIcon,
  LogoutIcon,
  MonitorIcon,
  MoonIcon,
  PlugIcon,
  SearchIcon,
  SettingsIcon,
  ShieldUserIcon,
  SidebarLeftIcon,
  SunIcon,
  TasksIcon,
  TerminalIcon,
  UserCircleIcon,
  UserIcon,
  UsersIcon,
  WorkflowIcon,
} from '@tulipfarm/icons';
import { Link, Outlet, useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import { Toaster } from '@tulipfarm/sprout/toast';
import { preloadRouteCode, workspaceRoute } from '@/router';
import { whenCodeQuiet } from '@/lib/code-quiet';
import { RecordLinkPrefetch } from '@/features/navigation/record-link-prefetch';
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
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from '@tulipfarm/sprout/sidebar';
import { SidebarRecents } from '@/features/navigation/sidebar-recents';
import { TooltipProvider } from '@tulipfarm/sprout/tooltip';
import { authClient } from '@/lib/auth';
import { useSearchShortcut } from '@/features/search/search-shortcut';
import { overrides } from '@/extensions';
import { PageChromeContext } from '@tulipfarm/sprout/page-header';
import { ChatHeaderContext } from '@/features/chat/header-context';
import { useOwnMembership } from '@/features/governance/queries';
import { BudProvider } from '@/features/chat/bud-provider';
import { WorkspaceQueryProvider } from '@/lib/query';
import { setAnalyticsWorkspace } from '@/lib/analytics';
import { setFlagWorkspace } from '@/lib/feature-flags';
import { useWorkspaceSettings } from '@/features/settings/queries';
import { useSecretsCapabilities } from '@/features/secrets/queries';
import type { RecentSection } from '@/features/navigation/recent-queries';
import { ReauthorizationBanner } from '@/features/integrations/reauthorization-banner';
import { CreditsBanner } from '@/features/usage/credits-banner';
import { ReconnectBanner } from '@/features/workspaces/reconnect-banner';
import { InboxCount } from '@/features/inbox/inbox';

export type WorkspacePath =
  | '/$workspaceSlug/settings/soul'
  | '/$workspaceSlug'
  | '/$workspaceSlug/chat'
  | '/$workspaceSlug/inbox'
  | '/$workspaceSlug/tasks'
  | '/$workspaceSlug/calendar'
  | '/$workspaceSlug/agents'
  | '/$workspaceSlug/projects'
  | '/$workspaceSlug/skills'
  | '/$workspaceSlug/packages'
  | '/$workspaceSlug/agent-tasks'
  | '/$workspaceSlug/files'
  | '/$workspaceSlug/knowledge'
  | '/$workspaceSlug/workflows'
  | '/$workspaceSlug/apps'
  | '/$workspaceSlug/settings'
  | '/$workspaceSlug/settings/account'
  | '/$workspaceSlug/settings/secrets'
  | '/$workspaceSlug/settings/browser-logins'
  | '/$workspaceSlug/settings/code'
  | '/$workspaceSlug/settings/models'
  | '/$workspaceSlug/settings/usage'
  | '/$workspaceSlug/settings/api'
  | '/$workspaceSlug/teams'
  | '/$workspaceSlug/grants'
  | '/$workspaceSlug/members'
  | '/$workspaceSlug/tables'
  | '/$workspaceSlug/integrations'
  | '/$workspaceSlug/help';
export type Page = {
  label: string;
  to: WorkspacePath;
  icon?: typeof AddIcon;
  recent?: RecentSection;
  detail?: string;
  keywords?: string[];
  shortcut?: string;
};
const isApplePlatform =
  typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
const searchShortcutLabel = isApplePlatform ? '⌘K' : 'Ctrl K';
const SidebarCredits = overrides.get('credits');
const creditsShown = overrides.overriddenBy('credits') !== undefined;
// Parts most visits never show load on their own, after the page.
const WorkspaceSetup = lazy(() => import('./workspace-setup').then(module => ({ default: module.WorkspaceSetup })));
const SearchPalette = lazy(() =>
  import('@/features/search/search-palette').then(module => ({ default: module.SearchPalette })),
);
const InviteMembersPrompt = lazy(() =>
  import('@/features/governance/invite-members-prompt').then(module => ({ default: module.InviteMembersPrompt })),
);
const QuickTask = lazy(() =>
  import('@/features/task-board/quick-task').then(module => ({ default: module.QuickTask })),
);
const InboxList = lazy(() => import('@/features/inbox/inbox-list').then(module => ({ default: module.InboxList })));
const SidebarNavItem = lazy(() =>
  import('@/features/navigation/sidebar-nav-item').then(module => ({ default: module.SidebarNavItem })),
);
const SidebarMockNavItem = import.meta.env.DEV
  ? lazy(() => import('@/features/navigation/sidebar-mock').then(module => ({ default: module.SidebarMockNavItem })))
  : null;
const SidebarMockPage = import.meta.env.DEV
  ? lazy(() => import('@/features/navigation/sidebar-mock').then(module => ({ default: module.SidebarMockPage })))
  : null;

const newChat: Page = {
  label: 'New chat',
  to: '/$workspaceSlug',
  icon: ComposeIcon,
  detail: 'Start a fresh conversation in this workspace',
  keywords: ['home', 'ask', 'compose', 'prompt'],
};
const chats: Page = {
  label: 'Chats',
  to: '/$workspaceSlug/chat',
  icon: ChatIcon,
  recent: 'chat',
  detail: 'Browse and continue workspace conversations',
  keywords: ['conversations', 'history', 'messages'],
};
const inbox: Page = {
  label: 'Inbox',
  to: '/$workspaceSlug/inbox',
  icon: InboxIcon,
  detail: 'Tasks and approvals waiting on you',
  keywords: ['notifications', 'approvals', 'waiting', 'reviews'],
};
const tasks: Page = {
  label: 'Tasks',
  to: '/$workspaceSlug/tasks',
  icon: TasksIcon,
  detail: 'Work assigned to people and agents',
  keywords: ['todo', 'assignments', 'board'],
};
const agentTasks: Page = {
  label: 'My agent tasks',
  to: '/$workspaceSlug/agent-tasks',
  icon: TasksIcon,
  detail: 'History of background tasks run by your agents',
  keywords: ['runs', 'jobs', 'background'],
};
const settings: Page = {
  label: 'Settings',
  to: '/$workspaceSlug/settings',
  icon: SettingsIcon,
  detail: 'Workspace name, defaults, and administration',
  keywords: ['general', 'preferences', 'workspace', 'config'],
  shortcut: 'G S',
};
const account: Page = {
  label: 'Account',
  to: '/$workspaceSlug/settings/account',
  icon: UserCircleIcon,
  detail: 'Personal profile, memory, and assistant preferences',
  keywords: ['profile', 'me', 'memory', 'bud', 'theme'],
};
const secrets: Page = {
  label: 'Secrets',
  to: '/$workspaceSlug/settings/secrets',
  icon: LockIcon,
  detail: 'Encrypted API keys and credentials for agents and workflows',
  keywords: ['api keys', 'tokens', 'credentials', 'env'],
};
const browserLogins: Page = {
  label: 'Browser logins',
  to: '/$workspaceSlug/settings/browser-logins',
  icon: GlobeIcon,
  detail: 'Saved website sessions for browser-capable agents',
  keywords: ['browser', 'sessions', 'cookies', 'sign in'],
};
const members: Page = {
  label: 'Members',
  to: '/$workspaceSlug/members',
  icon: UserIcon,
  detail: 'Invite people and manage workspace roles',
  keywords: ['invite', 'people', 'person', 'profiles', 'users', 'workspace members', 'roles', 'permissions'],
};
const membersAndTeams: Page = {
  label: 'Members & teams',
  to: members.to,
  icon: UsersIcon,
  detail: 'Manage workspace members, invites, and teams',
  keywords: ['invite', 'people', 'person', 'profiles', 'users', 'workspace members', 'roles', 'teams', 'permissions'],
};
const teams: Page = {
  label: 'Teams',
  to: '/$workspaceSlug/teams',
  icon: UsersIcon,
  detail: 'Groups for organizing people and shared access',
  keywords: ['groups', 'people', 'departments'],
};
const agents: Page = {
  label: 'Agents',
  to: '/$workspaceSlug/agents',
  icon: AgentIcon,
  recent: 'agents',
  detail: 'Build, configure, and run autonomous agents',
  keywords: ['bots', 'assistants', 'automations'],
};
const workflows: Page = {
  label: 'Workflows',
  to: '/$workspaceSlug/workflows',
  icon: WorkflowIcon,
  recent: 'workflows',
  detail: 'Automate schedules, triggers, and multi-step runs',
  keywords: ['automations', 'schedules', 'triggers', 'pipelines'],
};
const apps: Page = {
  label: 'Apps',
  to: '/$workspaceSlug/apps',
  icon: AppsIcon,
  detail: 'Internal and public web apps built from your data',
  keywords: ['web apps', 'sites', 'dashboards', 'pages'],
};
const tables: Page = {
  label: 'Tables',
  to: '/$workspaceSlug/tables',
  icon: DatabaseIcon,
  recent: 'tables',
  detail: 'Structured business records, views, and queries',
  keywords: ['database', 'records', 'rows', 'data', 'crm'],
};
const files: Page = {
  label: 'Files',
  to: '/$workspaceSlug/files',
  icon: FolderIcon,
  recent: 'files',
  detail: 'Shared documents, folders, and knowledge files',
  keywords: ['documents', 'uploads', 'library', 'folders', 'drive'],
};
const integrations: Page = {
  label: 'Integrations',
  to: '/$workspaceSlug/integrations',
  icon: PlugIcon,
  detail: 'Connect Slack, Google, GitHub, and external tools',
  keywords: ['slack', 'google', 'github', 'mcp', 'connect', 'apps'],
};
const help: Page = {
  label: 'Help and support',
  to: '/$workspaceSlug/help',
  icon: HelpCircleIcon,
  detail: 'Guides, documentation, and support options',
  keywords: ['docs', 'support', 'contact', 'faq'],
};
const automatePages: Page[] = [agents, workflows, apps];
const dataPages: Page[] = [tables, files, integrations];
const workspaceGroups: { label: string; pages: Page[] }[] = [
  { label: 'Automate', pages: automatePages },
  { label: 'Data', pages: dataPages },
];
const workspacePages = workspaceGroups.flatMap(group => group.pages);
const preloadPageCode = (page: Page, slug: string) => preloadRouteCode(page.to.replace('$workspaceSlug', slug));
// Pages split out of the first download would each cost a round of chunk requests on first
// visit. Once the open page has stopped downloading code, fetch the sidebar pages' code one at a time while idle.
function usePreloadSidebarCode(slug: string) {
  useEffect(() => {
    let stopped = false;
    const idle = () =>
      new Promise<void>(resolve =>
        'requestIdleCallback' in window
          ? requestIdleCallback(() => resolve(), { timeout: 2000 })
          : setTimeout(resolve, 200),
      );
    const run = async () => {
      for (const page of [chats, ...workspacePages]) {
        await idle();
        if (stopped) return;
        await preloadPageCode(page, slug);
      }
    };
    void whenCodeQuiet().then(run);
    return () => {
      stopped = true;
    };
  }, [slug]);
}
const codeSettingsPage: Page = {
  label: 'Code',
  to: '/$workspaceSlug/settings/code',
  icon: TerminalIcon,
  detail: 'Branch prefix, pull request defaults, and code reviewers',
  keywords: ['code', 'coding', 'pr', 'git', 'claude', 'codex', 'copilot'],
};
const models: Page = {
  label: 'Models',
  to: '/$workspaceSlug/settings/models',
  icon: CpuIcon,
  detail: 'Choose default AI models and routing for this workspace',
  keywords: ['llm', 'claude', 'openai', 'gemini', 'grok', 'ai'],
};
const usage: Page = {
  label: 'Usage',
  to: '/$workspaceSlug/settings/usage',
  icon: ChartBarIcon,
  detail: 'Credits balance, spend history, and model usage',
  keywords: ['billing', 'credits', 'spend', 'cost', 'plan'],
};
const externalAccess: Page = {
  label: 'API and MCP',
  to: '/$workspaceSlug/settings/api',
  icon: CodeIcon,
  detail: 'Access tokens for the REST API and the MCP server',
  keywords: ['token', 'rest', 'mcp', 'integration', 'developer', 'claude code'],
};
const soul: Page = {
  label: 'Soul repository',
  to: '/$workspaceSlug/settings/soul',
  icon: FilesIcon,
  detail: 'Versioned workspace configuration and agent definitions',
  keywords: ['git', 'commits', 'history', 'repo'],
};
const tableAccess: Page = {
  label: 'Table access',
  to: '/$workspaceSlug/grants',
  icon: ShieldUserIcon,
  detail: 'Control which people and teams can read or edit tables',
  keywords: ['grants', 'permissions', 'access control', 'security'],
};
const administrationPages: Page[] = [members, teams, tableAccess];
const settingsPages: Page[] = [
  { label: 'General', to: settings.to, icon: SettingsIcon },
  membersAndTeams,
  tableAccess,
  models,
  codeSettingsPage,
  usage,
  externalAccess,
  soul,
];
// Pages without a sidebar entry still resolve as the current page, so New chat isn't marked current on them.
const unlistedPages: Page[] = [
  { label: 'Calendar', to: '/$workspaceSlug/calendar' },
  { label: 'Projects', to: '/$workspaceSlug/projects' },
  agentTasks,
  { label: 'Skills', to: '/$workspaceSlug/skills' },
  { label: 'Packages', to: '/$workspaceSlug/packages' },
  { label: 'Knowledge', to: '/$workspaceSlug/knowledge' },
];
const pages = [
  newChat,
  chats,
  inbox,
  tasks,
  account,
  secrets,
  browserLogins,
  codeSettingsPage,
  models,
  usage,
  externalAccess,
  soul,
  settings,
  help,
  ...administrationPages,
  ...workspacePages,
  ...unlistedPages,
];
export const searchPages = [
  chats,
  inbox,
  tasks,
  ...workspacePages,
  agentTasks,
  settings,
  ...administrationPages,
  models,
  codeSettingsPage,
  usage,
  externalAccess,
  account,
  secrets,
  browserLogins,
  help,
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
  if (page.recent && SidebarMockNavItem && workspace.slug === 'sidebar-mock')
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
          onIntent={() => void preloadPageCode(page, workspace.slug)}
        />
      </Suspense>
    );
  return <StandardNavItem page={page} />;
}

function StandardNavItem({ page }: { page: Page }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const { setOpenMobile } = useSidebar();
  const current = useCurrentPage().to;
  const active = current === page.to || (page === membersAndTeams && current === teams.to);
  const Icon = page.icon;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        icon={Icon && <Icon size="lg" aria-hidden="true" />}
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
            onPointerEnter={() => void preloadPageCode(page, workspace.slug)}
            onFocus={() => void preloadPageCode(page, workspace.slug)}
          />
        }
        onClick={() => setOpenMobile(false)}
      >
        {page.label}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** Inbox shows in the sidebar with its open count. */
function InboxNavItem({ workspaceId }: { workspaceId: string }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const { setOpenMobile } = useSidebar();
  const active = useCurrentPage() === inbox;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        icon={<InboxIcon size="lg" aria-hidden="true" />}
        tooltip={inbox.label}
        isActive={active}
        aria-current={active ? 'page' : undefined}
        badge={<InboxCount workspaceId={workspaceId} />}
        nativeButton={false}
        render={<Link to={inbox.to} params={{ workspaceSlug: workspace.slug }} preload={false} />}
        onClick={() => setOpenMobile(false)}
      >
        {inbox.label}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function MenuAvatar({ seed, name, image, size = 'md', shape = 'circle' }: ComponentProps<typeof EntityAvatar>) {
  return (
    <span
      aria-hidden="true"
      className="menu-avatar"
      style={{ '--menu-avatar-initial': JSON.stringify(name.trim().charAt(0).toUpperCase() || '?') } as CSSProperties}
    >
      <EntityAvatar seed={seed} name={name} image={image} size={size} shape={shape} />
    </span>
  );
}

function WorkspaceSwitchItems() {
  const { workspace, workspaces: choices } = workspaceRoute.useRouteContext();
  const { setOpenMobile } = useSidebar();
  const close = () => setOpenMobile(false);
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {choices.map(item => (
          <DropdownMenuItem
            key={item.slug}
            render={<Link to="/$workspaceSlug" params={{ workspaceSlug: item.slug }} />}
            onClick={close}
            aria-current={item.slug === workspace.slug ? 'true' : undefined}
          >
            <EntityAvatar seed={item.id} name={item.name} image={item.icon} size="sm" shape="square" />
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            {item.slug === workspace.slug && <CheckIcon size="sm" aria-hidden="true" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem render={<Link to="/create-workspace" />} onClick={close}>
          <AddIcon size="sm" aria-hidden="true" />
          Create workspace
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
    </>
  );
}

function WorkspaceMenuLinks() {
  const { workspace, membershipId } = workspaceRoute.useRouteContext();
  const { setOpenMobile } = useSidebar();
  const close = () => setOpenMobile(false);
  return (
    <DropdownMenuGroup>
      <DropdownMenuItem render={<Link to={settings.to} params={{ workspaceSlug: workspace.slug }} />} onClick={close}>
        <SettingsIcon size="sm" aria-hidden="true" />
        Workspace settings
      </DropdownMenuItem>
      {membershipId && workspace.status === 'ready' ? (
        <WorkspacePeopleMenuItem workspaceId={workspace.id} slug={workspace.slug} onSelect={close} />
      ) : (
        <DropdownMenuItem render={<Link to={teams.to} params={{ workspaceSlug: workspace.slug }} />} onClick={close}>
          <UsersIcon size="sm" aria-hidden="true" />
          Teams
        </DropdownMenuItem>
      )}
    </DropdownMenuGroup>
  );
}

function WorkspacePeopleMenuItem({
  workspaceId,
  slug,
  onSelect,
}: {
  workspaceId: string;
  slug: string;
  onSelect: () => void;
}) {
  const membership = useOwnMembership(workspaceId);
  const admin = membership.state.kind === 'ready' && membership.state.data.capabilities.manageGovernance;
  const target = admin ? membersAndTeams : teams;
  return (
    <DropdownMenuItem render={<Link to={target.to} params={{ workspaceSlug: slug }} />} onClick={onSelect}>
      <UsersIcon size="sm" aria-hidden="true" />
      {target.label}
    </DropdownMenuItem>
  );
}

function WorkspaceHeader() {
  const { workspace, sessionId, membershipId } = workspaceRoute.useRouteContext();
  const { setOpenMobile } = useSidebar();
  const [composingTask, setComposingTask] = useState(false);
  const closeTask = useCallback(() => setComposingTask(false), []);
  return (
    <div className="flex items-center gap-1">
      <div className="min-w-0 flex-1">
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`${workspace.name}, switch workspace`}
            render={
              <SidebarMenuButton
                tooltip={`${workspace.name} · Switch workspace`}
                icon={
                  <MenuAvatar
                    seed={workspace.id}
                    name={workspace.name}
                    image={workspace.icon}
                    size="sm"
                    shape="square"
                  />
                }
                badge={<ChevronDownIcon size="xs" aria-hidden="true" />}
              />
            }
          >
            {workspace.name}
          </DropdownMenuTrigger>
          <DropdownMenuContent size="menu" side="bottom" align="start">
            <WorkspaceSwitchItems />
            <WorkspaceMenuLinks />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex shrink-0 items-center [[data-sprout-sidebar][data-state=collapsed]_&]:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="secondary" size="icon-sm" aria-label="New" title="New" />}>
            <ComposeIcon size="md" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="end">
            <DropdownMenuItem
              render={<Link to="/$workspaceSlug" params={{ workspaceSlug: workspace.slug }} />}
              onClick={() => setOpenMobile(false)}
            >
              <ChatIcon size="sm" aria-hidden="true" />
              New chat
            </DropdownMenuItem>
            {membershipId && workspace.status === 'ready' && (
              <DropdownMenuItem
                onClick={() => {
                  setOpenMobile(false);
                  setComposingTask(true);
                }}
              >
                <TasksIcon size="sm" aria-hidden="true" />
                New task
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {composingTask && (
        <Suspense fallback={null}>
          <QuickTask workspace={{ id: workspace.id, slug: workspace.slug, sessionId }} close={closeTask} />
        </Suspense>
      )}
    </div>
  );
}

const themeOptions: { value: Theme; label: string; icon: typeof AddIcon }[] = [
  { value: 'system', label: 'System', icon: MonitorIcon },
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
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
        aria-label={`${name}, account menu`}
        render={
          <SidebarMenuButton
            tooltip="Account"
            icon={<MenuAvatar seed={user.id} name={name} image={user.image} size="sm" />}
            badge={<ChevronUpIcon size="xs" aria-hidden="true" />}
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
            <UserCircleIcon size="sm" aria-hidden="true" />
            Account settings
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          render={<Link to="/$workspaceSlug/help" params={{ workspaceSlug: workspace.slug }} />}
          onClick={() => setOpenMobile(false)}
        >
          <HelpCircleIcon size="sm" aria-hidden="true" />
          Help and support
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <MonitorIcon size="sm" aria-hidden="true" />
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
          <LogoutIcon size="sm" aria-hidden="true" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function useSettingsMode() {
  const current = useCurrentPage();
  return (
    current === account ||
    current === secrets ||
    current === browserLogins ||
    current === teams ||
    settingsPages.some(page => page.to === current.to)
  );
}

function SettingsNavigation({ backHref }: { backHref: string }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const navigate = useNavigate();
  const workspaceSettings = useWorkspaceSettings(workspace.id);
  const soulVisible =
    workspaceSettings.state.kind === 'ready' &&
    !workspaceSettings.state.error &&
    workspaceSettings.state.data.settings.canManage &&
    workspaceSettings.state.data.membership.role === 'admin';
  const capabilities = useSecretsCapabilities(workspace.id);
  const secretsVisible = capabilities.state.kind === 'ready' && capabilities.state.data.enabled;
  const { setOpenMobile } = useSidebar();
  const backLabel = `Back to ${workspace.name}`;
  return (
    <>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              nativeButton={false}
              render={<a href={backHref} />}
              icon={<ChevronLeftIcon size="md" aria-hidden="true" />}
              tooltip={backLabel}
              onClick={event => {
                setOpenMobile(false);
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                event.preventDefault();
                void navigate({ href: backHref });
              }}
            >
              {backLabel}
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
              {secretsVisible && <NavItem page={secrets} />}
              <NavItem page={browserLogins} />
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

function PeopleItems() {
  const { workspace, membershipId } = workspaceRoute.useRouteContext();
  if (!membershipId || workspace.status !== 'ready') return <StandardNavItem page={teams} />;
  return <AdminPeopleItem key={workspace.id} />;
}

function AdminPeopleItem() {
  const { workspace } = workspaceRoute.useRouteContext();
  const membership = useOwnMembership(workspace.id);
  const admin = membership.state.kind === 'ready' && membership.state.data.capabilities.manageGovernance;
  return <StandardNavItem page={admin ? membersAndTeams : teams} />;
}

// A collapsed sidebar stays collapsed on the next visit.
const navigationCookie = 'sidebar_state';
function savedNavigationOpen() {
  const saved = document.cookie
    .split('; ')
    .find(cookie => cookie.startsWith(`${navigationCookie}=`))
    ?.split('=')[1];
  return saved !== 'false';
}
function saveNavigationOpen(open: boolean) {
  document.cookie = `${navigationCookie}=${open}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
}

function WorkspaceNavigation({ onSearch, backHref }: { onSearch: () => void; backHref: string }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const { setOpenMobile } = useSidebar();
  const settingsMode = useSettingsMode();
  usePreloadSidebarCode(workspace.slug);
  return (
    <Sidebar collapsible="icon" label={settingsMode ? 'Settings' : workspace.name}>
      <>
        {settingsMode ? (
          <SettingsNavigation backHref={backHref} />
        ) : (
          <>
            <SidebarHeader>
              <SidebarMenu>
                <SidebarMenuItem>
                  <WorkspaceHeader />
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    icon={<SearchIcon size="lg" aria-hidden="true" />}
                    tooltip={`Search ${searchShortcutLabel}`}
                    // Leading space keeps "Search" and "Ctrl K" separate words for WCAG label-in-name checks.
                    badge={` ${searchShortcutLabel}`}
                    aria-keyshortcuts="Meta+K Control+K"
                    onClick={() => {
                      setOpenMobile(false);
                      onSearch();
                    }}
                  >
                    Search
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarHeader>
            <SidebarContent>
              <nav aria-label="Workspace navigation" data-record-links>
                <SidebarGroup>
                  <SidebarMenu>
                    <StandardNavItem page={chats} />
                    {workspace.status === 'ready' && <InboxNavItem workspaceId={workspace.id} />}
                    {workspace.status === 'ready' && <StandardNavItem page={tasks} />}
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
                {workspace.status === 'ready' && (
                  <SidebarRecents
                    label="Recent chats"
                    section="chat"
                    workspaceId={workspace.id}
                    slug={workspace.slug}
                  />
                )}
              </nav>
            </SidebarContent>
          </>
        )}
        <SidebarFooter>
          {!settingsMode && <SidebarSeparator />}
          <SidebarMenu>
            {!settingsMode && (
              <>
                <PeopleItems />
                <StandardNavItem page={settings} />
              </>
            )}
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

function WorkspaceSearchWithSecrets({
  open,
  onOpenChange,
  workspaceId,
  workspaceSlug,
  workspaceReady,
  onToggleSidebar,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceSlug: string;
  workspaceReady: boolean;
  onToggleSidebar: () => void;
}) {
  const capabilities = useSecretsCapabilities(workspaceId, workspaceReady);
  const secretsEnabled = capabilities.state.kind === 'ready' && capabilities.state.data.enabled;
  return (
    <WorkspaceSearchMount
      open={open}
      onOpenChange={onOpenChange}
      workspaceId={workspaceId}
      workspaceSlug={workspaceSlug}
      workspaceReady={workspaceReady}
      secretsEnabled={secretsEnabled}
      onToggleSidebar={onToggleSidebar}
    />
  );
}

function WorkspaceSearchMount({
  open,
  onOpenChange,
  workspaceId,
  workspaceSlug,
  workspaceReady,
  secretsEnabled,
  onToggleSidebar,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceSlug: string;
  workspaceReady: boolean;
  secretsEnabled: boolean;
  onToggleSidebar: () => void;
}) {
  const navigate = useNavigate();
  const visibleSearchPages = useMemo(
    () => searchPages.filter(page => page !== secrets || secretsEnabled),
    [secretsEnabled],
  );
  return (
    <Suspense fallback={null}>
      <SearchPalette
        open={open}
        onOpenChange={onOpenChange}
        workspaceId={workspaceId}
        workspaceReady={workspaceReady}
        pages={visibleSearchPages}
        onSelect={target => {
          switch (target.kind) {
            case 'page':
              void navigate({ to: target.to, params: { workspaceSlug } });
              break;
            case 'create-workspace':
              void navigate({ to: '/create-workspace' });
              break;
            case 'toggle-sidebar':
              onToggleSidebar();
              break;
            case 'chat':
              void navigate({
                to: '/$workspaceSlug/chat/$chatId',
                params: { workspaceSlug, chatId: target.chatId },
              });
              break;
            case 'agent':
              void navigate({
                to: '/$workspaceSlug/agents/$agentId',
                params: { workspaceSlug, agentId: target.agentId },
              });
              break;
            case 'table':
              void navigate({
                to: '/$workspaceSlug/tables/$tableId',
                params: { workspaceSlug, tableId: target.tableId },
              });
              break;
            case 'workflow':
              void navigate({
                to: '/$workspaceSlug/workflows/$workflowId',
                params: { workspaceSlug, workflowId: target.workflowId },
              });
              break;
            case 'app':
              void navigate({
                to: '/$workspaceSlug/apps/$appSlug',
                params: { workspaceSlug, appSlug: target.appSlug },
              });
              break;
            case 'file':
              void navigate({
                to: '/$workspaceSlug/files/$fileId',
                params: { workspaceSlug, fileId: target.fileId },
              });
              break;
          }
        }}
      />
    </Suspense>
  );
}

function WorkspaceShellContent() {
  const { user, workspace, workspaceStale, membershipId } = workspaceRoute.useRouteContext();
  const locationHref = useLocation({ select: location => location.href });
  const settingsMode = useSettingsMode();
  const [lastWorkspaceHref, setLastWorkspaceHref] = useState(`/${workspace.slug}`);
  useEffect(() => {
    setLastWorkspaceHref(`/${workspace.slug}`);
  }, [workspace.slug]);
  useEffect(() => {
    if (!settingsMode) setLastWorkspaceHref(locationHref);
  }, [locationHref, settingsMode]);
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
  const [navigationOpen, setNavigationOpen] = useState(savedNavigationOpen);
  const [calendarNavigationOpen, setCalendarNavigationOpen] = useState(false);
  useEffect(() => {
    if (onNewChat) document.title = 'New chat · TulipFarm';
  }, [onNewChat]);
  const [searchOpen, setSearchOpen] = useState(false);
  // The palette's code loads the first time it opens, then it stays mounted.
  const [searchUsed, setSearchUsed] = useState(false);
  if (searchOpen && !searchUsed) setSearchUsed(true);
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
  const toggleSidebar = useCallback(() => {
    if (onCalendar) {
      setCalendarNavigationOpen(open => !open);
    } else {
      setNavigationOpen(open => {
        const next = !open;
        saveNavigationOpen(next);
        return next;
      });
    }
  }, [onCalendar]);
  return (
    <TooltipProvider>
      {membershipId && workspace.status === 'ready' && (
        <RecordLinkPrefetch workspaceId={workspace.id} slug={workspace.slug} />
      )}
      <div className="workspace-viewport grid h-svh grid-rows-1 overflow-hidden">
        <a href="#workspace-main-content" className="skip-to-content">
          Skip to content
        </a>
        <SidebarProvider
          open={onCalendar ? calendarNavigationOpen : navigationOpen}
          onOpenChange={
            onCalendar
              ? setCalendarNavigationOpen
              : open => {
                  setNavigationOpen(open);
                  saveNavigationOpen(open);
                }
          }
        >
          <WorkspaceNavigation onSearch={() => setSearchOpen(true)} backHref={lastWorkspaceHref} />
          <main
            id="workspace-main-content"
            tabIndex={-1}
            className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background focus:outline-none"
          >
            {workspaceStale && <ReconnectBanner showMessage={!onIntegrations} />}
            {workspace.status === 'ready' && (
              <ReauthorizationBanner key={workspace.id} workspaceId={workspace.id} slug={workspace.slug} />
            )}
            {membershipId && workspace.status === 'ready' && (
              <CreditsBanner key={`credits-${workspace.id}`} workspaceId={workspace.id} slug={workspace.slug} />
            )}
            <header
              aria-label="Workspace header"
              className={`group/header @container flex h-(--sprout-bar-height) shrink-0 items-center gap-2 border-b px-3 ${onCalendar ? 'pointer-coarse:h-14' : ''}`}
            >
              <SidebarTrigger>
                <SidebarLeftIcon size="md" aria-hidden="true" />
              </SidebarTrigger>
              <div ref={setHeaderElement} className="flex min-w-0 flex-1 items-center gap-2" />
              <div ref={setActionsElement} className="flex shrink-0 items-center gap-2" />
              {membershipId && workspace.status === 'ready' && currentPage !== members && (
                <Suspense fallback={null}>
                  <InviteMembersPrompt
                    key={workspace.id}
                    userId={user.id}
                    workspaceId={workspace.id}
                    workspaceSlug={workspace.slug}
                  />
                </Suspense>
              )}
              {/* Under 20rem, or beside page actions on a phone, the page title needs the room; the navigation sheet still names the workspace. */}
              {!onCalendar && (
                <span
                  title={workspace.name}
                  className="max-w-24 truncate text-xs text-muted-foreground md:hidden @max-xs:hidden max-sm:group-has-data-[slot=page-actions]/header:hidden"
                >
                  {workspace.name}
                </span>
              )}
            </header>
            <PageChromeContext value={chrome}>
              <ChatHeaderContext value={headerElement}>
                {workspace.status === 'provisioning' ? (
                  <Suspense fallback={null}>
                    <WorkspaceSetup key={workspace.slug} name={workspace.name} slug={workspace.slug} />
                  </Suspense>
                ) : SidebarMockPage && workspace.slug === 'sidebar-mock' ? (
                  <Suspense fallback={<p role="status">Opening mock...</p>}>
                    <SidebarMockPage />
                  </Suspense>
                ) : (
                  <BudProvider key={workspace.id} headerActions={actionsElement}>
                    {/* Pages scroll here; full-height pages such as chat fill it and scroll their own panes. */}
                    <div
                      data-scroll-restoration-id={workspacePageScroller}
                      data-viewport-content=""
                      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
                    >
                      <Outlet />
                    </div>
                  </BudProvider>
                )}
              </ChatHeaderContext>
            </PageChromeContext>
          </main>
          {searchUsed &&
            (membershipId ? (
              <WorkspaceSearchWithSecrets
                open={searchOpen}
                onOpenChange={setSearchOpen}
                workspaceId={workspace.id}
                workspaceSlug={workspace.slug}
                workspaceReady={workspace.status === 'ready'}
                onToggleSidebar={toggleSidebar}
              />
            ) : (
              <WorkspaceSearchMount
                open={searchOpen}
                onOpenChange={setSearchOpen}
                workspaceId={workspace.id}
                workspaceSlug={workspace.slug}
                workspaceReady={false}
                secretsEnabled={false}
                onToggleSidebar={toggleSidebar}
              />
            ))}
        </SidebarProvider>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}

/** Inbox lists this person's waiting work; until the workspace is ready, a direct link points to where waiting work lives. */
export function InboxPage() {
  const { workspace } = workspaceRoute.useRouteContext();
  const params = { workspaceSlug: workspace.slug };
  if (workspace.status === 'ready')
    return (
      <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading Inbox…</p>}>
        <InboxList workspaceId={workspace.id} workspaceSlug={workspace.slug} />
      </Suspense>
    );
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
