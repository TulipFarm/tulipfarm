import type { LimitKey, LimitSet, ResolvedLimits, ScopedLimits } from "../limits";
import type { CompiledBounds, CompiledRetryPolicy, CompiledRoutine } from "./compiler";

/**
 * Where an authored `limits` key is actually enforced.
 *
 * Three enforcement surfaces already exist and none was reading `limits`: a State's structural
 * `bounds`, checked by the `foreach`/`parallel`/`repeat_until` processors; the Run budget ledger,
 * charged by the Agent loop; and the State `retry` policy, spent against the durable attempt
 * counter by the executor. Rather than open a fourth ceiling on quantities those already bound —
 * two ceilings that can disagree is worse than one that is missing — each authored key is routed
 * into whichever of the three already meters it.
 *
 * A key no surface meters is not accepted and left inert: it is absent from `LIMIT_KEYS` and from
 * the authored schema, so declaring it fails validation loudly instead of bounding nothing.
 */

/**
 * Authored limits that name the same quantity a State bound names. The limit does not add a
 * second check; it narrows the bound the processors already read, so there stays exactly one
 * ceiling per quantity. A key whose bound is absent supplies it, which is why `foreach`,
 * `parallel` and `repeat_until` can now be bounded from `limits` alone.
 */
export const BOUND_BY_LIMIT_KEY = {
  fanOut: "maxItems",
  parallelism: "maxConcurrency",
  iterations: "maxIterations",
  wallTimeMs: "maxDurationMs",
} as const satisfies Partial<Record<LimitKey, keyof CompiledBounds>>;

/** The enforcement surface that meters each limit key. */
export type LimitEnforcementSurface = "bounds" | "ledger" | "retry";

/**
 * Every limit key and the one surface that meters it.
 *
 * `satisfies Record<LimitKey, ...>` is the compile-time half of the L3-10 control: adding a key to
 * `LIMIT_KEYS` without naming where it is enforced stops this file compiling, and
 * `scripts/routine-limit-coverage.test.ts` checks the named surface actually carries it.
 */
export const ENFORCEMENT_SURFACE_BY_LIMIT_KEY = {
  fanOut: "bounds",
  parallelism: "bounds",
  iterations: "bounds",
  wallTimeMs: "bounds",
  tokens: "ledger",
  costMicros: "ledger",
  retries: "retry",
} as const satisfies Record<LimitKey, LimitEnforcementSurface>;

function limitKeysMeteredBy(surface: LimitEnforcementSurface): readonly LimitKey[] {
  const entries = Object.entries(ENFORCEMENT_SURFACE_BY_LIMIT_KEY) as readonly [
    LimitKey,
    LimitEnforcementSurface,
  ][];
  return entries.filter(([, declared]) => declared === surface).map(([key]) => key);
}

/**
 * Limit keys the Run budget ledger charges. The Agent loop debits exactly these, so they are the
 * only keys for which opening a budget row creates a ceiling that anything can reach; a row for an
 * unmetered key would read as a live control and stop nothing.
 */
export const LEDGER_METERED_LIMIT_KEYS: readonly LimitKey[] = limitKeysMeteredBy("ledger");

/**
 * Limit keys enforced against a State's `retry` policy, whose attempts the executor spends against
 * a durable per-occurrence counter.
 */
export const RETRY_METERED_LIMIT_KEYS: readonly LimitKey[] = limitKeysMeteredBy("retry");

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
 * Narrows a State's `retry` policy by the resolved `retries` ceiling.
 *
 * A State with no policy makes exactly one attempt, which is already under every ceiling, so a
 * limit never supplies a policy — it can only take attempts away, never grant them.
 */
export function narrowRetryByLimits(
  retry: CompiledRetryPolicy | null,
  resolved: ResolvedLimits
): CompiledRetryPolicy | null {
  if (retry === null) return retry;
  let maxAttempts = retry.maxAttempts;
  for (const key of RETRY_METERED_LIMIT_KEYS) {
    const ceiling = resolved[key];
    // A ceiling counts re-attempts, so it allows one first attempt plus that many more.
    if (ceiling !== undefined) maxAttempts = Math.min(maxAttempts, ceiling.value + 1);
  }
  return maxAttempts === retry.maxAttempts ? retry : { ...retry, maxAttempts };
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
