import {
  type BudgetExhaustionPolicy,
  type ResolvedLimits,
  RunBudgetManager,
  type RunBudgetStore,
  resolveModelProfileBudgetLimits,
  type ScopedLimits,
} from "@tulipfarm/run-kernel";
import type { ModelProfileSpec, RunEventPayloads } from "@tulipfarm/schema";

export const MODEL_BUDGET_EXHAUSTION_POLICY: BudgetExhaustionPolicy = "failure_path";

type ModelRoutedSelectedPayload = Extract<
  RunEventPayloads["model.routed"],
  { readonly outcome: "selected" }
>;

export type ModelBudgetEvidence = NonNullable<ModelRoutedSelectedPayload["budgetLimits"]>;

export function modelBudgetEvidence(limits: ResolvedLimits): ModelBudgetEvidence | undefined {
  return limits.tokens === undefined && limits.costMicros === undefined
    ? undefined
    : {
        ...(limits.tokens === undefined ? {} : { tokens: limits.tokens }),
        ...(limits.costMicros === undefined ? {} : { costMicros: limits.costMicros }),
      };
}

export async function openModelProfileRunBudget(input: {
  readonly budgets: RunBudgetStore;
  readonly businessId: string;
  readonly runId: string;
  readonly profile: Pick<ModelProfileSpec, "budgets">;
  /**
   * Broader ceilings this Run already operates under — today the authored Routine's `limits`.
   * They are resolved in the same narrowest-wins pass as the profile's own budgets, so the ledger
   * is opened from one ceiling per key rather than from two sources that could disagree.
   */
  readonly scoped?: readonly ScopedLimits[];
}): Promise<ModelBudgetEvidence | undefined> {
  const limits = resolveModelProfileBudgetLimits(input.profile, input.scoped ?? []);
  const evidence = modelBudgetEvidence(limits);
  if (evidence === undefined) return undefined;
  await new RunBudgetManager(input.budgets).open({
    businessId: input.businessId,
    runId: input.runId,
    limits,
    exhaustionPolicy: MODEL_BUDGET_EXHAUSTION_POLICY,
  });
  return evidence;
}
