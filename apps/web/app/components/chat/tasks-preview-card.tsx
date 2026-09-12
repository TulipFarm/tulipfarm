import { ArrowRight, MessageCircle } from "~/components/icons";
import { CompanionPanel } from "~/components/onboarding/companion-panel";
import { StatusBadge, type StatusTone } from "~/components/status-badge";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { useCompanion } from "~/lib/companion-context";
import type { Task } from "~/lib/tasks";
import { isSetupTask } from "./task-presentation";

const MAX_ROWS = 3;

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
  const { setOpen, loading, error, refresh, dismiss } = useCompanion();
  const activeTasks = tasks.filter((task) => task.status === "open" || task.status === "claimed");
  const setup = activeTasks.filter(isSetupTask);
  const nextSteps = activeTasks.filter((task) => !isSetupTask(task));
  if (activeTasks.length === 0 && !loading && !error) return null;
  const rows = nextSteps.slice(0, MAX_ROWS);

  return (
    <div className="mt-6 w-full border-t border-border">
      {loading && activeTasks.length === 0 ? (
        <p role="status" className="py-4 text-sm text-muted-foreground">
          Loading next steps…
        </p>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
        >
          <p className="text-destructive">{error}</p>
          <Button variant="outline" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      ) : null}
      {setup.length > 0 ? (
        <CompanionPanel
          tasks={setup}
          loading={false}
          onDismiss={dismiss}
          onAnswered={refresh}
          onClose={() => {}}
        />
      ) : null}
      {rows.length > 0 ? (
        <section aria-label="Next steps" className="py-3">
          <div className="flex items-center justify-between gap-4 px-1">
            <h2 className="text-sm font-semibold text-foreground">Next steps</h2>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="min-h-11 shrink-0 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent sm:min-h-7"
            >
              View all
            </button>
          </div>

          <ul className="mt-1 flex flex-col">
            {rows.map((task) => {
              const status = statusFor(task);
              const content = (
                <>
                  <span className="min-w-0 flex-1 break-words text-sm font-medium text-foreground">
                    {task.title}
                  </span>
                  <span className="shrink-0">
                    <StatusBadge label={status.label} tone={status.tone} />
                  </span>
                  {task.action.kind === "chat" ? (
                    <MessageCircle className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  ) : (
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                </>
              );
              const className =
                "flex min-h-11 w-full items-center gap-2 rounded-md px-1 py-2 text-left transition-colors hover:bg-accent active:bg-accent";
              return (
                <li key={task.id}>
                  {task.action.kind === "link" ? (
                    <Link to={task.action.href} className={className}>
                      {content}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      className={className}
                      onClick={() => {
                        if (task.action.kind === "chat") onPick(task.action.prompt);
                        else setOpen(true);
                      }}
                    >
                      {content}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
