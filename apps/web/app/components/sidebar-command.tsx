import { useNavigate } from "@remix-run/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Icon, MessageSquare, Plus, Search } from "~/components/icons";
import { useConversations } from "~/lib/conversations-context";
import {
  type NavigationVisibility,
  visibleFarmItem,
  visibleSettingsGroups,
  visibleSettingsItem,
  visibleSidebarGroups,
} from "~/lib/nav";
import { cn } from "~/lib/utils";

/** Render order. A reader who opens the palette to *do* something should not scroll past pages. */
const SECTIONS = ["Actions", "Pages", "Chats", "Settings"] as const;
export type CommandSection = (typeof SECTIONS)[number];

export type CommandEntry = {
  id: string;
  label: string;
  /** Where the entry lives, so two rows named alike are still told apart. */
  hint: string;
  section: CommandSection;
  icon: Icon;
  /** Set for anything that is a place. Actions carry `run` instead. */
  to?: string;
  run?: () => void;
};

export type CommandActions = {
  startNewChat: () => void;
};

/**
 * Everything the palette can reach: the reader's own destinations, their open chats, and the
 * create routes their grants allow. Nothing else — an input that promises records and returns
 * navigation is worse than one that promises navigation.
 */
export function commandEntries(
  visibility: NavigationVisibility,
  chats: ReadonlyArray<{ id: string; title: string | null }>,
  actions: CommandActions
): CommandEntry[] {
  const groups = visibleSidebarGroups(visibility);
  const farmItem = visibleFarmItem(visibility);
  const settingsItem = visibleSettingsItem(visibility);
  const creatable = groups.flatMap((group) =>
    group.items.flatMap((item) => (item.create ? [{ item, create: item.create }] : []))
  );
  return [
    {
      id: "action:new-chat",
      label: "New chat",
      hint: "Start a conversation",
      section: "Actions" as const,
      icon: Plus,
      to: "/",
      run: actions.startNewChat,
    },
    ...creatable.map(({ item, create }) => ({
      id: `action:${create.to}`,
      label: create.label,
      hint: item.label,
      section: "Actions" as const,
      icon: Plus,
      to: create.to,
    })),
    ...groups.flatMap((group) =>
      group.items.map((item) => ({
        id: item.to,
        label: item.label,
        hint: group.heading,
        section: "Pages" as const,
        icon: item.icon,
        to: item.to,
      }))
    ),
    ...(farmItem
      ? [
          {
            id: farmItem.to,
            label: farmItem.label,
            hint: "Workspace",
            section: "Pages" as const,
            icon: farmItem.icon,
            to: farmItem.to,
          },
        ]
      : []),
    ...chats.map((chat) => ({
      id: `chat:${chat.id}`,
      label: chat.title ?? "New chat",
      hint: "Chat",
      section: "Chats" as const,
      icon: MessageSquare,
      to: `/chat/${chat.id}`,
    })),
    ...(settingsItem
      ? [
          {
            id: settingsItem.to,
            label: settingsItem.label,
            hint: "All settings",
            section: "Settings" as const,
            icon: settingsItem.icon,
            to: settingsItem.to,
          },
        ]
      : []),
    ...visibleSettingsGroups(visibility).flatMap((group) =>
      group.items.map((item) => ({
        id: item.to,
        label: item.label,
        hint: group.heading,
        section: "Settings" as const,
        icon: item.icon,
        to: item.to,
      }))
    ),
  ];
}

export function filterEntries(entries: CommandEntry[], query: string): CommandEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return entries;
  return entries.filter((entry) => `${entry.label} ${entry.hint}`.toLowerCase().includes(needle));
}

/** Where each run of one section starts, so a heading is drawn once rather than per row. */
function sectionStarts(results: CommandEntry[]): Map<number, CommandSection> {
  const starts = new Map<number, CommandSection>();
  let previous: CommandSection | undefined;
  results.forEach((entry, index) => {
    if (entry.section !== previous) starts.set(index, entry.section);
    previous = entry.section;
  });
  return starts;
}

/**
 * `/` is a shortcut only while nothing is being typed into — otherwise it would swallow the
 * slash a reader meant to put in the chat composer.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border px-1 font-sans text-[0.6875rem] leading-4 text-muted-foreground">
      {children}
    </kbd>
  );
}

function CommandDialog({ entries, onClose }: { entries: CommandEntry[]; onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputId = useId();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => filterEntries(entries, query), [entries, query]);
  const starts = useMemo(() => sectionStarts(results), [results]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const go = useCallback(
    (entry: CommandEntry | undefined) => {
      if (!entry) return;
      onClose();
      entry.run?.();
      if (entry.to) navigate(entry.to);
    },
    [navigate, onClose]
  );

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => (results.length === 0 ? 0 : (current + 1) % results.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) =>
        results.length === 0 ? 0 : (current - 1 + results.length) % results.length
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(results[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  /* Portalled to the body because the sidebar is a transformed element, and a transform makes
   * itself the containing block for `position: fixed` — rendered in place, the palette would be
   * trapped at the sidebar's 256px instead of centred on the viewport. */
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-start justify-center p-4 pt-[14vh]">
      <button
        type="button"
        aria-label="Close command menu"
        tabIndex={-1}
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command menu"
        onKeyDown={onKeyDown}
        className={cn(
          "relative flex w-full max-w-xl flex-col overflow-hidden rounded-lg",
          "border border-border bg-popover shadow-2xl"
        )}
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <label htmlFor={inputId} className="sr-only">
            Search pages, chats and actions
          </label>
          <input
            ref={inputRef}
            id={inputId}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            placeholder="Search pages, chats and actions"
            className="h-14 min-w-0 flex-1 bg-transparent text-[0.9375rem] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
        <ul id={listId} className="max-h-[52vh] overflow-y-auto p-2">
          {results.length === 0 ? (
            <li className="px-3 py-10 text-center text-sm text-muted-foreground">
              Nothing matches “{query.trim()}”.
            </li>
          ) : (
            results.map((entry, index) => (
              <li key={entry.id}>
                {starts.has(index) ? (
                  <p className="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground first:pt-1">
                    {starts.get(index)}
                  </p>
                ) : null}
                <button
                  type="button"
                  id={`${listId}-${index}`}
                  onClick={() => go(entry)}
                  onMouseMove={() => setActive(index)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm",
                    index === active
                      ? "bg-accent text-accent-foreground"
                      : "text-sidebar-foreground"
                  )}
                >
                  <entry.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{entry.hint}</span>
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-[0.6875rem] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Key>↑</Key>
            <Key>↓</Key>
            move
          </span>
          <span className="flex items-center gap-1">
            <Key>↵</Key>
            open
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Key>esc</Key>
            close
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}

/**
 * The sidebar's search affordance. Collapsed it is the same 28px square as every other row, so
 * the icon spine survives the width change.
 */
export function SidebarCommand({
  visibility,
  collapsed,
  compact = false,
  className,
}: {
  visibility: NavigationVisibility;
  collapsed: boolean;
  compact?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const { conversations, startNewChat } = useConversations();
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Resolved after mount so the prerendered shell does not bake one platform's key into the HTML.
  const [apple, setApple] = useState(true);
  const entries = useMemo(
    () => commandEntries(visibility, conversations, { startNewChat }),
    [visibility, conversations, startNewChat]
  );

  useEffect(() => {
    setApple(/Mac|iPhone|iPad/.test(navigator.userAgent));
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const palette = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      const slash = event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (!palette && !slash) return;
      if (slash && isTypingTarget(event.target)) return;
      event.preventDefault();
      setOpen(true);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function close() {
    setOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search pages, chats and actions"
        aria-keyshortcuts="Meta+K Control+K /"
        className={cn(
          "flex min-h-7 items-center rounded-md border border-sidebar-border bg-background",
          "text-sm text-muted-foreground transition-colors",
          "hover:border-primary/50 hover:bg-sidebar-accent",
          collapsed
            ? "size-7 shrink-0 justify-center px-0 mx-auto"
            : compact
              ? "size-7 shrink-0 justify-center border-transparent bg-transparent px-0"
              : "mx-2 gap-2.5 px-3",
          className
        )}
      >
        <Search className="size-4 shrink-0" aria-hidden />
        {collapsed || compact ? null : (
          <>
            <span className="min-w-0 flex-1 truncate text-left">Search</span>
            <kbd className="shrink-0 font-sans text-[0.6875rem] tracking-wide text-muted-foreground">
              {apple ? "⌘K" : "Ctrl K"}
            </kbd>
          </>
        )}
      </button>
      {open ? <CommandDialog entries={entries} onClose={close} /> : null}
    </>
  );
}
