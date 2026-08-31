import { Link, NavLink, useLocation, useNavigate, useNavigation } from "@remix-run/react";
import {
  ChevronsUpDown,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  UserRound,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  ChatActionsMenu,
  ChatCrumbTitle,
  ChatTitleInput,
  DeleteChatModal,
  useChatTitleActions,
} from "~/components/chat/chat-title-actions";
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
  iconForPath,
  type NavigationVisibility,
  titleForPath,
  visibleSettingsItem,
  visibleSidebarGroups,
} from "~/lib/nav";
import { isBusinessAdmin } from "~/lib/use-session-user";
import { cn } from "~/lib/utils";

const HEADER_ROW = "flex h-[52px] shrink-0 items-center";
const GROUP_HEADING =
  "px-3 pb-1 text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground";

/* One row shape for every destination, so a chat in Recent and a page in Build read as peers. */
/* The transparent border matches New chat's real one, so every icon lands on one vertical spine. */
const ROW_BASE =
  "flex min-h-9 items-center gap-2.5 rounded-md border border-transparent px-3 text-sm transition-colors duration-150";
const ROW_ACTIVE = "bg-sidebar-primary/12 font-medium text-sidebar-primary";
const ROW_IDLE = "text-sidebar-foreground hover:bg-sidebar-accent";
/* Shown for the row Remix is navigating to but whose loader hasn't resolved: isActive only flips
 * once the destination's data is in, so without this a click gives no feedback until it lands. */
const ROW_PENDING = "animate-pulse bg-sidebar-accent text-sidebar-foreground";
/* Collapsed, a row is a square so it matches the avatar chip below it rather than out-widing it. */
const ROW_NARROW = "size-9 shrink-0 justify-center px-0 mx-auto";

function SidebarHeader({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      className={cn(
        HEADER_ROW,
        "gap-2 border-b border-sidebar-border",
        collapsed ? "justify-center px-2" : "px-4"
      )}
    >
      <Link to="/" aria-label="TulipFarm home" className="flex min-w-0 items-center gap-2">
        <img src="/logo-128.png" alt="" width={24} height={24} className="size-6 shrink-0" />
        {collapsed ? null : (
          <span className="truncate text-sm font-semibold tracking-tight text-foreground">
            tulipfarm
          </span>
        )}
      </Link>
    </div>
  );
}

function NewChatButton({ collapsed, onNavigate }: { collapsed: boolean; onNavigate: () => void }) {
  const { pathname } = useLocation();
  const { startNewChat } = useConversations();
  const navigate = useNavigate();
  const button = (
    <button
      type="button"
      onClick={() => {
        startNewChat();
        navigate("/");
        onNavigate();
      }}
      aria-label="New chat"
      aria-current={pathname === "/" ? "page" : undefined}
      className={cn(
        "mt-3 flex min-h-9 items-center rounded-md border border-sidebar-border",
        "text-sm font-medium transition-colors duration-150",
        collapsed ? ROW_NARROW : "mx-2 gap-2.5 px-3",
        pathname === "/"
          ? "border-primary/50 bg-sidebar-accent text-sidebar-accent-foreground"
          : "bg-background hover:border-primary/50 hover:bg-sidebar-accent"
      )}
    >
      <Plus className="size-4 shrink-0 text-primary" aria-hidden />
      {collapsed ? null : "New chat"}
    </button>
  );
  return collapsed ? (
    <Tooltip content="New chat" placement="right">
      {button}
    </Tooltip>
  ) : (
    button
  );
}

/*
 * Collapsed, the label moves into a tooltip and the count shrinks to a dot on the icon: a number
 * that small is unreadable, but its presence is the part a reader is scanning for.
 */
function NavRow({
  to,
  label,
  icon: Icon,
  count,
  collapsed,
  onNavigate,
}: {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  count?: number;
  collapsed: boolean;
  onNavigate: () => void;
}) {
  const navigation = useNavigation();
  const isPending = navigation.state === "loading" && navigation.location.pathname.startsWith(to);
  const row = (
    <NavLink
      to={to}
      onClick={onNavigate}
      aria-label={collapsed ? (count ? `${label}, ${count} awaiting you` : label) : undefined}
      className={({ isActive }) =>
        cn(
          ROW_BASE,
          "group",
          collapsed && ROW_NARROW,
          isActive ? ROW_ACTIVE : isPending ? ROW_PENDING : ROW_IDLE
        )
      }
    >
      <span className="relative flex shrink-0 items-center">
        <Icon
          className="size-4 text-muted-foreground group-aria-[current=page]:text-sidebar-primary"
          aria-hidden
        />
        {collapsed && count ? (
          <span
            aria-hidden
            className="absolute -top-1 -right-1 size-2 rounded-full bg-status-danger"
          />
        ) : null}
      </span>
      {collapsed ? null : (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {count ? (
            <Badge variant="danger" aria-label={`${count} awaiting you`}>
              {count}
            </Badge>
          ) : null}
        </>
      )}
    </NavLink>
  );
  return collapsed ? (
    <Tooltip content={label} placement="right">
      {row}
    </Tooltip>
  ) : (
    row
  );
}

function RecentChats({ onNavigate }: { onNavigate: () => void }) {
  const { conversations, activeChatId } = useConversations();
  const actions = useChatTitleActions();
  if (conversations.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <Link to="/chats" onClick={onNavigate} className={cn(GROUP_HEADING, "hover:text-foreground")}>
        Recent
      </Link>
      {actions.error && !actions.pendingDelete ? (
        <p role="alert" className="px-3 py-1 text-xs text-destructive">
          {actions.error}
        </p>
      ) : null}
      {conversations.map((chat) =>
        actions.renamingId === chat.id ? (
          <div key={chat.id} className="px-1 py-0.5">
            <ChatTitleInput
              initialTitle={chat.title ?? ""}
              onSave={(next) => actions.submitRename(chat.id, next)}
              onCancel={actions.cancelRename}
              className="h-9 text-sm"
            />
          </div>
        ) : (
          <div
            key={chat.id}
            className={cn(ROW_BASE, "group pr-1", chat.id === activeChatId ? ROW_ACTIVE : ROW_IDLE)}
          >
            <Link
              to={`/chat/${chat.id}`}
              onClick={onNavigate}
              aria-current={chat.id === activeChatId ? "page" : undefined}
              className="min-w-0 flex-1 truncate"
            >
              {chat.title ?? "New chat"}
            </Link>
            <ChatActionsMenu
              onStartRename={() => actions.startRename(chat.id)}
              onDelete={() => actions.requestDelete(chat)}
            />
          </div>
        )
      )}
      <DeleteChatModal
        open={actions.pendingDelete !== null}
        onClose={actions.cancelDelete}
        onConfirm={actions.confirmDelete}
        title={actions.pendingDelete?.title ?? null}
        busy={actions.deleting}
        error={actions.error}
      />
    </div>
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

/*
 * The account menu is the only home left for sign-out and the theme now that the icon rail is
 * gone, so it opens upward from the card rather than living as loose icons in the nav.
 */
function UserCard({
  user,
  collapsed,
  onNavigate,
}: {
  user?: SessionUser;
  collapsed: boolean;
  onNavigate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!user) return null;
  const name = user.name?.trim() || user.email;
  // An account with no name is already identified by its email, so repeating it below the name
  // would print the same string twice.
  const secondary = name === user.email ? (isBusinessAdmin(user) ? "Admin" : null) : user.email;

  async function onSignOut() {
    setSigningOut(true);
    try {
      await logout();
    } finally {
      navigate("/login", { replace: true });
    }
  }

  return (
    <div ref={containerRef} className="relative border-t border-sidebar-border p-2">
      {open ? (
        <div
          id={menuId}
          className={cn(
            "absolute bottom-full mb-1 flex flex-col gap-0.5 rounded-md border border-border bg-popover p-1 shadow-lg",
            collapsed ? "left-2 w-56" : "left-2 right-2"
          )}
        >
          <Link
            to="/settings/profile"
            onClick={() => {
              setOpen(false);
              onNavigate();
            }}
            className={cn(ROW_BASE, ROW_IDLE)}
          >
            <UserRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            Profile
          </Link>
          <div className={cn(ROW_BASE, "text-muted-foreground")}>
            <ThemeToggle />
          </div>
          <Separator className="my-1" />
          <button
            type="button"
            onClick={onSignOut}
            disabled={signingOut}
            className={cn(ROW_BASE, ROW_IDLE, "w-full disabled:opacity-50")}
          >
            <LogOut className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            Sign out
          </button>
        </div>
      ) : null}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Account menu for ${name}`}
        className={cn(
          "flex w-full items-center rounded-md border border-transparent py-1.5 text-left",
          "transition-colors duration-150 hover:bg-sidebar-accent",
          collapsed ? "justify-center px-0" : "gap-2.5 px-3"
        )}
      >
        <span
          className={cn(
            "flex shrink-0 items-center justify-center rounded-md bg-secondary",
            "text-[0.625rem] font-semibold text-secondary-foreground",
            collapsed ? "size-9" : "size-8"
          )}
        >
          {initialsFor(user.name?.trim() || user.email)}
        </span>
        {collapsed ? null : (
          <>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium text-foreground">{name}</span>
              {secondary ? (
                <span className="truncate text-xs text-muted-foreground">{secondary}</span>
              ) : null}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </>
        )}
      </button>
    </div>
  );
}

export function AppSidebar({
  open = false,
  onClose = () => {},
  collapsed = false,
  user,
}: {
  open?: boolean;
  onClose?: () => void;
  collapsed?: boolean;
  user?: SessionUser;
} = {}) {
  const visibility: NavigationVisibility = {
    isDev: import.meta.env.DEV,
    visiblePaths: user?.navigation?.visiblePaths,
  };
  const groups = visibleSidebarGroups(visibility);
  const settingsItem = visibleSettingsItem(visibility);
  const { count } = useApprovals();
  const [persistent, setPersistent] = useState(true);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setPersistent(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  /* `inert` also removes hidden mobile nav links from the tab order. */
  const hidden = !persistent && !open;
  // Collapse is a desktop affordance: the mobile drawer has the whole screen and nothing to save.
  const narrow = collapsed && persistent;
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
          "fixed inset-y-0 left-0 z-50 flex h-full w-64 shrink-0 flex-col",
          "border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
          "transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
          narrow && "lg:w-14"
        )}
      >
        <SidebarHeader collapsed={narrow} />
        <NewChatButton collapsed={narrow} onNavigate={onClose} />
        <div className="min-h-0 flex-1 overflow-y-auto py-4">
          <nav aria-label="Main" className="flex flex-col gap-5 px-2">
            {groups.map((group, index) => (
              <div key={group.heading} className="flex flex-col gap-1">
                {narrow ? (
                  index > 0 ? (
                    <Separator className="mb-1 w-9 self-center" />
                  ) : null
                ) : (
                  <h2 className={GROUP_HEADING}>{group.heading}</h2>
                )}
                {group.items.map((item) => (
                  <NavRow
                    key={item.to}
                    to={item.to}
                    label={item.label}
                    icon={item.icon}
                    count={item.badge ? count : undefined}
                    collapsed={narrow}
                    onNavigate={onClose}
                  />
                ))}
              </div>
            ))}
            {narrow ? null : <RecentChats onNavigate={onClose} />}
          </nav>
        </div>
        {settingsItem ? (
          <div className="shrink-0 border-t border-sidebar-border px-2 py-2">
            <NavRow
              to={settingsItem.to}
              label={settingsItem.label}
              icon={settingsItem.icon}
              collapsed={narrow}
              onNavigate={onClose}
            />
          </div>
        ) : null}
        <UserCard user={user} collapsed={narrow} onNavigate={onClose} />
      </aside>
    </>
  );
}

/*
 * The flat sidebar already shows where a page sits, and `titleForPath` collapses detail routes onto
 * their section's name, so a parent crumb here could only ever repeat one of the two. The top bar
 * names the page and nothing else.
 */
function PageTitle({
  pathname,
  pageTitle,
  titleSlot,
}: {
  pathname: string;
  pageTitle: string;
  titleSlot?: ReactNode;
}) {
  const PageIcon = iconForPath(pathname);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <PageIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      {titleSlot ?? (
        <span aria-current="page" className="min-w-0 truncate text-sm font-medium text-foreground">
          {pageTitle}
        </span>
      )}
    </div>
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
  const { activeChatTitle, activeChatId } = useConversations();
  const isConversation = pathname === "/" || pathname.startsWith("/chat/");
  const pageTitle = isConversation
    ? (activeChatTitle ?? (pathname === "/" ? "New chat" : "Chat"))
    : titleForPath(pathname);
  // Only a persisted chat can be renamed or deleted; the new-chat surface has nothing to act on yet.
  const chatTitleSlot =
    isConversation && activeChatId ? (
      <ChatCrumbTitle key={activeChatId} chatId={activeChatId} title={activeChatTitle ?? null} />
    ) : undefined;

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
      localStorage.setItem("sidebar-collapsed", String(next));
      // Keep [data-sidebar] authoritative for the skeleton token and this component's own seed.
      document.documentElement.dataset.sidebar = next ? "collapsed" : "expanded";
      return next;
    });
  }

  return (
    <div className="flex h-svh overflow-hidden bg-background">
      <AppSidebar open={open} onClose={() => setOpen(false)} collapsed={collapsed} user={user} />
      <div className="flex h-svh min-w-0 flex-1 flex-col">
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
          <Tooltip content={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            <button
              type="button"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
              onClick={toggleCollapsed}
              className="hidden size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground lg:flex"
            >
              {collapsed ? (
                <PanelLeftOpen className="size-4" aria-hidden />
              ) : (
                <PanelLeftClose className="size-4" aria-hidden />
              )}
            </button>
          </Tooltip>
          <Separator orientation="vertical" className="mx-1 hidden h-5 lg:block" />
          <PageTitle pathname={pathname} pageTitle={pageTitle} titleSlot={chatTitleSlot} />
          <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
            <span className="sm:hidden">
              <CompanionMobileTrigger />
            </span>
            <ReportBugButton />
            <span className="flex items-center lg:hidden">
              <ThemeToggle iconOnly />
            </span>
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}

export { iconForPath, titleForPath };
