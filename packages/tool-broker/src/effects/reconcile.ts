import type { ToolCatalog } from "../catalog";
import type { ToolIntent } from "../intent";
import type { EffectStore } from "./store";

export interface ToolReconciliationRequest {
  readonly intent: ToolIntent;
  readonly idempotencyKey: string;
  readonly operation: string;
}

export type ToolReconciliationOutcome =
  | { readonly outcome: "confirmed"; readonly evidenceRef: string }
  | { readonly outcome: "not_applied"; readonly evidenceRef: string }
  | { readonly outcome: "ambiguous"; readonly evidenceRef: string };

export interface ToolReconciliationAdapter {
  reconcile(request: ToolReconciliationRequest): Promise<ToolReconciliationOutcome>;
}

export type ReconciliationResult =
  | { readonly outcome: "confirmed"; readonly evidenceRef: string }
  | { readonly outcome: "not_applied"; readonly evidenceRef: string }
  | {
      readonly outcome: "attention_required";
      readonly reason: "still_ambiguous" | "lookup_unavailable" | "lookup_failed";
      readonly evidenceRef?: string;
    };

export interface EffectReconcilerDeps {
  readonly store: EffectStore;
  readonly catalog: ToolCatalog;
  readonly adapters: ReadonlyMap<string, ToolReconciliationAdapter>;
  readonly now?: () => string;
}

export class EffectReconciler {
  private readonly now: () => string;

  constructor(private readonly deps: EffectReconcilerDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async reconcile(businessId: string, effectId: string): Promise<ReconciliationResult> {
    const effect = await this.deps.store.get(businessId, effectId);
    if (effect === undefined) {
      return { outcome: "attention_required", reason: "lookup_unavailable" };
    }
    const contract = this.deps.catalog.get(effect.intent.toolId, effect.intent.toolVersion);
    const operation = contract?.compensation?.reconciliation;
    const adapter =
      contract === undefined ? undefined : this.deps.adapters.get(contract.adapter.ref);
    if (operation === undefined || adapter === undefined) {
      await this.requireAttention(businessId, effectId);
      return { outcome: "attention_required", reason: "lookup_unavailable" };
    }

    let result: ToolReconciliationOutcome;
    try {
      result = await adapter.reconcile({
        intent: effect.intent,
        idempotencyKey: effect.idempotencyKey,
        operation,
      });
    } catch {
      await this.requireAttention(businessId, effectId);
      return { outcome: "attention_required", reason: "lookup_failed" };
    }

    if (result.outcome === "confirmed") {
      await this.deps.store.transition({
        businessId,
        effectId,
        expectedStates: ["ambiguous", "reconciliation_required"],
        state: "confirmed",
        updatedAt: this.now(),
      });
      return result;
    }
    if (result.outcome === "not_applied") {
      await this.deps.store.transition({
        businessId,
        effectId,
        expectedStates: ["ambiguous", "reconciliation_required"],
        state: "failed",
        updatedAt: this.now(),
      });
      return result;
    }
    await this.requireAttention(businessId, effectId);
    return {
      outcome: "attention_required",
      reason: "still_ambiguous",
      evidenceRef: result.evidenceRef,
    };
  }

  private async requireAttention(businessId: string, effectId: string): Promise<void> {
    await this.deps.store.transition({
      businessId,
      effectId,
      expectedStates: ["ambiguous", "reconciliation_required"],
      state: "reconciliation_required",
      updatedAt: this.now(),
    });
  }
}
