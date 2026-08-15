import { useNavigate } from "@remix-run/react";
import { ArrowRight, MessageCircle } from "lucide-react";
import { StatusBadge, type StatusTone } from "~/components/status-badge";
import { useCompanion } from "~/lib/companion-context";
import type { Task } from "~/lib/tasks";

const MAX_ROWS = 8;

function statusFor(task: Task): { label: string; tone: StatusTone } {
  if (task.blocking && task.status === "open") return { label: "Urgent", tone: "danger" };
  if (task.status === "claimed") return { label: "In progress", tone: "info" };
  if (task.status === "snoozed") return { label: "Snoozed", tone: "warning" };
  const at = task.dueAt ?? task.remindAt;
  if (at) {
    const date = new Date(at);
    if (!Number.isNaN(date.getTime())) {
      const overdue = date.getTime() < Date.now();
      return { label: `Due ${date.toLocaleDateString()}`, tone: overdue ? "danger" : "warning" };
    }
  }
  return { label: "To do", tone: "neutral" };
}

/** Glance list of open Tasks on the empty-chat surface; the full list lives in the Companion panel. */
export function TasksPreviewCard({
  tasks,
  onPick,
}: {
  tasks: Task[];
  onPick: (text: string) => void;
}) {
  const navigate = useNavigate();
  const { setOpen } = useCompanion();
  if (tasks.length === 0) return null;
  const rows = tasks.slice(0, MAX_ROWS);

  return (
    <section className="w-full rounded-md border border-border bg-card p-4 sm:p-5">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold text-foreground">
          My Tasks <span className="font-normal text-muted-foreground">{tasks.length}</span>
        </h2>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="shrink-0 text-xs font-medium text-primary hover:underline"
        >
          View all
        </button>
      </div>

      <ul className="mt-4 flex flex-col divide-y divide-border border-t border-border">
        {rows.map((task) => {
          const status = statusFor(task);
          return (
            <li key={task.id}>
              <button
                type="button"
                onClick={() => {
                  if (task.action.kind === "link") navigate(task.action.href);
                  else if (task.action.kind === "chat") onPick(task.action.prompt);
                  else setOpen(true);
                }}
                className="group -mx-4 flex w-[calc(100%+2rem)] items-center gap-3 px-4 py-2.5 text-left transition hover:bg-accent sm:-mx-5 sm:w-[calc(100%+2.5rem)] sm:px-5"
              >
                <span
                  className={`size-1.5 shrink-0 rounded-full ${
                    status.tone === "danger"
                      ? "bg-status-danger"
                      : status.tone === "warning"
                        ? "bg-status-warning"
                        : status.tone === "info"
                          ? "bg-status-info"
                          : "bg-status-neutral"
                  }`}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {task.title}
                </span>
                <StatusBadge label={status.label} tone={status.tone} />
                {task.action.kind === "chat" ? (
                  <MessageCircle
                    className="size-4 shrink-0 text-muted-foreground transition group-hover:text-primary"
                    aria-hidden
                  />
                ) : (
                  <ArrowRight
                    className="size-4 shrink-0 text-muted-foreground transition group-hover:text-primary"
                    aria-hidden
                  />
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
