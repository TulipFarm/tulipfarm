import { Link, NavLink, useLocation, useNavigate } from "@remix-run/react";
import {
  ChevronRight,
  LogOut,
  type LucideIcon,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Plus,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { KnowledgeTree } from "~/components/knowledge/space-tree";
import { CompanionMobileTrigger } from "~/components/onboarding/companion";
import { ReportBugButton } from "~/components/report-bug-button";
import { ThemeToggle } from "~/components/theme-toggle";
import { Badge } from "~/components/ui/badge";
import { Separator } from "~/components/ui/separator";
import { Tooltip } from "~/components/ui/tooltip";
import { logout, type SessionUser } from "~/lib/api";
import { useApprovals } from "~/lib/approvals-context";
import { useConversations } from "~/lib/conversations-context";
import {
  destinationForMode,
  hasContextPanel,
  iconForPath,
  MODE_META,
  type NavigationVisibility,
  type ProductMode as NavProductMode,
  modeForPath as navModeForPath,
  PRIMARY_MODES,
  titleForPath,
  visibleModes,
  visibleSections,
} from "~/lib/nav";
import { isBusinessAdmin } from "~/lib/use-session-user";
import { cn } from "~/lib/utils";

type ProductMode = NavProductMode;

const HEADER_ROW = "flex h-[52px] shrink-0 items-center";

function modeForPath(pathname: string): ProductMode {
  return navModeForPath(pathname);
}

function Logo() {
  return <img src="/logo-128.png" alt="tulipfarm" width={28} height={28} className="size-7" />;
}

function SignOutButton({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  async function onClick() {
    setBusy(true);
    try {
      await logout();
    } finally {
      navigate("/login", { replace: true });
    }
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label="Sign out"
      className={cn(
        "flex min-h-9 items-center gap-2 rounded-md text-muted-foreground transition-colors duration-150",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:opacity-50",
        compact ? "size-10 justify-center" : "w-full px-3 text-sm"
      )}
    >
      <LogOut className="size-4" aria-hidden />
      {compact ? null : <span>Sign out</span>}
    </button>
  );
}

/*
 * The selected mode carries both a filled surface and a coral edge marker so selection never
 * depends on color alone, and the shared Tooltip replaces the native `title` delay for these
 * icon-only targets.
 */
function RailLink({ mode, active, to }: { mode: ProductMode; active: boolean; to: string }) {
  const { label, icon: Icon } = MODE_META[mode];
  return (
    <Tooltip content={label}>
      <Link
        to={to}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        className={cn(
          "relative flex size-10 items-center justify-center rounded-md text-muted-foreground",
          "transition-colors duration-150 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          active && "bg-sidebar-accent text-primary"
        )}
      >
        {active ? (
          <span className="absolute -left-2 h-5 w-0.5 rounded-r-full bg-primary" aria-hidden />
        ) : null}
        <Icon className="size-5" aria-hidden />
      </Link>
    </Tooltip>
  );
}

function Rail({
  mode,
  modes,
  visibility,
}: {
  mode: ProductMode;
  modes: readonly ProductMode[];
  visibility: NavigationVisibility;
}) {
  return (
    <div className="flex w-14 shrink-0 flex-col items-center border-r border-sidebar-border bg-background">
      <div className={cn(HEADER_ROW, "w-full justify-center border-b border-sidebar-border")}>
        <Link to="/" aria-label="TulipFarm home" className="rounded-md p-1.5">
          <Logo />
        </Link>
      </div>
      <nav aria-label="Product modes" className="flex flex-1 flex-col items-center gap-1 py-3">
        {PRIMARY_MODES.filter((item) => modes.includes(item)).map((item) => (
          <RailLink
            key={item}
            mode={item}
            to={destinationForMode(item, visibility)}
            active={mode === item}
          />
        ))}
      </nav>
      <div className="flex flex-col items-center gap-1 pb-3">
        <Separator className="mb-2 w-6" />
        {modes.includes("farm") ? (
          <RailLink
            mode="farm"
            to={destinationForMode("farm", visibility)}
            active={mode === "farm"}
          />
        ) : null}
        {modes.includes("settings") ? (
          <RailLink
            mode="settings"
            to={destinationForMode("settings", visibility)}
            active={mode === "settings"}
          />
        ) : null}
        <span className="flex size-10 items-center justify-center">
          <ThemeToggle iconOnly />
        </span>
        <SignOutButton compact />
      </div>
    </div>
  );
}

function ContextLink({
  to,
  label,
  icon: Icon,
  count,
  onNavigate,
}: {
  to: string;
  label: string;
  icon: LucideIcon;
  count?: number;
  onNavigate: () => void;
}) {
  return (
    <NavLink
      to={to}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "flex min-h-9 items-center gap-2 rounded-md px-3 text-sm transition-colors duration-150",
          isActive
            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-accent/60"
        )
      }
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count ? <Badge variant="info">{count}</Badge> : null}
    </NavLink>
  );
}

function ChatContext({ onNavigate }: { onNavigate: () => void }) {
  const { conversations, activeChatId, startNewChat } = useConversations();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <button
        type="button"
        onClick={() => {
          startNewChat();
          onNavigate();
        }}
        className="mx-3 mb-5 flex min-h-10 items-center gap-2 rounded-md border border-sidebar-border bg-background px-3 text-sm font-medium transition-colors duration-150 hover:border-primary/50 hover:bg-sidebar-accent"
      >
        <Plus className="size-4 text-primary" aria-hidden />
        New chat
      </button>
      <div className="mb-2 px-5">
        <Link
          to="/chats"
          onClick={onNavigate}
          className="text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          Recent chats
        </Link>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {conversations.length > 0 ? (
          conversations.map((chat) => (
            <Link
              key={chat.id}
              to={`/chat/${chat.id}`}
              onClick={onNavigate}
              aria-current={chat.id === activeChatId ? "page" : undefined}
              className={cn(
                "block truncate rounded-md px-3 py-2 text-sm transition-colors duration-150",
                chat.id === activeChatId
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/60"
              )}
            >
              {chat.title ?? "New chat"}
            </Link>
          ))
        ) : (
          <p className="px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            Your chats will appear here.
          </p>
        )}
      </div>
    </div>
  );
}

function LinkList({
  mode,
  onNavigate,
  visibility,
}: {
  mode: "build" | "operate" | "settings";
  onNavigate: () => void;
  visibility: NavigationVisibility;
}) {
  const { count } = useApprovals();
  const sections = visibleSections(mode, visibility);
  return (
    <nav aria-label={`${mode} navigation`} className="flex flex-col gap-5 px-2">
      {sections.map((section, index) => (
        <div key={section.heading ?? `section-${index}`} className="flex flex-col gap-1">
          {section.heading ? (
            <h3 className="px-3 pb-1 text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {section.heading}
            </h3>
          ) : null}
          {section.items.map((item) => (
            <ContextLink
              key={item.to}
              to={item.to}
              label={item.label}
              icon={item.icon}
              count={item.badge ? count : undefined}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}

function ContextPanel({
  mode,
  onNavigate,
  visibility,
}: {
  mode: ProductMode;
  onNavigate: () => void;
  visibility: NavigationVisibility;
}) {
  const { label, icon: Icon } = MODE_META[mode];
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-sidebar text-sidebar-foreground">
      <div className={cn(HEADER_ROW, "gap-2 border-b border-sidebar-border px-4")}>
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{label}</h2>
        {mode === "knowledge" &&
        (visibility.visiblePaths === undefined ||
          visibility.visiblePaths.includes("/knowledge")) ? (
          <Tooltip content="New space">
            <Link
              to="/knowledge/spaces/new"
              onClick={onNavigate}
              aria-label="New space"
              className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <Plus className="size-4" aria-hidden />
            </Link>
          </Tooltip>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-3">
        {mode === "chat" ? <ChatContext onNavigate={onNavigate} /> : null}
        {mode === "knowledge" ? (
          <>
            {visibility.visiblePaths === undefined ||
            visibility.visiblePaths.includes("/knowledge/files") ? (
              <nav aria-label="knowledge navigation" className="flex flex-col gap-1 px-2 pb-3">
                <ContextLink
                  to="/knowledge/files"
                  label="Files"
                  icon={Paperclip}
                  onNavigate={onNavigate}
                />
              </nav>
            ) : null}
            <KnowledgeTree />
          </>
        ) : null}
        {mode === "build" || mode === "operate" || mode === "settings" ? (
          <LinkList mode={mode} onNavigate={onNavigate} visibility={visibility} />
        ) : null}
      </div>
    </div>
  );
}

export function AppSidebar({
  open = false,
  onClose = () => {},
  collapsed = false,
  navigation,
}: {
  open?: boolean;
  onClose?: () => void;
  collapsed?: boolean;
  navigation?: SessionUser["navigation"];
} = {}) {
  const { pathname } = useLocation();
  const mode = modeForPath(pathname);
  const visibility = { isDev: import.meta.env.DEV, visiblePaths: navigation?.visiblePaths };
  const modes = visibleModes(visibility);
  const showContext = hasContextPanel(mode) && modes.includes(mode);
  const [persistent, setPersistent] = useState(true);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const update = () => setPersistent(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  /* `inert` also removes hidden mobile nav links from the tab order. */
  const hidden = !persistent && !open;
  return (
    <>
      {open ? (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-40 bg-foreground/40 lg:hidden"
          onClick={onClose}
        />
      ) : null}
      <aside
        aria-label="Application navigation"
        inert={hidden}
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex h-full border-r border-sidebar-border transition-transform duration-200",
          "lg:static lg:z-auto lg:translate-x-0",
          showContext ? "w-[312px]" : "w-14",
          open ? "translate-x-0" : "-translate-x-full md:static md:w-14 md:translate-x-0",
          showContext && !collapsed && "lg:w-[312px]",
          (collapsed || !showContext) && "lg:w-14"
        )}
      >
        <Rail mode={mode} modes={modes} visibility={visibility} />
        {showContext ? (
          <div
            className={cn(
              "h-full min-w-0 flex-1",
              !open && "hidden lg:block",
              collapsed && "lg:hidden"
            )}
          >
            <ContextPanel mode={mode} onNavigate={onClose} visibility={visibility} />
          </div>
        ) : null}
      </aside>
    </>
  );
}

function initialsFor(identity: string): string {
  const local = identity.includes("@") ? (identity.split("@")[0] ?? identity) : identity;
  const words = local.split(/[\s._+-]+/).filter(Boolean);
  const initials =
    words.length > 1
      ? words
          .slice(0, 2)
          .map((word) => word.slice(0, 1))
          .join("")
      : local.slice(0, 2);
  return initials.toUpperCase() || "?";
}

function AccountChip({ user }: { user?: SessionUser }) {
  if (!user) return null;
  const name = user.name?.trim() || user.email;
  return (
    <Tooltip content={isBusinessAdmin(user) ? `${name} (Admin)` : name}>
      <Link
        to="/settings/profile"
        aria-label={`Account settings for ${name}`}
        className="flex size-8 items-center justify-center rounded-md bg-secondary text-[0.625rem] font-semibold text-secondary-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
      >
        {initialsFor(user.name?.trim() || user.email)}
      </Link>
    </Tooltip>
  );
}

/*
 * The parent crumb only earns its place when it points somewhere else and says something else,
 * so the trail never repeats the page or links to it.
 */
function Breadcrumb({
  pathname,
  pageTitle,
  visibility,
}: {
  pathname: string;
  pageTitle: string;
  visibility: NavigationVisibility;
}) {
  const mode = modeForPath(pathname);
  const parent = { ...MODE_META[mode], to: destinationForMode(mode, visibility) };
  const PageIcon = iconForPath(pathname);
  const showParent = mode !== "chat" && parent.to !== pathname && parent.label !== pageTitle;
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center">
      <ol className="flex min-w-0 items-center gap-2">
        {showParent ? (
          <li className="hidden shrink-0 items-center gap-2 sm:flex">
            <Link
              to={parent.to}
              className="text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground"
            >
              {parent.label}
            </Link>
            <ChevronRight className="size-3.5 text-muted-foreground/60" aria-hidden />
          </li>
        ) : null}
        <li className="flex min-w-0 items-center gap-2">
          <PageIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span
            aria-current="page"
            className="min-w-0 truncate text-sm font-medium text-foreground"
          >
            {pageTitle}
          </span>
        </li>
      </ol>
    </nav>
  );
}

export function AppShell({ children, user }: { children: ReactNode; user?: SessionUser }) {
  const [open, setOpen] = useState(false);
  // Seeded from the [data-sidebar] the pre-hydration script in root.tsx already resolved, so the
  // real shell adopts the persisted width on its first render — matching the HydrateFallback
  // skeleton instead of rendering expanded and snapping to collapsed in an effect.
  const [collapsed, setCollapsed] = useState(
    () => document.documentElement.dataset.sidebar === "collapsed"
  );
  const { pathname } = useLocation();
  const openerRef = useRef<HTMLButtonElement>(null);
  const { activeChatTitle } = useConversations();
  const isConversation = pathname === "/" || pathname.startsWith("/chat/");
  const currentMode = modeForPath(pathname);
  const visibility = { isDev: import.meta.env.DEV, visiblePaths: user?.navigation?.visiblePaths };
  const modes = visibleModes(visibility);
  const pageTitle = isConversation
    ? (activeChatTitle ?? (pathname === "/" ? "New chat" : "Chat"))
    : titleForPath(pathname);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        queueMicrotask(() => openerRef.current?.focus());
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      localStorage.setItem("context-sidebar-collapsed", String(next));
      // Keep [data-sidebar] authoritative for the skeleton token and this component's own seed.
      document.documentElement.dataset.sidebar = next ? "collapsed" : "expanded";
      return next;
    });
  }

  return (
    <div className="flex min-h-svh bg-background lg:h-svh lg:overflow-hidden">
      <AppSidebar
        open={open}
        onClose={() => setOpen(false)}
        collapsed={collapsed}
        navigation={user?.navigation}
      />
      <div className="flex min-w-0 flex-1 flex-col lg:h-svh">
        <header
          className={cn(HEADER_ROW, "gap-2 border-b border-border bg-background px-3 sm:px-4")}
        >
          <button
            ref={openerRef}
            type="button"
            aria-label="Open navigation"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className="flex size-10 shrink-0 items-center justify-center rounded-md transition-colors duration-150 hover:bg-accent lg:hidden"
          >
            <Menu className="size-5" aria-hidden />
          </button>
          <span className="hidden shrink-0 lg:flex">
            {hasContextPanel(currentMode) && modes.includes(currentMode) ? (
              <Tooltip content={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
                <button
                  type="button"
                  aria-label={collapsed ? "Expand context sidebar" : "Collapse context sidebar"}
                  onClick={toggleCollapsed}
                  className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
                >
                  {collapsed ? (
                    <PanelLeftOpen className="size-4" aria-hidden />
                  ) : (
                    <PanelLeftClose className="size-4" aria-hidden />
                  )}
                </button>
              </Tooltip>
            ) : null}
          </span>
          <Separator orientation="vertical" className="mx-1 hidden h-5 lg:block" />
          <Breadcrumb pathname={pathname} pageTitle={pageTitle} visibility={visibility} />
          <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
            <span className="sm:hidden">
              <CompanionMobileTrigger />
            </span>
            <AccountChip user={user} />
            <ReportBugButton />
            <span className="flex items-center lg:hidden">
              <ThemeToggle iconOnly />
            </span>
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="min-h-0 min-w-0 flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

export { iconForPath, modeForPath, titleForPath };
