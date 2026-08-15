import { useNavigate } from "@remix-run/react";
import { ArrowRight, Check, MessageCircle, X } from "lucide-react";
import { useState } from "react";
import { ApiError } from "~/lib/api";
import { answerTask, completeTask, type Task, type TaskAction } from "~/lib/tasks";

/** Inline form for an `answer`-action Task — answers land in the configured sink, no chat round-trip. */
function AnswerTask({
  task,
  action,
  onAnswered,
}: {
  task: Task;
  action: Extract<TaskAction, { kind: "answer" }>;
  onAnswered: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await answerTask(task.id, trimmed);
      onAnswered();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that — try again.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <label htmlFor={`task-${task.id}`} className="text-sm font-medium text-foreground">
        {task.title}
      </label>
      {action.hint ? <p className="text-xs text-muted-foreground">{action.hint}</p> : null}
      <div className="flex gap-1.5">
        <input
          id={`task-${task.id}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
          className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25"
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="inline-flex h-9 shrink-0 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
        >
          Save
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function TaskRow({
  task,
  onDismiss,
  onAnswered,
  onClose,
}: {
  task: Task;
  onDismiss: (id: string) => void;
  onAnswered: () => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function acknowledge() {
    if (busy) return;
    setBusy(true);
    try {
      await completeTask(task.id);
      onAnswered();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex items-start gap-2 rounded-md border border-border bg-background p-3">
      <div className="min-w-0 flex-1">
        {task.action.kind === "answer" ? (
          <AnswerTask task={task} action={task.action} onAnswered={onAnswered} />
        ) : (
          <>
            <p className="text-sm font-medium text-foreground">{task.title}</p>
            {task.detail ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{task.detail}</p>
            ) : null}
            {task.action.kind === "ack" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void acknowledge()}
                className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs font-medium text-muted-foreground transition hover:border-primary/60 hover:bg-accent hover:text-foreground active:translate-y-px disabled:opacity-40"
              >
                <Check className="size-3.5 text-primary" aria-hidden />
                Got it
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  const action = task.action;
                  if (action.kind === "link") {
                    navigate(action.href);
                  } else if (action.kind === "chat") {
                    navigate(`/?draft=${encodeURIComponent(action.prompt)}`);
                  }
                  onClose();
                }}
                className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs font-medium text-muted-foreground transition hover:border-primary/60 hover:bg-accent hover:text-foreground active:translate-y-px"
              >
                {task.action.kind === "chat" ? (
                  <MessageCircle className="size-3.5 text-primary" aria-hidden />
                ) : (
                  <ArrowRight className="size-3.5 text-primary" aria-hidden />
                )}
                {task.action.kind === "chat" ? "Ask in chat" : "Go"}
              </button>
            )}
          </>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(task.id)}
        aria-label={`Dismiss "${task.title}"`}
        className="-mr-1 -mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </li>
  );
}

export function CompanionPanel({
  tasks,
  loading,
  onDismiss,
  onAnswered,
  onClose,
}: {
  tasks: Task[];
  loading: boolean;
  onDismiss: (id: string) => void;
  onAnswered: () => void;
  onClose: () => void;
}) {
  if (loading && tasks.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  }
  if (tasks.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">You're all caught up.</p>;
  }

  // Ranking already suppresses non-blocking Tasks server-side whenever a blocking one exists, so
  // the list here is always homogeneous — one label for the whole batch, no client-side re-sort.
  const label = tasks[0].blocking ? "Get set up" : "For you";

  return (
    <div className="flex flex-col gap-4 p-4">
      <section>
        <p className="mb-2 text-xs font-medium text-muted-foreground">{label}</p>
        <ul className="flex flex-col gap-2">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              onDismiss={onDismiss}
              onAnswered={onAnswered}
              onClose={onClose}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}
