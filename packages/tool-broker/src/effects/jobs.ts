import type { EffectReconciler, ReconciliationResult } from "./reconcile";
import type { EffectStore } from "./store";

export interface ReconciliationJobResult {
  readonly effectId: string;
  readonly result: ReconciliationResult;
}

export async function runReconciliationJobs(
  store: EffectStore,
  reconciler: EffectReconciler,
  businessId: string,
  limit: number
): Promise<ReconciliationJobResult[]> {
  const candidates = (await store.list(businessId))
    .filter((effect) => effect.state === "ambiguous" || effect.state === "reconciliation_required")
    .slice(0, Math.max(0, limit));
  const results: ReconciliationJobResult[] = [];
  for (const effect of candidates) {
    results.push({
      effectId: effect.effectId,
      result: await reconciler.reconcile(businessId, effect.effectId),
    });
  }
  return results;
}
