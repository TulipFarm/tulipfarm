import { usdToCostMicros } from "@tulipfarm/run-kernel";
import type { ModelUsage } from "../ports";

/** Run-budget accounting for one model call. Split from the loop so the loop stays readable. */

const TOKEN_BUDGET_KEY = "tokens";
const COST_BUDGET_KEY = "costMicros";

/** The slice of the loop's budget port this charging needs. */
export interface UsageBudgetPort {
  consume(input: { key: string; amount: number }): Promise<{ outcome: string }>;
}

/** Charges tokens and cost against the Run budget; shared by the success and failure paths. */
export async function chargeModelUsage(
  budget: UsageBudgetPort,
  usage: ModelUsage
): Promise<"ok" | "exhausted"> {
  const tokens = usage.inputTokens + usage.outputTokens;
  if (tokens > 0) {
    const tokenBudget = await budget.consume({ key: TOKEN_BUDGET_KEY, amount: tokens });
    if (tokenBudget.outcome === "exhausted") return "exhausted";
  }
  if (usage.costUsd !== undefined && usage.costUsd > 0) {
    const costBudget = await budget.consume({
      key: COST_BUDGET_KEY,
      amount: usdToCostMicros(usage.costUsd),
    });
    if (costBudget.outcome === "exhausted") return "exhausted";
  }
  return "ok";
}
