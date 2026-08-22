import { Link, type MetaFunction, useLoaderData, useRouteError } from "@remix-run/react";
import { MessageSquare, MoreHorizontal, Pencil, Plus, Search, Star, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ConfirmModal } from "~/components/ui/modal";
import { ApiError } from "~/lib/api";
import {
  type ConversationSummary,
  deleteConversation,
  listConversations,
  renameConversation,
  setConversationStarred,
} from "~/lib/conversations";
import { useConversations } from "~/lib/conversations-context";
import { cn } from "~/lib/utils";

export const meta: MetaFunction = () => [{ title: "Chats · tulipfarm" }];

const inputClass =
  "h-10 w-full rounded-md border border-input bg-background pl-10 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25";

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
  const [pendingDelete, setPendingDelete] = useState<ConversationSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [searching, setSearching] = useState(false);

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
    setSearching(true);
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
        })
        .finally(() => {
          if (!ignore) setSearching(false);
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

  async function onDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteConversation(pendingDelete.id);
      setItems((previous) => previous.filter((chat) => chat.id !== pendingDelete.id));
      await refresh();
      setPendingDelete(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not delete chat");
    } finally {
      setDeleting(false);
    }
  }

  // Starred chats pinned to the top; recency order (server-sorted) preserved within each group by the
  // stable sort.
  const sorted = [...items].sort((a, b) => Number(b.starred) - Number(a.starred));
  const starred = sorted.filter((chat) => chat.starred);
  const recent = sorted.filter((chat) => !chat.starred);

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col px-4 py-8 sm:px-6 sm:py-10">
        <header className="flex flex-col gap-5 border-b border-border pb-7 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-primary">Chat history</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Your chats</h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
              Return to previous work, pin important chats, or rename them for easier scanning.
            </p>
          </div>
          <Button asChild className="self-start sm:self-auto">
            <Link to="/">
              <Plus aria-hidden />
              New chat
            </Link>
          </Button>
        </header>

        <section aria-label="Chat history" className="pt-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <label className="relative block min-w-0 flex-1">
              <span className="sr-only">Search chats</span>
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by title"
                aria-label="search chats"
                className={inputClass}
              />
            </label>
            <p aria-live="polite" className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {searching
                ? "Searching…"
                : `${sorted.length} ${sorted.length === 1 ? "chat" : "chats"}`}
            </p>
          </div>

          {error ? (
            <p
              role="alert"
              className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              Request failed. {error}
            </p>
          ) : null}

          {sorted.length === 0 ? (
            <div className="mt-8 flex flex-col items-start rounded-md bg-muted/50 px-5 py-8">
              <MessageSquare aria-hidden className="size-5 text-muted-foreground" />
              <h2 className="mt-4 text-base font-semibold">
                {query.trim() ? "No matching chats" : "No chats yet"}
              </h2>
              <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">
                {query.trim()
                  ? "Try a different title or clear the search."
                  : "Start a chat and it will appear here for you to revisit."}
              </p>
              {!query.trim() ? (
                <Link to="/" className="mt-4 text-sm font-medium text-primary hover:underline">
                  Start a new chat
                </Link>
              ) : null}
            </div>
          ) : (
            <div className="mt-8 space-y-8">
              {starred.length > 0 ? (
                <ChatGroup
                  title="Starred"
                  items={starred}
                  renamingId={renamingId}
                  onRename={onRename}
                  onCancelRename={() => setRenamingId(null)}
                  onToggleStar={onToggleStar}
                  onStartRename={setRenamingId}
                  onDelete={setPendingDelete}
                />
              ) : null}
              {recent.length > 0 ? (
                <ChatGroup
                  title="Recent"
                  items={recent}
                  renamingId={renamingId}
                  onRename={onRename}
                  onCancelRename={() => setRenamingId(null)}
                  onToggleStar={onToggleStar}
                  onStartRename={setRenamingId}
                  onDelete={setPendingDelete}
                />
              ) : null}
            </div>
          )}
        </section>
        <ConfirmModal
          open={pendingDelete !== null}
          onClose={() => setPendingDelete(null)}
          onConfirm={() => void onDelete()}
          title="Delete chat"
          description={`Permanently delete “${pendingDelete?.title ?? "New chat"}” and all of its messages? This cannot be undone.`}
          busy={deleting}
        />
      </div>
    </div>
  );
}

function ChatGroup({
  title,
  items,
  renamingId,
  onRename,
  onCancelRename,
  onToggleStar,
  onStartRename,
  onDelete,
}: {
  title: string;
  items: ConversationSummary[];
  renamingId: string | null;
  onRename: (id: string, title: string) => void;
  onCancelRename: () => void;
  onToggleStar: (chat: ConversationSummary) => void;
  onStartRename: (id: string) => void;
  onDelete: (chat: ConversationSummary) => void;
}) {
  return (
    <section aria-labelledby={`${title.toLowerCase()}-chats`}>
      <h2
        id={`${title.toLowerCase()}-chats`}
        className="mb-2 text-xs font-medium text-muted-foreground"
      >
        {title}
      </h2>
      <ul className="divide-y divide-border border-y border-border">
        {items.map((chat) => (
          <li key={chat.id}>
            {renamingId === chat.id ? (
              <RenameRow
                initialTitle={chat.title ?? ""}
                onSave={(nextTitle) => onRename(chat.id, nextTitle)}
                onCancel={onCancelRename}
              />
            ) : (
              <ChatRow
                chat={chat}
                onToggleStar={() => onToggleStar(chat)}
                onStartRename={() => onStartRename(chat.id)}
                onDelete={() => onDelete(chat)}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ChatRow({
  chat,
  onToggleStar,
  onStartRename,
  onDelete,
}: {
  chat: ConversationSummary;
  onToggleStar: () => void;
  onStartRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group flex min-h-14 items-center gap-2 transition-colors hover:bg-muted/60">
      <Link
        to={`/chat/${chat.id}`}
        className="flex min-w-0 flex-1 items-center gap-3 px-2 py-3 sm:px-3"
      >
        {chat.starred ? (
          <Star aria-label="starred" className="size-4 shrink-0 fill-primary text-primary" />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
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
        onDelete={onDelete}
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
  onDelete,
}: {
  starred: boolean;
  onToggleStar: () => void;
  onStartRename: () => void;
  onDelete: () => void;
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
          "mr-1 inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-100 transition hover:bg-accent hover:text-foreground active:scale-95 sm:size-9 sm:opacity-0 sm:focus-visible:opacity-100 sm:group-hover:opacity-100",
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
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onDelete();
                  setOpen(false);
                }}
                className={`${itemClass} text-destructive hover:bg-destructive/10`}
              >
                <Trash2 className="size-3.5" />
                Delete
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
    <div className="px-2 py-2 sm:px-3">
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
        className={inputClass}
      />
    </div>
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
  return <ErrorState section="chats" status={status} message={message} />;
}
