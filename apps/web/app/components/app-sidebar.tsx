import { Link, NavLink } from "@remix-run/react";
import { ArrowUpRight, Menu, MessageSquare, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ThemeToggle } from "~/components/theme-toggle";
import { useApprovals } from "~/lib/approvals-context";
import type { BadgeKey } from "~/lib/badges";
import { useConversations } from "~/lib/conversations-context";
import { type NavItem, navItems } from "~/lib/nav";
import { cn } from "~/lib/utils";

const COLLAPSED_KEY = "sidebar-collapsed";

function Logo({ className }: { className?: string }) {
  return (
    <img
      src="/logo-128.png"
      alt="tulipfarm"
      width={24}
      height={24}
      className={cn("size-6 shrink-0 rounded-sm", className)}
    />
  );
}

function NavRow({
  item,
  rail,
  onNavigate,
}: {
  item: NavItem;
  rail: boolean;
  onNavigate: () => void;
}) {
  const { to, label, icon: Icon, end, badgeKey } = item;
  // Live badge counts from the shared ApprovalsProvider (inert 0 when no provider is mounted).
  const { count: approvalsCount } = useApprovals();
  const liveCounts: Partial<Record<BadgeKey, number>> = { approvals: approvalsCount };
  const count = badgeKey ? (liveCounts[badgeKey] ?? 0) : 0;

  const rowClass = (active: boolean) =>
    cn(
      "flex items-center gap-2 rounded-sm py-1.5 text-sm transition-colors",
      rail ? "justify-center px-2" : "px-3",
      active
        ? "bg-sidebar-accent font-medium text-sidebar-primary"
        : "text-sidebar-foreground hover:bg-sidebar-accent/50"
    );
  const content = (
    <>
      <span className="relative flex">
        <Icon className="size-4 shrink-0" />
        {rail && count > 0 ? (
          <span
            aria-hidden
            className="absolute -right-1 -top-1 size-2 rounded-full bg-primary ring-2 ring-sidebar"
          />
        ) : null}
      </span>
      {rail ? null : (
        <>
          <span className="flex-1">{label}</span>
          {count > 0 ? (
            <span className="rounded-sm bg-primary px-1.5 py-0.5 text-xs font-medium text-primary-foreground tabular-nums">
              {count}
            </span>
          ) : null}
        </>
      )}
    </>
  );

  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      title={rail ? label : undefined}
      className={({ isActive }) => rowClass(isActive)}
    >
      {content}
    </NavLink>
  );
}

// The primary "start a fresh chat" action, pinned at the very top of the nav (above Workspace). A
// quiet borderless row (matching the nav vocabulary, not a heavy boxed CTA); the ruby `[+]` glyph —
// the project's terminal-native action motif — carries its primary-action weight. Routes to "/" and
// forces a clean transcript (via startNewChat's remount nonce) even from a shallow-routed chat.
function NewChatButton({ rail, onNavigate }: { rail: boolean; onNavigate: () => void }) {
  const { startNewChat } = useConversations();
  return (
    <button
      type="button"
      onClick={() => {
        startNewChat();
        onNavigate();
      }}
      title={rail ? "New chat" : undefined}
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-sm py-1.5 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent/50",
        rail ? "justify-center px-2" : "px-3"
      )}
    >
      <span aria-hidden className="font-medium text-primary">
        [+]
      </span>
      {rail ? null : <span className="font-medium">New chat</span>}
    </button>
  );
}

// Persisted chat history (UUID-chat persistence). Reads the shared ConversationsProvider. The section
// header is the clickable "Chats" entry point → the /chats browse page (there is no standalone "Chat"
// nav item); below it, the recent conversations link to /chat/:id. Titles are quick-model generated
// (or "New chat" until one lands). Active state lights up the conversation matching /chat/:id.
function RecentChats({ rail, onNavigate }: { rail: boolean; onNavigate: () => void }) {
  const { conversations, activeChatId } = useConversations();
  // Collapsed rail: just a single icon-link to the Chats page (the recent list is hidden), so the
  // entry point survives collapse now that the nav has no "Chat" row.
  if (rail) {
    return (
      <Link
        to="/chats"
        onClick={onNavigate}
        title="Chats"
        className="mt-2 flex shrink-0 items-center justify-center rounded-sm px-2 py-1.5 text-sidebar-foreground transition-colors hover:bg-sidebar-accent/50"
      >
        <MessageSquare className="size-4 shrink-0" />
      </Link>
    );
  }
  return (
    // The session zone: separated from the persistent nav by a full-bleed hairline (depth from
    // borders, not boxes; `-mx-2 px-2` bleeds the rule edge-to-edge while keeping content aligned).
    // flex-1 + min-h-0 claims the leftover height; the header stays pinned, only the list below scrolls.
    <div className="-mx-2 mt-2 flex min-h-0 flex-1 flex-col border-t border-sidebar-border px-2 pt-2">
      {/* The header doubles as the link to the full Chats browse/search page. */}
      <Link
        to="/chats"
        onClick={onNavigate}
        className="group flex shrink-0 items-center gap-1 rounded-sm px-3 pb-1 text-[0.625rem] font-medium uppercase tracking-[0.2em] text-muted-foreground transition-colors hover:text-sidebar-primary"
      >
        <span>Chats</span>
        <ArrowUpRight className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
      </Link>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {conversations.map((c) => {
          // Active state comes from the provider's `activeChatId` (not NavLink's router-only isActive)
          // so a chat opened via shallow replaceState still highlights correctly. No side-stripe — the
          // selection reads as a quiet background tint + ruby title, consistent with the nav rows.
          const active = c.id === activeChatId;
          return (
            <Link
              key={c.id}
              to={`/chat/${c.id}`}
              onClick={onNavigate}
              title={c.title ?? "New chat"}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center rounded-sm px-3 py-1.5 text-sm transition-colors",
                active
                  ? "bg-sidebar-accent font-medium text-sidebar-primary"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/50"
              )}
            >
              <span className="truncate">{c.title ?? "New chat"}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export function AppSidebar() {
  const [open, setOpen] = useState(false); // mobile drawer
  const [collapsed, setCollapsed] = useState(false); // desktop rail
  // Desktop-first so the nav is never hidden from AT before the media query resolves.
  const [isDesktop, setIsDesktop] = useState(true);
  const navRef = useRef<HTMLElement>(null);
  const close = () => setOpen(false);

  // Collapse only applies on desktop; the mobile drawer always shows full labels.
  const rail = collapsed && isDesktop;

  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSED_KEY) === "true");
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Mobile drawer keyboard contract: Escape closes, focus moves into the drawer on open.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    navRef.current?.querySelector<HTMLAnchorElement>("a")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(COLLAPSED_KEY, String(next));
      return next;
    });
  }

  return (
    <>
      {/* Mobile top bar with hamburger (hidden ≥ md). */}
      <header className="bg-sidebar text-sidebar-foreground border-sidebar-border flex h-12 items-center gap-2 border-b px-2 md:hidden">
        <button
          type="button"
          aria-label="Open navigation"
          aria-expanded={open}
          aria-controls="app-nav"
          onClick={() => setOpen(true)}
          className="hover:bg-sidebar-accent/50 rounded-sm p-2"
        >
          <Menu className="size-5" />
        </button>
        <Logo />
        <span className="text-sm font-bold">tulipfarm</span>
      </header>

      {/* Backdrop for the mobile drawer. */}
      {open ? (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={close}
          className="fixed inset-0 z-40 bg-foreground/20 md:hidden"
        />
      ) : null}

      <aside
        ref={navRef}
        id="app-nav"
        aria-hidden={!isDesktop && !open}
        className={cn(
          "bg-sidebar text-sidebar-foreground border-sidebar-border fixed inset-y-0 left-0 z-50 flex w-60 shrink-0 flex-col border-r transition-[transform,width] md:static md:z-auto md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
          rail ? "md:w-14" : "md:w-60"
        )}
      >
        <div
          className={cn(
            "flex py-3",
            rail ? "flex-col items-center gap-3 px-2" : "items-center gap-2 px-3"
          )}
        >
          <Logo />
          {rail ? null : <span className="flex-1 text-base font-bold">tulipfarm</span>}
          {/* Desktop collapse toggle. */}
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="hover:bg-sidebar-accent/50 hidden rounded-sm p-1.5 md:inline-flex"
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" />
            ) : (
              <PanelLeftClose className="size-4" />
            )}
          </button>
          {/* Mobile drawer close. */}
          <button
            type="button"
            aria-label="Close navigation"
            onClick={close}
            className="hover:bg-sidebar-accent/50 rounded-sm p-1.5 md:hidden"
          >
            <X className="size-5" />
          </button>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col p-2">
          {/* Fixed top: the primary "New chat" action, then one flat, uniformly-spaced nav list (no
              section headers, no per-group divs — `navItems` is already ordered Workspace→System, so a
              single map keeps every row gap identical and hover-continuous). Never scrolls. */}
          <div className="flex shrink-0 flex-col gap-0.5">
            <NewChatButton rail={rail} onNavigate={close} />
            {navItems.map((item) => (
              <NavRow key={item.to} item={item} rail={rail} onNavigate={close} />
            ))}
          </div>
          <RecentChats rail={rail} onNavigate={close} />
        </nav>

        {/* Footer: synced theme toggle + instance label (icon-only when railed). */}
        <div
          className={cn(
            "flex shrink-0 items-center gap-2 border-t border-sidebar-border p-2",
            rail ? "justify-center" : "px-3"
          )}
        >
          {rail ? null : (
            <span className="flex-1 truncate text-xs text-muted-foreground">
              v1 · local instance
            </span>
          )}
          <ThemeToggle iconOnly />
        </div>
      </aside>
    </>
  );
}
