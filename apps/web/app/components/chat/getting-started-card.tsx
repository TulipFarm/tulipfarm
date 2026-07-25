import { Check, Circle, Lock, X } from "lucide-react";
import type { OnboardingChecklist } from "~/lib/onboarding";

/*
 * "Getting started" checklist card on the chat welcome (ONB-V1). Steps are the core build blocks
 * with status auto-derived server-side; `todo` steps and the "recommended next" items seed a guided
 * prompt through the built-in assistant flow the suggestion chips use (via `onPick`).
 * Routine/integration render as non-actionable "coming soon". Flat/hairline aesthetic,
 * no shadows; ruby is reserved for hover affordances only.
 */

const chip =
  "flex items-center gap-2 rounded-sm border border-border bg-secondary px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground cursor-pointer";

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
    <div className="w-full max-w-3xl rounded-sm border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <p className="text-[0.625rem] font-medium uppercase tracking-[0.2em] text-muted-foreground">
          Getting started · {doneCount}/{total}
        </p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss getting started"
          className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>

      <ul className="flex flex-col gap-1.5 px-4 py-3">
        {steps.map((step) => {
          if (step.status === "done") {
            return (
              <li key={step.id} className="flex items-center gap-2 px-0.5 py-1 text-xs">
                <Check className="size-3.5 text-primary" aria-hidden />
                <span className="text-muted-foreground line-through">{step.label}</span>
              </li>
            );
          }
          if (step.status === "coming-soon") {
            return (
              <li
                key={step.id}
                className="flex items-center gap-2 px-0.5 py-1 text-xs text-muted-foreground/70"
              >
                <Lock className="size-3.5" aria-hidden />
                <span>{step.label}</span>
                <span className="rounded-sm border border-border px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wider">
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
                <Circle className="size-3.5" aria-hidden />
                <span>{step.label}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {recommendations.length > 0 ? (
        <div className="border-t border-border px-4 py-3">
          <p className="mb-2 text-[0.625rem] font-medium uppercase tracking-[0.2em] text-muted-foreground">
            Recommended next
          </p>
          <div className="flex flex-wrap gap-2">
            {recommendations.map((rec) => (
              <button
                key={rec.id}
                type="button"
                onClick={() => onPick(rec.prompt)}
                className={chip}
              >
                {rec.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
