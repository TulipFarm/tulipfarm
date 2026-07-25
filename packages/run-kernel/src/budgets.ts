import type { LimitKey, ResolvedLimits } from "./limits";

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
  /** Present only when the budget is exhausted. */
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

/** Narrow surface `RunBudgetManager` needs; `@tulipfarm/storage`'s `BudgetStore` satisfies it. */
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
 * Durable per-Run budget ledger over narrowest-wins limits (SPEC §9.1). Consumption is committed
 * before the work it pays for, so a crash or a duplicate retry can never spend a budget twice.
 * Ceilings are write-once: re-opening a Run's budget after a restart keeps the original bound, so
 * neither a restart nor an Agent proposal can raise a limit.
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

  /** Charges a budget. Exhaustion is a typed decision, not an exception. */
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
