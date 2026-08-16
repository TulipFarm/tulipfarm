import type { LimitKey, LimitSet, ResolvedLimits, ScopedLimits } from "../limits";
import type { CompiledBounds, CompiledRoutine } from "./compiler";

/**
 * Where an authored `limits` key is actually enforced.
 *
 * Two enforcement surfaces already exist and neither was reading `limits`: a State's structural
 * `bounds`, checked by the `foreach`/`parallel`/`repeat_until` processors, and the Run budget
 * ledger, charged by the Agent loop. Rather than open a third ceiling on quantities those two
 * already bound — two ceilings that can disagree is worse than one that is missing — each
 * authored key is routed into whichever of the two already meters it, and the keys neither meters
 * stay unenforced instead of pretending.
 */

/**
 * Authored limits that name the same quantity a State bound names. The limit does not add a
 * second check; it narrows the bound the processors already read, so there stays exactly one
 * ceiling per quantity. A key whose bound is absent supplies it, which is why `foreach`,
 * `parallel` and `repeat_until` can now be bounded from `limits` alone.
 */
const BOUND_BY_LIMIT_KEY = {
  fanOut: "maxItems",
  parallelism: "maxConcurrency",
  iterations: "maxIterations",
  wallTimeMs: "maxDurationMs",
} as const satisfies Partial<Record<LimitKey, keyof CompiledBounds>>;

/**
 * Limit keys the Run budget ledger charges. The Agent loop debits exactly these two, so they are
 * the only keys for which opening a budget row creates a ceiling that anything can reach; a row
 * for an unmetered key would read as a live control and stop nothing.
 */
const LEDGER_METERED_LIMIT_KEYS: readonly LimitKey[] = ["tokens", "costMicros"];

/**
 * Narrows a State's structural bounds by the resolved limit ceilings.
 *
 * Applied at compile time so the result is a pure function of the authored Routine and is
 * therefore identical on every replay of the same Run.
 */
export function narrowBoundsByLimits(
  bounds: CompiledBounds,
  resolved: ResolvedLimits
): CompiledBounds {
  const narrowed: { -readonly [K in keyof CompiledBounds]: number | null } = { ...bounds };
  const entries = Object.entries(BOUND_BY_LIMIT_KEY) as readonly [LimitKey, keyof CompiledBounds][];
  for (const [limitKey, boundKey] of entries) {
    const ceiling = resolved[limitKey];
    if (ceiling === undefined) continue;
    const current = bounds[boundKey];
    if (current === null || ceiling.value < current) narrowed[boundKey] = ceiling.value;
  }
  return narrowed;
}

/**
 * The Routine-scope ceilings the Run budget ledger can hold, or `undefined` when the Routine
 * declared none it meters.
 *
 * Routine scope is the only authored scope whose grain matches the ledger's: a `run_budgets` row
 * is per Run and write-once, and a Routine's `limits` block bounds exactly that Run. A State-scope
 * ceiling folded into the same row would leak onto every other State of the Run, so it is left out
 * rather than enforced wrongly.
 */
export function routineBudgetScopedLimits(
  routine: Pick<CompiledRoutine, "limits">
): ScopedLimits | undefined {
  const limits: LimitSet = {};
  for (const key of LEDGER_METERED_LIMIT_KEYS) {
    const value = routine.limits[key];
    if (value !== undefined) limits[key] = value;
  }
  return Object.keys(limits).length === 0 ? undefined : { scope: "routine", limits };
}
