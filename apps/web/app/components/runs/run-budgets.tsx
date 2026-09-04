import type { RunBudget } from "~/lib/operations";
import { cn } from "~/lib/utils";

/** The three honest states of the ledger fetch — loading, failed, and loaded (possibly empty). */
export type RunBudgetsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; budgets: readonly RunBudget[] };

const POLICY_LABEL: Record<RunBudget["exhaustionPolicy"], string> = {
  failure_path: "Takes the declared failure path when spent",
  attention_required: "Parks for an operator when spent",
};

/** Consumption vs. ceiling, coloured by headroom: success → warning near the limit → danger spent. */
function Meter({ consumed, limit }: { consumed: number; limit: number }) {
  const fraction = limit === 0 ? 1 : Math.min(consumed / limit, 1);
  const pct = Math.round(fraction * 100);
  const exhausted = consumed >= limit;
  const fill = exhausted
    ? "bg-status-danger"
    : fraction >= 0.8
      ? "bg-status-warning"
      : "bg-status-success";
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn("h-full transition-[width] duration-200 motion-reduce:transition-none", fill)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function BudgetRow({ budget }: { budget: RunBudget }) {
  const exhausted = budget.consumed >= budget.limit;
  const remaining = Math.max(budget.limit - budget.consumed, 0);
  return (
    <li className={cn("grid gap-1.5 px-3 py-2.5", exhausted && "bg-status-danger/5")}>
      <div className="flex items-baseline justify-between gap-2">
        <code className="text-xs">{budget.key}</code>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {`${budget.consumed.toLocaleString("en-US")} / ${budget.limit.toLocaleString("en-US")}`}
        </span>
      </div>
      <Meter consumed={budget.consumed} limit={budget.limit} />
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{POLICY_LABEL[budget.exhaustionPolicy]}</span>
        {exhausted ? (
          <span className="font-medium text-status-danger">Exhausted</span>
        ) : (
          <span className="font-mono tabular-nums">{remaining.toLocaleString("en-US")} left</span>
        )}
      </div>
    </li>
  );
}

/**
 * The enforced per-Run budget ledger (`run_budgets`) rendered on the Run detail surface, so an
 * operator can answer "what did this Run cost?" from the same number the Worker enforced against.
 */
export function RunBudgets({ state }: { state: RunBudgetsState }) {
  return (
    <section className="border border-border bg-card">
      <h2 className="border-b border-border px-3 py-2 text-xs font-medium ">Budgets</h2>
      {state.status === "loading" ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">Loading budgets…</p>
      ) : state.status === "error" ? (
        <p className="px-3 py-3 text-xs text-status-danger">
          Couldn't load budgets: {state.message}
        </p>
      ) : state.budgets.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">
          No budget ceilings recorded. This Run is unbounded.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {state.budgets.map((budget) => (
            <BudgetRow key={budget.key} budget={budget} />
          ))}
        </ul>
      )}
    </section>
  );
}
