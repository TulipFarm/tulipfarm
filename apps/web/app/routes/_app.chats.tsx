import { type MetaFunction, useLoaderData, useRouteError } from "@remix-run/react";
import { MessageSquare, Plus, Search, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  ChatActionsMenu,
  ChatTitleInput,
  DeleteChatModal,
  useChatTitleActions,
} from "~/components/chat/chat-title-actions";
import { PageShell } from "~/components/page-shell";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { ApiError } from "~/lib/api";
import {
  type ConversationSummary,
  listConversations,
  setConversationStarred,
} from "~/lib/conversations";
import { useConversations } from "~/lib/conversations-context";

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
  const [searching, setSearching] = useState(false);
  const actions = useChatTitleActions({
    onRenamed: (updated) =>
      setItems((prev) => prev.map((c) => (c.id === updated.id ? updated : c))),
    onDeleted: (id) => setItems((prev) => prev.filter((chat) => chat.id !== id)),
  });

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

  // Search and star failures render at page level; rename/delete failures belong to the hook, and a
  // delete failure renders inside its own dialog rather than behind the backdrop.
  const pageError = error ?? (actions.pendingDelete ? null : actions.error);

  // Starred chats pinned to the top; recency order (server-sorted) preserved within each group by the
  // stable sort.
  const sorted = [...items].sort((a, b) => Number(b.starred) - Number(a.starred));
  const starred = sorted.filter((chat) => chat.starred);
  const recent = sorted.filter((chat) => !chat.starred);

  return (
    <PageShell
      title="Your chats"
      description="Return to previous work, pin important chats, or rename them for easier scanning."
      actions={
        <Button asChild>
          <Link to="/">
            <Plus aria-hidden />
            New chat
          </Link>
        </Button>
      }
    >
      <section aria-label="Chat history">
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

        {pageError ? (
          <p
            role="alert"
            className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            Request failed. {pageError}
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
                actions={actions}
                onToggleStar={onToggleStar}
              />
            ) : null}
            {recent.length > 0 ? (
              <ChatGroup
                title="Recent"
                items={recent}
                actions={actions}
                onToggleStar={onToggleStar}
              />
            ) : null}
          </div>
        )}
      </section>
      <DeleteChatModal
        open={actions.pendingDelete !== null}
        onClose={actions.cancelDelete}
        onConfirm={actions.confirmDelete}
        title={actions.pendingDelete?.title ?? null}
        busy={actions.deleting}
        error={actions.error}
      />
    </PageShell>
  );
}

function ChatGroup({
  title,
  items,
  actions,
  onToggleStar,
}: {
  title: string;
  items: ConversationSummary[];
  actions: ReturnType<typeof useChatTitleActions>;
  onToggleStar: (chat: ConversationSummary) => void;
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
            {actions.renamingId === chat.id ? (
              <div className="px-2 py-2 sm:px-3">
                <ChatTitleInput
                  initialTitle={chat.title ?? ""}
                  onSave={(nextTitle) => actions.submitRename(chat.id, nextTitle)}
                  onCancel={actions.cancelRename}
                />
              </div>
            ) : (
              <ChatRow
                chat={chat}
                onToggleStar={() => onToggleStar(chat)}
                onStartRename={() => actions.startRename(chat.id)}
                onDelete={() => actions.requestDelete(chat)}
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
      <ChatActionsMenu
        starred={chat.starred}
        onToggleStar={onToggleStar}
        onStartRename={onStartRename}
        onDelete={onDelete}
        triggerClassName="mr-1"
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
