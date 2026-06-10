import { NavLink } from "@remix-run/react";
import { Menu, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ThemeToggle } from "~/components/theme-toggle";
import { useApprovals } from "~/lib/approvals-context";
import type { BadgeKey } from "~/lib/badges";
import { type NavItem, navGroups, navItems } from "~/lib/nav";
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
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      title={rail ? label : undefined}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2 rounded-sm border-l-2 py-2 text-sm transition-colors",
          rail ? "justify-center px-2" : "px-3",
          isActive
            ? "border-primary bg-sidebar-accent text-sidebar-primary font-medium"
            : "border-transparent text-sidebar-foreground hover:bg-sidebar-accent/50"
        )
      }
    >
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
    </NavLink>
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
        <nav className="flex flex-1 flex-col gap-4 overflow-y-auto p-2">
          {navGroups.map((group) => (
            <div key={group} className="flex flex-col gap-1">
              {rail ? null : (
                <p className="px-3 pb-1 text-[0.625rem] font-medium uppercase tracking-[0.2em] text-muted-foreground">
                  {group}
                </p>
              )}
              {navItems
                .filter((item) => item.group === group)
                .map((item) => (
                  <NavRow key={item.to} item={item} rail={rail} onNavigate={close} />
                ))}
            </div>
          ))}
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
