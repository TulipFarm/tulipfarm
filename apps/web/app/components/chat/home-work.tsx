import { ArrowRight } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { useApprovals } from "~/lib/approvals-context";
import type { Task } from "~/lib/tasks";
import { ChatHomeRuns } from "./home-runs";
import { TasksPreviewCard } from "./tasks-preview-card";

export function ChatHomeWork({ tasks, onPick }: { tasks: Task[]; onPick: (text: string) => void }) {
  const approvals = useApprovals();

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
      <ChatHomeRuns />
    </>
  );
}
