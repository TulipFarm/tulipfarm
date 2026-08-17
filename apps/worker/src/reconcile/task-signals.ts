import type { TaskReconcileSignals } from "../internal/turn-host";
import type { TaskCheckSignals } from "./task-checks";

/** Reads `llmConfig()` shape well enough to tell "a provider chain is authored" without fully
 * validating it — the reconciler treats malformed config as "not configured" rather than throwing. */
function hasAnyProvider(llmConfig: unknown): boolean {
  if (llmConfig === undefined || llmConfig === null || typeof llmConfig !== "object") return false;
  const tiers = (llmConfig as { tiers?: unknown }).tiers;
  if (tiers === undefined || tiers === null || typeof tiers !== "object") return false;
  return Object.values(tiers as Record<string, unknown>).some((tier) => {
    const providers = (tier as { providers?: unknown } | undefined)?.providers;
    return Array.isArray(providers) && providers.length > 0;
  });
}

export interface TaskSignalsPort {
  llmConfig(): Promise<unknown>;
  taskReconcileSignals(): Promise<TaskReconcileSignals | undefined>;
}

/**
 * Gathers everything `evaluateTaskChecks` needs, from the only sources the Worker may legitimately
 * read (`apps/worker/AGENTS.md`): the API's existing `/api/v1/internal/*` boundary for signals
 * that live only in this app's stores (business profile), the same pattern the Worker already
 * uses for LLM config.
 */
export class TaskSignalsGatherer {
  constructor(private readonly internalApi: TaskSignalsPort) {}

  async gather(businessId: string): Promise<TaskCheckSignals> {
    const [llmConfig, apiSignals] = await Promise.all([
      this.internalApi.llmConfig(),
      this.internalApi.taskReconcileSignals(),
    ]);

    return {
      hasProviderKey: hasAnyProvider(llmConfig),
      businessName: apiSignals?.businessName,
      // Absent signals mean the API could not be read; treating that as "setup still running"
      // keeps the reconciler from opening wizard-owned Tasks on a guess.
      setupComplete: apiSignals?.setupComplete === true,
    };
  }
}
