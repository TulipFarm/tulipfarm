import { useLocation, useNavigate, useNavigation } from "@remix-run/react";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import {
  ChatActionsMenu,
  ChatCrumbTitle,
  ChatTitleInput,
  DeleteChatModal,
  useChatTitleActions,
} from "~/components/chat/chat-title-actions";
import {
  ArrowLeft,
  ChevronDown,
  ChevronsUpDown,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  UserRound,
} from "~/components/icons";
import { CompanionMobileTrigger } from "~/components/onboarding/companion";
import { ReportBugButton } from "~/components/report-bug-button";
import { SidebarCommand } from "~/components/sidebar-command";
import { ThemeToggle } from "~/components/theme-toggle";
import { Avatar } from "~/components/ui/avatar";
import { Input } from "~/components/ui/input";
import { Link, NavLink } from "~/components/ui/link";
import { Separator } from "~/components/ui/separator";
import { Tooltip } from "~/components/ui/tooltip";
import { logout, type SessionUser } from "~/lib/api";
import { useApprovals } from "~/lib/approvals-context";
import { useConversations } from "~/lib/conversations-context";
import {
  iconForPath,
  isSettingsPath,
  type NavGroup,
  type NavigationVisibility,
  titleForPath,
  visibleFarmItem,
  visibleSettingsGroups,
  visibleSettingsItem,
  visibleSidebarGroups,
} from "~/lib/nav";
import { usePageChromeTitle, useSetActionSlot } from "~/lib/page-chrome-context";
import { type SidebarCounts, useSidebarCounts } from "~/lib/sidebar-counts";
import { isBusinessAdmin } from "~/lib/use-session-user";
import { cn } from "~/lib/utils";

/**
 * The height the app header and the sidebar's own header share, so the two line up across the
 * seam between them. 40px leaves 6px of air around a 28px control, so the chrome reads as an edge
 * of the frame rather than a band laid on the page.
 */
const HEADER_ROW = "flex h-10 shrink-0 items-center";
/**
 * A nav group's label. Sentence case at body-adjacent size, not the old micro-label
 * treatment it replaced: shouting a word the reader is not meant to act on is the clearest case
 * of chrome competing for attention it has not earned. The disclosure caret beside it already
 * says the group is a group.
 */
const GROUP_HEADING = "text-xs font-medium text-muted-foreground";

/* One row shape for every destination, so a chat in Recent and a page in Build read as peers. */
/* The transparent border matches New chat's real one, so every icon lands on one vertical spine. */
const ROW_BASE =
  "flex min-h-7 items-center gap-2 rounded-md border border-transparent px-2 text-sm transition-colors [&_svg:not([class*='size-'])]:size-3.5";
/* Ruby marks the current row as *ink*, not as a filled band: a saturated ground down the side
 * of every screen is the loudest thing in the app, and it reads as an alert rather than as
 * "you are here". The ground stays neutral and does the same job one step quieter. */
/**
 * The row you are on. A raised ground and full-strength ink, not a coloured one.
 *
 * This was brand ruby text, and ruby text on a quiet neutral sidebar was the loudest thing on the
 * screen — the current row was shouting a fact the reader already knew, which is the clearest case
 * of chrome competing for attention it has not earned. Ruby is still the accent, but it earns its
 * place on focus rings and links, where it marks something the reader can act on rather than
 * something already true.
 */
const ROW_ACTIVE = "bg-sidebar-accent font-medium text-sidebar-accent-foreground";
const ROW_IDLE = "text-sidebar-foreground hover:bg-sidebar-accent";
/* Shown for the row Remix is navigating to but whose loader hasn't resolved: isActive only flips
 * once the destination's data is in, so without this a click gives no feedback until it lands. */
const ROW_PENDING = "animate-pulse bg-sidebar-accent text-sidebar-foreground";
/* Collapsed, a row is a square so it matches the avatar chip below it rather than out-widing it. */
const ROW_NARROW = "size-7 shrink-0 justify-center px-0 mx-auto";
/* Trailing controls appear on hover or keyboard focus, and stay put on the row you are on. */
const ROW_AFFORDANCE =
  "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-border hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100";

/**
 * Remembers which groups a reader closed. A closed group is a preference, not a permission, so it
 * is stored per browser and never travels with the account.
 */
function useGroupOpen(key: string): [boolean, () => void] {
  const storageKey = `sidebar-group:${key}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(storageKey) !== "closed";
    } catch {
      return true;
    }
  });
  const toggle = useCallback(() => {
    setOpen((current) => {
      const next = !current;
      try {
        localStorage.setItem(storageKey, next ? "open" : "closed");
      } catch {
        /* A browser refusing storage costs the memory of the choice, never the choice. */
      }
      return next;
    });
  }, [storageKey]);
  return [open, toggle];
}

/**
 * A heading that is also its own disclosure. The `h2` stays a heading so the section is still
 * announced and reachable by heading navigation; the button inside it carries the state.
 *
 * `to` splits the chevron off into its own control, for the one group whose name is also a
 * destination — a label that both navigates and collapses can only do one of them per click.
 */
/** Every group heading is the disclosure — a reader who clicks the word expects the word to obey. */
function GroupHeading({
  heading,
  open,
  onToggle,
}: {
  heading: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-0.5 pr-1 pl-1.5">
      <h2 className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className={cn(
            GROUP_HEADING,
            "flex w-full items-center gap-1 rounded py-1 text-left transition-colors hover:text-foreground"
          )}
        >
          <ChevronDown
            className={cn(
              "size-3 shrink-0 transition-transform duration-100",
              open ? "" : "-rotate-90"
            )}
            aria-hidden
          />
          <span className="min-w-0 truncate">{heading}</span>
        </button>
      </h2>
    </div>
  );
}

function SidebarHeader({
  collapsed,
  visibility,
  onNavigate,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  visibility: NavigationVisibility;
  onNavigate: () => void;
  onToggleCollapsed: () => void;
}) {
  return (
    <div className={cn(HEADER_ROW, "gap-1", collapsed ? "justify-center px-2" : "px-4")}>
      <Link
        to="/"
        aria-label="TulipFarm home"
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 rounded-md transition-colors",
          collapsed ? "justify-center" : "px-1 py-1 hover:bg-sidebar-accent"
        )}
      >
        <img src="/logo-128.png" alt="" width={20} height={20} className="size-5 shrink-0" />
        {collapsed ? null : (
          <span className="truncate text-sm font-semibold tracking-tight text-foreground">
            tulipfarm
          </span>
        )}
      </Link>
      {collapsed ? null : (
        <>
          <SidebarCommand visibility={visibility} collapsed={false} compact />
          <NewChatButton collapsed={false} compact onNavigate={onNavigate} />
          <Tooltip content="Collapse sidebar">
            <button
              type="button"
              aria-label="Collapse sidebar"
              aria-expanded
              onClick={onToggleCollapsed}
              className="hidden size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground lg:flex"
            >
              <PanelLeftClose className="size-4" aria-hidden />
            </button>
          </Tooltip>
        </>
      )}
    </div>
  );
}

function SettingsSidebarHeader({ onNavigate }: { onNavigate: () => void }) {
  return (
    <div className={cn(HEADER_ROW, "px-3")}>
      <Link
        to="/"
        onClick={onNavigate}
        className="flex min-h-7 items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Back to app
      </Link>
    </div>
  );
}

function NewChatButton({
  collapsed,
  compact = false,
  onNavigate,
}: {
  collapsed: boolean;
  compact?: boolean;
  onNavigate: () => void;
}) {
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
        "mt-0 flex min-h-7 items-center rounded-md border border-sidebar-border",
        "text-sm font-medium transition-colors",
        collapsed
          ? ROW_NARROW
          : compact
            ? "size-7 shrink-0 justify-center border-transparent px-0"
            : "mx-2 gap-2.5 px-3",
        pathname === "/"
          ? compact
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "border-primary/50 bg-sidebar-accent text-sidebar-accent-foreground"
          : compact
            ? "bg-transparent hover:bg-sidebar-accent"
            : "bg-background hover:border-primary/50 hover:bg-sidebar-accent"
      )}
    >
      <Plus className="size-4 shrink-0 text-primary" aria-hidden />
      {collapsed || compact ? null : "New chat"}
    </button>
  );
  return collapsed || compact ? (
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
  tone = "quiet",
  create,
  collapsed,
  onNavigate,
}: {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  count?: number;
  /** `alert` is something waiting on the reader; `quiet` is just how much is in there. */
  tone?: "alert" | "quiet";
  create?: { to: string; label: string };
  collapsed: boolean;
  onNavigate: () => void;
}) {
  const navigation = useNavigation();
  const isPending = navigation.state === "loading" && navigation.location.pathname.startsWith(to);
  const alerting = tone === "alert" && Boolean(count);
  const row = (
    <NavLink
      to={to}
      onClick={onNavigate}
      aria-label={collapsed ? (alerting ? `${label}, ${count} awaiting you` : label) : undefined}
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
          className="size-4 text-sidebar-foreground group-aria-[current=page]:text-sidebar-primary"
          aria-hidden
        />
        {collapsed && alerting ? (
          <span
            aria-hidden
            className="absolute -top-1 -right-1 size-2 rounded-full bg-status-danger"
          />
        ) : null}
      </span>
      {collapsed ? null : (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {/* A count reads as a bare numeral, not a pill: the row is already the alarm, and a
           * section total is furniture. Only the alarm earns the rule beneath it. */}
          {count ? (
            <span
              data-sidebar-count
              className={cn(
                "ms-auto w-5 shrink-0 text-right text-xs leading-none tabular-nums transition-opacity",
                create && "group-hover/row:opacity-0 group-focus-within/row:opacity-0",
                alerting
                  ? "text-status-danger underline decoration-status-danger/40 underline-offset-4"
                  : "text-muted-foreground/70"
              )}
            >
              {count}
            </span>
          ) : null}
          {alerting ? <span className="sr-only">awaiting you</span> : null}
        </>
      )}
    </NavLink>
  );
  if (collapsed) {
    return (
      <Tooltip content={label} placement="right">
        {row}
      </Tooltip>
    );
  }
  if (!create) return row;
  /* The Tooltip renders an in-flow wrapper around whatever it observes, so the absolute
   * positioning has to sit outside it — on the Tooltip itself the `+` would still take a row's
   * worth of height and push the next destination down. */
  return (
    <div className="group/row relative">
      {row}
      <span className="absolute top-1/2 right-2 -translate-y-1/2">
        <Tooltip content={create.label} placement="right">
          <Link
            to={create.to}
            onClick={onNavigate}
            aria-label={create.label}
            className={ROW_AFFORDANCE}
          >
            <Plus className="size-3.5" aria-hidden />
          </Link>
        </Tooltip>
      </span>
    </div>
  );
}

function RecentChats({ onNavigate }: { onNavigate: () => void }) {
  const { conversations, activeChatId } = useConversations();
  const actions = useChatTitleActions();
  const [open, toggle] = useGroupOpen("recent");
  if (conversations.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <GroupHeading heading="Recent" open={open} onToggle={toggle} />
      {open ? (
        <>
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
                  className="h-7 text-sm"
                />
              </div>
            ) : (
              <div
                key={chat.id}
                className={cn(
                  ROW_BASE,
                  "group relative pr-8",
                  chat.id === activeChatId ? ROW_ACTIVE : ROW_IDLE
                )}
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
                  compact
                  triggerClassName="absolute top-1/2 right-0.5 -translate-y-1/2"
                />
              </div>
            )
          )}
        </>
      ) : null}
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
    <div ref={containerRef} className="relative p-2">
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
          <ThemeToggle className={cn(ROW_BASE, ROW_IDLE, "w-full")} />
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
          "transition-colors hover:bg-sidebar-accent",
          collapsed ? "justify-center px-0" : "gap-2.5 px-3"
        )}
      >
        <Avatar
          identity={user.name?.trim() || user.email}
          className={cn("text-[0.625rem]", collapsed ? "size-9" : "size-8")}
        />
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

/**
 * One heading and its rows. Collapsed to the icon column the disclosure disappears entirely —
 * a group you cannot read the name of is not one you can meaningfully close.
 */
function NavGroupSection({
  group,
  approvals,
  totals,
  chatCount,
  narrow,
  isFirst,
  onNavigate,
}: {
  group: NavGroup;
  approvals: number;
  totals: SidebarCounts;
  chatCount: number;
  narrow: boolean;
  isFirst: boolean;
  onNavigate: () => void;
}) {
  const [open, toggle] = useGroupOpen(group.heading);
  const showRows = narrow || open;
  return (
    <div className="flex flex-col gap-1">
      {narrow ? (
        isFirst ? null : (
          <Separator className="mb-1 w-9 self-center" />
        )
      ) : (
        <GroupHeading heading={group.heading} open={open} onToggle={toggle} />
      )}
      {showRows
        ? group.items.map((item) => {
            const alerting = Boolean(item.badge) && approvals > 0;
            const quiet = item.to === "/chats" ? chatCount : totals[item.to];
            return (
              <NavRow
                key={item.to}
                to={item.to}
                label={item.label}
                icon={item.icon}
                count={alerting ? approvals : quiet}
                tone={alerting ? "alert" : "quiet"}
                create={item.create}
                collapsed={narrow}
                onNavigate={onNavigate}
              />
            );
          })
        : null}
    </div>
  );
}

function SettingsNavigation({
  groups,
  onNavigate,
}: {
  groups: NavGroup[];
  onNavigate: () => void;
}) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const filtered = groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        `${item.label} ${item.description ?? ""}`.toLowerCase().includes(normalized)
      ),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <>
      <div className="px-3 pb-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search settings"
            placeholder="Search settings"
            className="h-7 border-sidebar-border bg-sidebar pl-8 text-sm"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        <nav aria-label="Settings" className="flex flex-col gap-5 px-3">
          {filtered.map((group) => (
            <section key={group.heading} className="flex flex-col gap-1">
              <h2 className="px-2 py-1 text-xs font-medium text-muted-foreground">
                {group.heading}
              </h2>
              {group.items.map((item) => (
                <NavRow
                  key={item.to}
                  to={item.to}
                  label={item.label}
                  icon={item.icon}
                  collapsed={false}
                  onNavigate={onNavigate}
                />
              ))}
            </section>
          ))}
          {filtered.length === 0 ? (
            <p className="px-2 text-xs text-muted-foreground">No settings match “{query}”.</p>
          ) : null}
        </nav>
      </div>
    </>
  );
}

export function AppSidebar({
  open = false,
  onClose = () => {},
  collapsed = false,
  onToggleCollapsed = () => {},
  user,
}: {
  open?: boolean;
  onClose?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  user?: SessionUser;
} = {}) {
  const visibility: NavigationVisibility = {
    isDev: import.meta.env.DEV,
    visiblePaths: user?.navigation?.visiblePaths,
  };
  const groups = visibleSidebarGroups(visibility);
  const settingsGroups = visibleSettingsGroups(visibility);
  const farmItem = visibleFarmItem(visibility);
  const settingsItem = visibleSettingsItem(visibility);
  const { count } = useApprovals();
  const { conversations } = useConversations();
  const totals = useSidebarCounts(user?.navigation?.visiblePaths);
  const [persistent, setPersistent] = useState(true);
  const { pathname } = useLocation();
  const settingsMode = isSettingsPath(pathname);

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
  const narrow = collapsed && persistent && !settingsMode;
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
          "fixed inset-y-0 left-0 z-50 flex h-full w-62 shrink-0 flex-col",
          "bg-sidebar text-sidebar-foreground",
          "transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
          narrow && "lg:w-14"
        )}
      >
        {settingsMode ? (
          <SettingsSidebarHeader onNavigate={onClose} />
        ) : (
          <SidebarHeader
            collapsed={narrow}
            visibility={visibility}
            onNavigate={onClose}
            onToggleCollapsed={onToggleCollapsed}
          />
        )}
        {narrow && !settingsMode ? (
          <div className="flex shrink-0 flex-col gap-1 py-2">
            <SidebarCommand visibility={visibility} collapsed />
            <NewChatButton collapsed onNavigate={onClose} />
          </div>
        ) : null}
        {settingsMode ? (
          <SettingsNavigation groups={settingsGroups} onNavigate={onClose} />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto py-3">
            <nav aria-label="Main" className="flex flex-col gap-5 px-3">
              {groups.map((group, index) => (
                <NavGroupSection
                  key={group.heading}
                  group={group}
                  approvals={count}
                  totals={totals}
                  chatCount={conversations.length}
                  narrow={narrow}
                  isFirst={index === 0}
                  onNavigate={onClose}
                />
              ))}
              {narrow ? null : <RecentChats onNavigate={onClose} />}
            </nav>
          </div>
        )}
        {!settingsMode && (farmItem || settingsItem) ? (
          <nav aria-label="Utilities" className="flex shrink-0 flex-col gap-0.5 px-3 py-1">
            {farmItem ? (
              <NavRow
                to={farmItem.to}
                label={farmItem.label}
                icon={farmItem.icon}
                collapsed={narrow}
                onNavigate={onClose}
              />
            ) : null}
            {settingsItem ? (
              <NavRow
                to={settingsItem.to}
                label={settingsItem.label}
                icon={settingsItem.icon}
                collapsed={narrow}
                onNavigate={onClose}
              />
            ) : null}
          </nav>
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
  const settingsMode = isSettingsPath(pathname);
  const openerRef = useRef<HTMLButtonElement>(null);
  const { activeChatTitle, activeChatId } = useConversations();
  const isConversation = pathname === "/" || pathname.startsWith("/chat/");
  // A page that renders `PageShell` publishes its own name, so a detail route is titled by the
  // record it is showing rather than by the section it sits under.
  const publishedTitle = usePageChromeTitle();
  const setActionSlot = useSetActionSlot();
  const pageTitle = isConversation
    ? (activeChatTitle ?? (pathname === "/" ? "New chat" : "Chat"))
    : (publishedTitle ?? titleForPath(pathname));
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
      <AppSidebar
        open={open}
        onClose={() => setOpen(false)}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        user={user}
      />
      <div className="flex h-svh min-w-0 flex-1 flex-col bg-background lg:my-1 lg:mr-1 lg:h-[calc(100svh-0.5rem)] lg:overflow-hidden lg:rounded-lg lg:border lg:border-border">
        <header
          className={cn(HEADER_ROW, "gap-2 border-b border-border bg-background px-3 sm:px-4")}
        >
          <button
            ref={openerRef}
            type="button"
            aria-label="Open navigation"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className="flex size-10 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent lg:hidden"
          >
            <Menu className="size-5" aria-hidden />
          </button>
          {/* Expanded, the collapse control lives in the sidebar's own header, next to the thing
           * it resizes. Collapsed, that header has room for the mark alone, so the way back out
           * moves here — one control, never two claiming the same job. */}
          {collapsed && !settingsMode ? (
            <>
              <Tooltip content="Expand sidebar">
                <button
                  type="button"
                  aria-label="Expand sidebar"
                  aria-expanded={false}
                  onClick={toggleCollapsed}
                  className="hidden size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:flex"
                >
                  <PanelLeftOpen className="size-4" aria-hidden />
                </button>
              </Tooltip>
              <Separator orientation="vertical" className="mx-1 hidden h-5 lg:block" />
            </>
          ) : null}
          <PageTitle pathname={pathname} pageTitle={pageTitle} titleSlot={chatTitleSlot} />
          <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
            {/* Page actions land left of the shell's own controls, so the reader meets what this
             * page can do before what the app can do. */}
            <div ref={setActionSlot} className="flex items-center gap-1.5 empty:hidden" />
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
