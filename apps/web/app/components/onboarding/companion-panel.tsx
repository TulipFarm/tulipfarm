import { useLocation, useNavigate } from "@remix-run/react";
import { useId, useRef, useState } from "react";
import { isSetupTask } from "~/components/chat/task-presentation";
import { ArrowRight, Check, MessageCircle, X } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import { Tooltip } from "~/components/ui/tooltip";
import { ApiError } from "~/lib/api";
import { useCompanion } from "~/lib/companion-context";
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
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (busy) return;
    if (!trimmed) {
      setError("Enter an answer to continue.");
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await answerTask(task.id, trimmed);
      setSaved(true);
      onAnswered();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that, try again.");
      setBusy(false);
    }
  }

  if (saved) {
    return (
      <div>
        <p className="text-sm font-medium text-foreground">{task.title}</p>
        <p role="status" className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Check className="size-4" aria-hidden />
          Saved
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-foreground">
        {task.title}
      </label>
      {action.hint ? (
        <p id={`${inputId}-hint`} className="text-sm text-muted-foreground">
          {action.hint}
        </p>
      ) : null}
      <div className="flex gap-1.5">
        <Input
          ref={inputRef}
          id={inputId}
          name={action.field}
          autoComplete={action.field === "businessName" ? "organization" : undefined}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            error ? `${inputId}-error` : action.hint ? `${inputId}-hint` : undefined
          }
          className="min-w-0 flex-1"
        />
        <Button type="submit" variant="outline" disabled={busy} className="shrink-0">
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
      {error ? (
        <p id={`${inputId}-error`} role="alert" className="text-sm text-destructive">
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
  const { pathname } = useLocation();
  const { requestChatDraft } = useCompanion();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function acknowledge() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await completeTask(task.id);
      onAnswered();
    } catch {
      setError("Couldn't complete that step. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex items-start gap-2 py-3">
      <div className="min-w-0 flex-1 break-words">
        {task.action.kind === "answer" ? (
          <AnswerTask task={task} action={task.action} onAnswered={onAnswered} />
        ) : (
          <>
            <p className="text-sm font-medium text-foreground">{task.title}</p>
            {task.detail ? (
              <p className="mt-1 text-sm text-muted-foreground">{task.detail}</p>
            ) : null}
            {task.action.kind === "ack" ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void acknowledge()}
                className="mt-2"
              >
                <Check className="size-3.5 text-primary" aria-hidden />
                Got it
              </Button>
            ) : task.action.kind === "link" ? (
              <Button asChild variant="outline" className="mt-2">
                <Link to={task.action.href} onClick={onClose}>
                  <ArrowRight className="size-4" aria-hidden />
                  {isSetupTask(task) ? "Connect model" : "Open"}
                </Link>
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  const action = task.action;
                  if (action.kind === "chat") {
                    // Prefill through shared state, not a `?draft=` URL: the Companion is mounted
                    // globally and must also work from routes other than "/", and a raw
                    // `history.replaceState` elsewhere desyncs the router if we round-trip through
                    // the URL (see the loader's `draft` comment in _app._index.tsx).
                    requestChatDraft(action.prompt);
                    if (pathname !== "/") navigate("/");
                  }
                  onClose();
                }}
                className="mt-2"
              >
                <MessageCircle className="size-4" aria-hidden />
                Ask in chat
              </Button>
            )}
            {error ? (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </>
        )}
      </div>
      <Tooltip content={`Dismiss "${task.title}"`}>
        <button
          type="button"
          onClick={() => onDismiss(task.id)}
          aria-label={`Dismiss "${task.title}"`}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent sm:size-7"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </Tooltip>
    </li>
  );
}

export function CompanionPanel({
  tasks,
  loading,
  error,
  onDismiss,
  onAnswered,
  onClose,
}: {
  tasks: Task[];
  loading: boolean;
  error?: string | null;
  onDismiss: (id: string) => void;
  onAnswered: () => void;
  onClose: () => void;
}) {
  if (loading && tasks.length === 0) {
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Loading next steps…
      </p>
    );
  }
  if (tasks.length === 0 && !error) {
    return <p className="p-4 text-sm text-muted-foreground">You're all caught up.</p>;
  }

  const setup = tasks.filter(isSetupTask);
  const other = tasks.filter((task) => !isSetupTask(task));

  return (
    <div className="flex flex-col gap-4 p-4">
      {error ? (
        <div role="alert" className="text-sm">
          <p className="text-destructive">{error}</p>
          <Button variant="outline" onClick={onAnswered} className="mt-2">
            Try again
          </Button>
        </div>
      ) : null}
      {[
        { label: "Get set up", items: setup },
        { label: "Next steps", items: other },
      ].map(({ label, items }) =>
        items.length > 0 ? (
          <section key={label} aria-label={label}>
            <h2 className="text-sm font-semibold text-foreground">{label}</h2>
            {label === "Get set up" ? (
              <p className="mt-1 text-sm text-muted-foreground">
                A few details to help your agents start.
              </p>
            ) : null}
            <ul className="mt-1 flex flex-col divide-y divide-border">
              {items.map((task) => (
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
        ) : null
      )}
    </div>
  );
}
