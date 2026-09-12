import { ArrowRight, MessageCircle } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { useApprovals } from "~/lib/approvals-context";
import { useConversations } from "~/lib/conversations-context";
import type { Task } from "~/lib/tasks";
import { TasksPreviewCard } from "./tasks-preview-card";

/** Reuses the shell's authorized lists; this view starts no requests of its own. */
export function ChatHomeWork({ tasks, onPick }: { tasks: Task[]; onPick: (text: string) => void }) {
  const approvals = useApprovals();
  const chats = useConversations();
  const recent = [...chats.conversations]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 3);

  return (
    <>
      {approvals.loading || approvals.error || approvals.approvals.length > 0 ? (
        <section aria-label="Pending approvals" className="mt-6 border-t border-border pt-3">
          {approvals.error ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <p role="status" className="text-muted-foreground">
                Couldn't check pending approvals.
              </p>
              <Button variant="outline" onClick={() => void approvals.refresh()}>
                Retry approvals
              </Button>
            </div>
          ) : approvals.loading ? (
            <p role="status" className="py-2 text-sm text-muted-foreground">
              Checking pending approvals…
            </p>
          ) : (
            <Link
              to="/inbox"
              className="flex min-h-11 items-center justify-between gap-3 rounded-md px-1 py-2 text-sm transition-colors hover:bg-accent active:bg-accent"
            >
              <span className="font-medium text-foreground">
                {approvals.approvals.length}{" "}
                {approvals.approvals.length === 1 ? "approval" : "approvals"} waiting for review
              </span>
              <ArrowRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          )}
        </section>
      ) : null}

      <TasksPreviewCard tasks={tasks} onPick={onPick} />

      {chats.loading || chats.error || recent.length > 0 ? (
        <section aria-label="Recent chats" className="mt-6 border-t border-border pt-3">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-sm font-semibold text-foreground">Recent chats</h2>
            <Link
              to="/chats"
              className="inline-flex min-h-11 items-center rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent sm:min-h-7"
            >
              All chats
            </Link>
          </div>
          {chats.error ? (
            <div className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <p role="status" className="text-muted-foreground">
                {recent.length > 0
                  ? "Couldn't refresh recent chats. Showing the last list."
                  : "Couldn't load recent chats."}
              </p>
              <Button variant="outline" onClick={() => void chats.refresh()}>
                Retry recent chats
              </Button>
            </div>
          ) : chats.loading && recent.length === 0 ? (
            <p role="status" className="py-2 text-sm text-muted-foreground">
              Loading recent chats…
            </p>
          ) : null}
          <ul className="flex flex-col">
            {recent.map((chat) => (
              <li key={chat.id}>
                <Link
                  to={`/chat/${encodeURIComponent(chat.id)}`}
                  className="flex min-h-11 items-center gap-3 rounded-md px-1 py-2 transition-colors hover:bg-accent active:bg-accent"
                >
                  <MessageCircle aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {chat.title || "Untitled chat"}
                  </span>
                  <time
                    dateTime={chat.updatedAt}
                    className="shrink-0 text-xs text-muted-foreground"
                  >
                    {new Date(chat.updatedAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </time>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
