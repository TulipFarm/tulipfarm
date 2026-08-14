import type { ModelProfileSpec } from "@tulipfarm/schema";
import {
  LimitError,
  type LimitKey,
  type ResolvedLimits,
  resolveLimits,
  type ScopedLimits,
} from "./limits";

/**
 * What a Run does when a budget is exhausted (SPEC §9.1). Exhaustion is never raised away: it
 * takes the declared failure path or parks the Run in `attention_required` for an operator.
 */
export type BudgetExhaustionPolicy = "failure_path" | "attention_required";

export type BudgetConsumeOutcome = "allowed" | "exhausted" | "unbounded";

export interface BudgetConsumeResult {
  readonly outcome: BudgetConsumeOutcome;
  readonly consumed: number;
  readonly limit: number | null;
  readonly exhaustionPolicy: BudgetExhaustionPolicy | null;
}

export interface OpenBudgetInput {
  readonly businessId: string;
  readonly runId: string;
  readonly limits: ResolvedLimits;
  readonly exhaustionPolicy: BudgetExhaustionPolicy;
}

export interface ConsumeBudgetInput {
  readonly businessId: string;
  readonly runId: string;
  readonly key: LimitKey;
  readonly amount: number;
}

export interface BudgetDecision {
  readonly outcome: BudgetConsumeOutcome;
  readonly key: LimitKey;
  readonly consumed: number;
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly disposition?: BudgetExhaustionPolicy;
}

export type BudgetErrorCode = "invalid_consumption";

/** Budget denial carrying the reason code and limit key only — never a Run payload. */
export class BudgetError extends Error {
  readonly name = "BudgetError";

  constructor(
    readonly code: BudgetErrorCode,
    readonly key = ""
  ) {
    super(`${code}${key ? `:${key}` : ""}`);
  }
}

const MICROS_PER_USD = 1_000_000;

/** Positive fractional USD ceilings round up to at least one micro-USD, never zero. */
export function usdToCostMicros(maxCostUsd: number): number {
  if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
    throw new LimitError("invalid_limit", "costMicros");
  }
  const micros = maxCostUsd === 0 ? 0 : Math.max(1, Math.ceil(maxCostUsd * MICROS_PER_USD));
  if (!Number.isSafeInteger(micros) || micros < 0) {
    throw new LimitError("invalid_limit", "costMicros");
  }
  return micros;
}

export function modelProfileBudgetScopedLimits(
  profile: Pick<ModelProfileSpec, "budgets">
): ScopedLimits | undefined {
  const limits: ScopedLimits["limits"] = {};
  if (profile.budgets?.maxTokens !== undefined) limits.tokens = profile.budgets.maxTokens;
  if (profile.budgets?.maxCostUsd !== undefined) {
    limits.costMicros = usdToCostMicros(profile.budgets.maxCostUsd);
  }
  return Object.keys(limits).length === 0 ? undefined : { scope: "model", limits };
}

/**
 * Resolves a ModelProfile's execution budgets with any broader scopes. Missing budgets contribute
 * nothing, so an unbounded profile stays unbounded rather than receiving an invented default.
 */
export function resolveModelProfileBudgetLimits(
  profile: Pick<ModelProfileSpec, "budgets">,
  scoped: readonly ScopedLimits[] = []
): ResolvedLimits {
  const modelLimits = modelProfileBudgetScopedLimits(profile);
  return resolveLimits(modelLimits === undefined ? scoped : [...scoped, modelLimits]);
}

export interface RunBudgetStore {
  open(input: {
    businessId: string;
    runId: string;
    limits: Readonly<Record<string, number>>;
    exhaustionPolicy: BudgetExhaustionPolicy;
  }): Promise<void>;
  consume(
    businessId: string,
    runId: string,
    key: string,
    amount: number
  ): Promise<BudgetConsumeResult>;
}

/**
 * Durable per-Run ledger: commit spend before work, and keep write-once ceilings on restart.
 */
export class RunBudgetManager {
  constructor(private readonly store: RunBudgetStore) {}

  async open(input: OpenBudgetInput): Promise<void> {
    const limits: Record<string, number> = {};
    for (const [key, resolved] of Object.entries(input.limits)) {
      if (resolved !== undefined) limits[key] = resolved.value;
    }
    await this.store.open({
      businessId: input.businessId,
      runId: input.runId,
      limits,
      exhaustionPolicy: input.exhaustionPolicy,
    });
  }

  async consume(input: ConsumeBudgetInput): Promise<BudgetDecision> {
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
      throw new BudgetError("invalid_consumption", input.key);
    }
    const result = await this.store.consume(input.businessId, input.runId, input.key, input.amount);
    const remaining = result.limit === null ? null : result.limit - result.consumed;
    if (result.outcome === "exhausted") {
      return {
        outcome: "exhausted",
        key: input.key,
        consumed: result.consumed,
        limit: result.limit,
        remaining,
        disposition: result.exhaustionPolicy ?? "failure_path",
      };
    }
    return {
      outcome: result.outcome,
      key: input.key,
      consumed: result.consumed,
      limit: result.limit,
      remaining,
    };
  }
}
