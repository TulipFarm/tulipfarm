import { Link, NavLink, useLocation, useNavigate } from "@remix-run/react";
import {
  Activity,
  BookOpen,
  Bot,
  Boxes,
  Brain,
  Cpu,
  History,
  Inbox,
  Info,
  KeyRound,
  LogOut,
  Menu,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Puzzle,
  Settings,
  ShieldAlert,
  Sparkles,
  Workflow,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { KnowledgeTree } from "~/components/knowledge/space-tree";
import { ThemeToggle } from "~/components/theme-toggle";
import { logout } from "~/lib/api";
import { useApprovals } from "~/lib/approvals-context";
import { useConversations } from "~/lib/conversations-context";
import { cn } from "~/lib/utils";

type ProductMode = "chat" | "build" | "knowledge" | "operate" | "settings";

const MODE_LINKS = [
  { mode: "chat", to: "/", label: "Chat", icon: MessageSquare },
  { mode: "build", to: "/resources", label: "Build", icon: Boxes },
  { mode: "knowledge", to: "/knowledge", label: "Knowledge", icon: BookOpen },
  { mode: "operate", to: "/inbox", label: "Operate", icon: Activity },
] as const;

const BUILD_LINKS = [
  { to: "/resources", label: "Resources", icon: Boxes },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/skills", label: "Skills", icon: Puzzle },
  { to: "/routines", label: "Routines", icon: Workflow },
] as const;

const OPERATE_LINKS = [
  { to: "/inbox", label: "Inbox", icon: Inbox, badge: true },
  { to: "/runs", label: "Runs", icon: Activity },
  { to: "/integrations", label: "Integrations", icon: Plug },
  { to: "/operations", label: "Operations", icon: ShieldAlert },
] as const;

const SETTINGS_LINKS = [
  { to: "/settings/secrets", label: "Secrets", icon: KeyRound },
  { to: "/settings/llm", label: "LLM", icon: Cpu },
  { to: "/settings/observability", label: "Observability", icon: Activity },
  { to: "/settings/soul", label: "Soul", icon: Sparkles },
  { to: "/settings/activities", label: "Activities", icon: History },
  { to: "/settings/memory", label: "Memory", icon: Brain },
  { to: "/settings/about", label: "About", icon: Info },
] as const;

function modeForPath(pathname: string): ProductMode {
  if (pathname.startsWith("/settings") || pathname.startsWith("/admin")) return "settings";
  if (pathname.startsWith("/knowledge")) return "knowledge";
  if (
    pathname.startsWith("/inbox") ||
    pathname.startsWith("/runs") ||
    pathname.startsWith("/integrations") ||
    pathname.startsWith("/operations")
  ) {
    return "operate";
  }
  if (
    pathname.startsWith("/resources") ||
    pathname.startsWith("/agents") ||
    pathname.startsWith("/skills") ||
    pathname.startsWith("/routines")
  ) {
    return "build";
  }
  return "chat";
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
      title="Sign out"
      aria-label="Sign out"
      className={cn(
        "flex min-h-9 items-center gap-2 rounded-md text-muted-foreground transition-colors",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:opacity-50",
        compact ? "size-10 justify-center" : "w-full px-3 text-sm"
      )}
    >
      <LogOut className="size-4" aria-hidden />
      {compact ? null : <span>Sign out</span>}
    </button>
  );
}

function Rail({ mode }: { mode: ProductMode }) {
  return (
    <div className="flex w-14 shrink-0 flex-col items-center border-r border-sidebar-border bg-background py-3">
      <Link to="/" aria-label="TulipFarm home" className="mb-4 rounded-md p-1.5">
        <Logo />
      </Link>
      <nav aria-label="Product modes" className="flex flex-1 flex-col items-center gap-1">
        {MODE_LINKS.map(({ mode: itemMode, to, label, icon: Icon }) => (
          <Link
            key={itemMode}
            to={to}
            title={label}
            aria-label={label}
            aria-current={mode === itemMode ? "page" : undefined}
            className={cn(
              "flex size-10 items-center justify-center rounded-md text-muted-foreground",
              "transition-colors hover:bg-accent hover:text-foreground",
              mode === itemMode && "bg-accent text-primary"
            )}
          >
            <Icon className="size-5" aria-hidden />
          </Link>
        ))}
      </nav>
      <div className="flex flex-col items-center gap-1">
        <Link
          to="/settings"
          title="Settings"
          aria-label="Settings"
          aria-current={mode === "settings" ? "page" : undefined}
          className={cn(
            "flex size-10 items-center justify-center rounded-md text-muted-foreground",
            "transition-colors hover:bg-accent hover:text-foreground",
            mode === "settings" && "bg-accent text-primary"
          )}
        >
          <Settings className="size-5" aria-hidden />
        </Link>
        <ThemeToggle iconOnly />
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
  icon: typeof Boxes;
  count?: number;
  onNavigate: () => void;
}) {
  return (
    <NavLink
      to={to}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "flex min-h-9 items-center gap-2 rounded-md px-3 text-sm transition-colors",
          isActive
            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-accent/60"
        )
      }
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count ? (
        <span className="rounded-sm bg-primary px-1.5 py-0.5 text-xs text-primary-foreground">
          {count}
        </span>
      ) : null}
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
        className="mx-3 mb-5 flex min-h-10 items-center gap-2 rounded-md border border-sidebar-border bg-background px-3 text-sm font-medium transition-colors hover:border-primary/50 hover:bg-sidebar-accent"
      >
        <span className="text-primary text-base leading-none" aria-hidden>
          +
        </span>
        New chat
      </button>
      <div className="mb-2 flex items-center px-5">
        <Link
          to="/chats"
          onClick={onNavigate}
          className="text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground"
        >
          Recent chats
        </Link>
        <button
          type="button"
          aria-label="Chat options"
          className="ml-auto rounded-sm p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </button>
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
                "block truncate rounded-md px-3 py-2 text-sm transition-colors",
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

function LinkList({ mode, onNavigate }: { mode: ProductMode; onNavigate: () => void }) {
  const { count } = useApprovals();
  const links =
    mode === "build" ? BUILD_LINKS : mode === "operate" ? OPERATE_LINKS : SETTINGS_LINKS;
  return (
    <nav aria-label={`${mode} navigation`} className="flex flex-col gap-1 px-2">
      {links.map((item) => (
        <ContextLink
          key={item.to}
          {...item}
          count={"badge" in item && item.badge ? count : undefined}
          onNavigate={onNavigate}
        />
      ))}
      {mode === "settings" && import.meta.env.DEV ? (
        <ContextLink
          to="/design-guide"
          label="Design guide"
          icon={Sparkles}
          onNavigate={onNavigate}
        />
      ) : null}
    </nav>
  );
}

function ContextPanel({ mode, onNavigate }: { mode: ProductMode; onNavigate: () => void }) {
  const title = mode.charAt(0).toUpperCase() + mode.slice(1);
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-[52px] shrink-0 items-center border-b border-sidebar-border px-4">
        <span className="flex size-7 items-center justify-center rounded-md border border-sidebar-border bg-background text-primary">
          <MessageSquare className="size-3.5" aria-hidden />
        </span>
        <span className="ml-2 text-sm font-semibold">{title}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-3">
        {mode === "chat" ? <ChatContext onNavigate={onNavigate} /> : null}
        {mode === "knowledge" ? <KnowledgeTree /> : null}
        {mode === "build" || mode === "operate" || mode === "settings" ? (
          <LinkList mode={mode} onNavigate={onNavigate} />
        ) : null}
      </div>
    </div>
  );
}

export function AppSidebar({
  open = false,
  onClose = () => {},
  collapsed = false,
}: {
  forceCollapsed?: boolean;
  open?: boolean;
  onClose?: () => void;
  collapsed?: boolean;
} = {}) {
  const { pathname } = useLocation();
  const mode = modeForPath(pathname);
  const [persistent, setPersistent] = useState(true);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const update = () => setPersistent(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

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
        aria-hidden={hidden}
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex h-full border-r border-sidebar-border transition-transform",
          "lg:static lg:z-auto lg:translate-x-0",
          open
            ? "w-[340px] translate-x-0"
            : "w-[340px] -translate-x-full md:static md:w-14 md:translate-x-0",
          !collapsed && "lg:w-[312px]",
          collapsed && "lg:w-14"
        )}
      >
        <Rail mode={mode} />
        <div
          className={cn(
            "h-full min-w-0 flex-1",
            !open && "hidden lg:block",
            collapsed && "lg:hidden"
          )}
        >
          <ContextPanel mode={mode} onNavigate={onClose} />
        </div>
      </aside>
    </>
  );
}

const TITLES: Array<[string, string]> = [
  ["/resources", "Resources"],
  ["/agents", "Agents"],
  ["/skills", "Skills"],
  ["/routines", "Routines"],
  ["/runs", "Runs"],
  ["/inbox", "Inbox"],
  ["/knowledge", "Knowledge"],
  ["/integrations", "Integrations"],
  ["/operations", "Operations"],
  ["/settings", "Settings"],
  ["/admin", "Admin"],
  ["/design-guide", "Design guide"],
  ["/chats", "Chats"],
  ["/chat", "Chat"],
];

function titleForPath(pathname: string): string {
  return TITLES.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? "Chat";
}

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const { pathname } = useLocation();
  const openerRef = useRef<HTMLButtonElement>(null);
  const pageTitle = pathname === "/" ? "New chat" : titleForPath(pathname);

  useEffect(() => {
    setCollapsed(localStorage.getItem("context-sidebar-collapsed") === "true");
  }, []);

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
      return next;
    });
  }

  return (
    <div className="flex min-h-svh bg-background lg:h-svh lg:overflow-hidden">
      <AppSidebar open={open} onClose={() => setOpen(false)} collapsed={collapsed} />
      <div className="flex min-w-0 flex-1 flex-col lg:h-svh">
        <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border bg-background px-3 sm:px-4">
          <button
            ref={openerRef}
            type="button"
            aria-label="Open navigation"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className="flex size-10 items-center justify-center rounded-md hover:bg-accent lg:hidden"
          >
            <Menu className="size-5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={collapsed ? "Expand context sidebar" : "Collapse context sidebar"}
            onClick={toggleCollapsed}
            className="hidden size-9 items-center justify-center rounded-md hover:bg-accent lg:flex"
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" aria-hidden />
            ) : (
              <PanelLeftClose className="size-4" aria-hidden />
            )}
          </button>
          <span className="hidden h-5 w-px bg-border sm:block" aria-hidden />
          <span className="hidden size-7 items-center justify-center rounded-md border border-border text-muted-foreground sm:flex">
            <MessageSquare className="size-3.5" aria-hidden />
          </span>
          <span className="min-w-0 truncate text-sm font-semibold">{pageTitle}</span>
          <button
            type="button"
            aria-label="Page options"
            className="hidden rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:flex"
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </button>
          <div className="ml-auto flex items-center gap-1 lg:hidden">
            <ThemeToggle iconOnly />
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="min-h-0 min-w-0 flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

export { modeForPath, titleForPath };
