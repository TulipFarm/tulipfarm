import { ArrowRight, Check, Circle, Lock, X } from "lucide-react";
import type { OnboardingChecklist } from "~/lib/onboarding";

const chip =
  "flex min-h-11 w-full items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-left text-sm text-muted-foreground transition hover:border-primary/60 hover:bg-accent hover:text-foreground active:translate-y-px";

export function GettingStartedCard({
  checklist,
  onPick,
  onDismiss,
}: {
  checklist: OnboardingChecklist;
  onPick: (prompt: string) => void;
  onDismiss: () => void;
}) {
  const { steps, recommendations } = checklist;
  const doneCount = steps.filter((s) => s.status === "done").length;
  const total = steps.filter((s) => s.status !== "coming-soon").length;

  return (
    <section className="w-full rounded-md border border-border bg-card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Getting started</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {doneCount} of {total} setup steps complete
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss getting started"
          className="-mr-2 -mt-2 inline-flex size-11 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-95"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <div className="mt-3 h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div
          className="h-full rounded-full bg-status-success transition-[width]"
          style={{ width: `${total > 0 ? (doneCount / total) * 100 : 0}%` }}
        />
      </div>

      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {steps.map((step) => {
          if (step.status === "done") {
            return (
              <li
                key={step.id}
                className="flex min-h-11 items-center gap-2 rounded-md bg-muted/60 px-3 py-2 text-sm"
              >
                <Check className="size-4 text-status-success" aria-hidden />
                <span className="text-muted-foreground line-through">{step.label}</span>
              </li>
            );
          }
          if (step.status === "coming-soon") {
            return (
              <li
                key={step.id}
                className="flex min-h-11 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground"
              >
                <Lock className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">{step.label}</span>
                <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[0.6875rem]">
                  Coming soon
                </span>
              </li>
            );
          }
          return (
            <li key={step.id}>
              <button
                type="button"
                onClick={() => step.prompt && onPick(step.prompt)}
                className={chip}
              >
                <Circle className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">{step.label}</span>
                <ArrowRight className="size-4 shrink-0 text-primary" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>

      {recommendations.length > 0 ? (
        <div className="mt-4 border-t border-border pt-4">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Recommended next</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {recommendations.map((rec) => (
              <button
                key={rec.id}
                type="button"
                onClick={() => onPick(rec.prompt)}
                className={chip}
              >
                <span className="min-w-0 flex-1">{rec.label}</span>
                <ArrowRight className="size-4 shrink-0 text-primary" aria-hidden />
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
