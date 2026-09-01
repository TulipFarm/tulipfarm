import { Link } from "@remix-run/react";
import { ArrowUpRight, BookOpen, MessageSquarePlus, MoreHorizontal, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GITHUB_REPO_URL } from "~/lib/report-bug";
import { cn } from "~/lib/utils";

/*
 * The catalog's overflow menu. Every item resolves to something this instance can actually do:
 * asking for an integration is a chat draft, because a chat is how an agent is asked to build
 * anything here — not a request form that files into a queue nobody owns.
 */

const DOCS = "https://tulipfarm.site/docs";

/** Seeds the composer on the new-chat route, which strips the param once applied. */
const REQUEST_DRAFT =
  "I want to connect a tool that is not in the integrations catalog yet. " +
  "Ask me which tool and what I need agents to do with it, then tell me whether you can build " +
  "the integration and what you would need from me to do it.";

type Item =
  | { kind: "internal"; label: string; to: string; icon: typeof Sparkles }
  | { kind: "external"; label: string; href: string; icon: typeof Sparkles }
  | { kind: "separator" };

const ITEMS: Item[] = [
  {
    kind: "internal",
    label: "Request an integration",
    to: `/?draft=${encodeURIComponent(REQUEST_DRAFT)}`,
    icon: Sparkles,
  },
  { kind: "separator" },
  {
    kind: "external",
    label: "How integrations work",
    href: `${DOCS}/administration/how-integrations-work`,
    icon: BookOpen,
  },
  {
    kind: "external",
    label: "Bundled integrations",
    href: `${DOCS}/reference/bundled-integrations`,
    icon: BookOpen,
  },
  { kind: "separator" },
  {
    kind: "external",
    label: "Report a problem",
    href: `${GITHUB_REPO_URL}/issues/new`,
    icon: MessageSquarePlus,
  },
];

const MENU_WIDTH = 240;
const VIEWPORT_GUTTER = 8;

/**
 * Right-aligns the menu under its trigger, but never past the viewport edge — on a narrow phone
 * the trigger sits far enough left that a purely right-aligned menu hangs off-screen and clips
 * its own labels.
 */
function menuLeft(rect: DOMRect) {
  const preferred = rect.right - MENU_WIDTH;
  const max = window.innerWidth - MENU_WIDTH - VIEWPORT_GUTTER;
  return Math.max(VIEWPORT_GUTTER, Math.min(preferred, max));
}

const ITEM_CLASS =
  "flex w-full items-center gap-2.5 rounded-sm px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-secondary";

/** Portalled so the page's own scroll container cannot clip it — mirrors `ChatActionsMenu`. */
export function CatalogActionsMenu() {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More integration actions"
        onClick={() => {
          if (!open && triggerRef.current) setRect(triggerRef.current.getBoundingClientRect());
          setOpen((o) => !o);
        }}
        className={cn(
          "inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-input",
          "text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          open && "bg-accent text-foreground"
        )}
      >
        <MoreHorizontal className="size-4" />
      </button>

      {open && rect
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              className="fixed z-50 rounded-md border border-border bg-card p-1 shadow-lg"
              style={{ top: rect.bottom + 6, left: menuLeft(rect), width: MENU_WIDTH }}
            >
              {ITEMS.map((item, i) =>
                item.kind === "separator" ? (
                  <div key={`sep-${i}`} role="none" className="my-1 h-px bg-border" />
                ) : item.kind === "internal" ? (
                  <Link
                    key={item.label}
                    role="menuitem"
                    to={item.to}
                    onClick={() => setOpen(false)}
                    className={ITEM_CLASS}
                  >
                    <item.icon aria-hidden className="size-4 text-muted-foreground" />
                    {item.label}
                  </Link>
                ) : (
                  <a
                    key={item.label}
                    role="menuitem"
                    href={item.href}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => setOpen(false)}
                    className={ITEM_CLASS}
                  >
                    <item.icon aria-hidden className="size-4 text-muted-foreground" />
                    <span className="flex-1">{item.label}</span>
                    <ArrowUpRight aria-hidden className="size-3.5 text-muted-foreground" />
                  </a>
                )
              )}
            </div>,
            document.body
          )
        : null}
    </>
  );
}
