import { Link, type MetaFunction, useLoaderData, useRouteError } from "@remix-run/react";
import { MoreHorizontal, Pencil, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState } from "~/components/states";
import { ApiError } from "~/lib/api";
import {
  type ConversationSummary,
  listConversations,
  renameConversation,
  setConversationStarred,
} from "~/lib/conversations";
import { useConversations } from "~/lib/conversations-context";
import { cn } from "~/lib/utils";

export const meta: MetaFunction = () => [{ title: "Chats · tulipfarm" }];

const command = "tulipfarm chats --list";
const inputClass =
  "h-8 w-full rounded-sm border border-border bg-background px-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

// Browse + search every persisted chat (UUID-chat persistence). The sidebar "Chats" header links
// here. Search is server-side across all the caller's chats by title (debounced); each row's three-dots
// menu stars (pins) or renames the chat inline. The fetch limit is generous so the list is "all" chats
// in practice; the API caps it at 200.
export async function clientLoader() {
  const items = await listConversations({ limit: 200 });
  return { items };
}

export default function ChatsRoute() {
  const { items: initial } = useLoaderData<typeof clientLoader>();
  const { refresh } = useConversations();
  const [items, setItems] = useState<ConversationSummary[]>(initial);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // Server-side search, debounced. The loader already seeded the first render, so skip the initial
  // (empty-query) run; subsequent changes — including clearing the box back to "" — refetch.
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    let ignore = false;
    const q = query.trim();
    const handle = setTimeout(() => {
      listConversations(q ? { q, limit: 200 } : { limit: 200 })
        .then((next) => {
          if (!ignore) {
            setItems(next);
            setError(null);
          }
        })
        .catch((err) => {
          if (!ignore) setError(err instanceof Error ? err.message : "search failed");
        });
    }, 250);
    return () => {
      ignore = true;
      clearTimeout(handle);
    };
  }, [query]);

  // Replace one chat in place after a star/rename, and refresh the sidebar list so it reflects the
  // change too. No refetch — the PUT returns the updated summary.
  function applyUpdate(updated: ConversationSummary) {
    setItems((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    void refresh();
  }

  async function onToggleStar(c: ConversationSummary) {
    try {
      applyUpdate(await setConversationStarred(c.id, !c.starred));
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not update chat");
    }
  }

  async function onRename(id: string, title: string) {
    const next = title.trim();
    setRenamingId(null);
    if (!next) return;
    try {
      applyUpdate(await renameConversation(id, next));
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not rename chat");
    }
  }

  // Starred chats pinned to the top; recency order (server-sorted) preserved within each group by the
  // stable sort.
  const sorted = [...items].sort((a, b) => Number(b.starred) - Number(a.starred));

  return (
    <ResourcePanel crumbs={[{ label: "chats" }]} command={command}>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="search chats…"
        aria-label="search chats"
        className={inputClass}
      />

      {/* Filter row — only "All" for now (no real filters yet). */}
      <div className="flex items-center gap-2 text-xs">
        <span className="rounded-sm border border-primary/40 bg-secondary px-2 py-0.5 font-medium text-foreground">
          All
        </span>
      </div>

      {error ? <p className="text-destructive">error: {error}</p> : null}

      {sorted.length === 0 ? (
        <p className="text-muted-foreground">
          {query.trim() ? "0 chats match that search." : "No chats yet."}{" "}
          <Link to="/" className="text-primary hover:underline">
            Start a new chat
          </Link>
          .
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {sorted.map((c) => (
            <li key={c.id}>
              {renamingId === c.id ? (
                <RenameRow
                  initialTitle={c.title ?? ""}
                  onSave={(title) => onRename(c.id, title)}
                  onCancel={() => setRenamingId(null)}
                />
              ) : (
                <ChatRow
                  chat={c}
                  onToggleStar={() => onToggleStar(c)}
                  onStartRename={() => setRenamingId(c.id)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </ResourcePanel>
  );
}

function ChatRow({
  chat,
  onToggleStar,
  onStartRename,
}: {
  chat: ConversationSummary;
  onToggleStar: () => void;
  onStartRename: () => void;
}) {
  return (
    <div className="group flex items-center gap-2 rounded-sm pr-1 transition-colors hover:bg-secondary">
      <Link to={`/chat/${chat.id}`} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2">
        {chat.starred ? (
          <Star aria-label="starred" className="size-3.5 shrink-0 fill-primary text-primary" />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {chat.title ?? "New chat"}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatWhen(chat.updatedAt)}
        </span>
      </Link>
      <ChatRowMenu
        starred={chat.starred}
        onToggleStar={onToggleStar}
        onStartRename={onStartRename}
      />
    </div>
  );
}

// Per-row actions, portalled so the scrolling panel never clips the menu (mirrors the composer's
// ModelSelector). Closes on outside-click, Escape, or any scroll/resize.
function ChatRowMenu({
  starred,
  onToggleStar,
  onStartRename,
}: {
  starred: boolean;
  onToggleStar: () => void;
  onStartRename: () => void;
}) {
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
      if (e.key === "Escape") setOpen(false);
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

  function toggle() {
    if (!open && triggerRef.current) setRect(triggerRef.current.getBoundingClientRect());
    setOpen((o) => !o);
  }

  const itemClass =
    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-foreground transition-colors hover:bg-secondary";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Chat actions"
        onClick={toggle}
        className={cn(
          "shrink-0 rounded-sm p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100",
          open && "opacity-100"
        )}
      >
        <MoreHorizontal className="size-4" />
      </button>

      {open && rect
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              className="fixed z-50 w-40 rounded-sm border border-border bg-card p-1 text-xs"
              style={{ top: rect.bottom + 4, right: window.innerWidth - rect.right }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onToggleStar();
                  setOpen(false);
                }}
                className={itemClass}
              >
                <Star className={cn("size-3.5", starred && "fill-primary text-primary")} />
                {starred ? "Unstar" : "Star"}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onStartRename();
                  setOpen(false);
                }}
                className={itemClass}
              >
                <Pencil className="size-3.5" />
                Rename
              </button>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

// Inline rename: Enter saves, Escape cancels, blur saves. Autofocused + text selected on mount.
function RenameRow({
  initialTitle,
  onSave,
  onCancel,
}: {
  initialTitle: string;
  onSave: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialTitle);
  // Enter/Escape commit then unmount the input, which fires a trailing blur — `done` makes that blur
  // a no-op so we neither save twice nor save after an Escape-cancel.
  const done = useRef(false);
  const commit = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: focus belongs on the field the user just chose to edit
      autoFocus
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(() => onSave(value));
        else if (e.key === "Escape") commit(onCancel);
      }}
      onBlur={() => commit(() => onSave(value))}
      aria-label="Rename chat"
      maxLength={200}
      className={cn(inputClass, "my-0.5")}
    />
  );
}

// Compact relative time for chat rows, falling back to a locale date past a week.
function formatWhen(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return "just now";
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="chats" command={command} status={status} message={message} />;
}
