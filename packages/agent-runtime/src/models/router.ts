import type { ModelInvocationRequest, ModelInvocationResult, ModelPort } from "../ports";
import {
  type ModelProfileCatalog,
  type ModelProfileDenialReason,
  type ModelRequirements,
  type RoutableModelProfile,
  selectModelProfile,
} from "./profile";
import type { ModelUsageEvent, ModelUsageSink } from "./usage";

/** Governed router that records usage for each safe fallback attempt. */

export type ModelRoutingErrorCode =
  | ModelProfileDenialReason
  | "provider_unavailable"
  | "budget_exceeded"
  | "fallback_exhausted";

/** Routing denial. Carries the reason code only — never a prompt, Context, or provider payload. */
export class ModelRoutingError extends Error {
  readonly name = "ModelRoutingError";

  constructor(readonly code: ModelRoutingErrorCode) {
    super(code);
  }
}

export interface ModelInvocationScope {
  readonly businessId: string;
  readonly runId: string;
  readonly stateId: string;
}

export interface ModelRouterOptions {
  readonly catalog: ModelProfileCatalog;
  /** Provider adapters keyed by the ModelProfile `provider` value, registered at composition. */
  readonly providers: Readonly<Record<string, ModelPort>>;
  readonly usage: ModelUsageSink;
  readonly now: () => Date;
}

function budgetViolation(
  profile: RoutableModelProfile,
  result: ModelInvocationResult,
  latencyMs: number
): "budget_exceeded" | "latency_exceeded" | null {
  const constraints = profile.constraints ?? {};
  const costCeiling = constraints.maxCostUsd ?? profile.budgets?.maxCostUsd;
  const tokenCeiling = constraints.maxTokens ?? profile.budgets?.maxTokens;
  const totalTokens = result.usage.inputTokens + result.usage.outputTokens;
  const costUsd = result.usage.costUsd;
  if (costCeiling !== undefined && costUsd !== undefined && costUsd > costCeiling) {
    return "budget_exceeded";
  }
  if (tokenCeiling !== undefined && totalTokens > tokenCeiling) return "budget_exceeded";
  if (constraints.maxLatencyMs !== undefined && latencyMs > constraints.maxLatencyMs) {
    return "latency_exceeded";
  }
  return null;
}

export class ModelRouter {
  constructor(private readonly options: ModelRouterOptions) {}

  async invoke(
    request: ModelInvocationRequest,
    requirements: ModelRequirements,
    scope: ModelInvocationScope
  ): Promise<ModelInvocationResult> {
    const selection = selectModelProfile(
      request.modelProfileId,
      requirements,
      this.options.catalog
    );
    if (selection.outcome === "denied") throw new ModelRoutingError(selection.reason);

    let attempt = 0;
    for (const profile of selection.chain) {
      attempt += 1;
      const provider = this.options.providers[profile.provider];
      const startedAt = this.options.now();

      if (provider === undefined) {
        await this.record(profile, scope, request, selection.cacheAllowed, attempt, {
          outcome: "provider_unavailable",
          latencyMs: 0,
          occurredAt: startedAt,
        });
        continue;
      }

      let result: ModelInvocationResult;
      try {
        result = await provider.invoke({ ...request, modelProfileId: profile.profileId });
      } catch {
        const failedAt = this.options.now();
        await this.record(profile, scope, request, selection.cacheAllowed, attempt, {
          outcome: "provider_error",
          latencyMs: failedAt.getTime() - startedAt.getTime(),
          occurredAt: failedAt,
        });
        continue;
      }

      const finishedAt = this.options.now();
      const latencyMs = finishedAt.getTime() - startedAt.getTime();
      const violation = budgetViolation(profile, result, latencyMs);
      await this.record(profile, scope, request, selection.cacheAllowed, attempt, {
        outcome: violation ?? "succeeded",
        latencyMs,
        occurredAt: finishedAt,
        usage: result.usage,
        providerRequestId: result.providerRequestId,
      });
      // A blown budget is a durable failure, not a reason to try another model on the same budget.
      if (violation === "budget_exceeded") throw new ModelRoutingError("budget_exceeded");
      if (violation === "latency_exceeded") continue;
      return result;
    }

    throw new ModelRoutingError(
      attempt === 0 ? "provider_unavailable" : this.exhaustionCode(selection.chain)
    );
  }

  private exhaustionCode(chain: readonly RoutableModelProfile[]): ModelRoutingErrorCode {
    return chain.every((profile) => this.options.providers[profile.provider] === undefined)
      ? "provider_unavailable"
      : "fallback_exhausted";
  }

  private async record(
    profile: RoutableModelProfile,
    scope: ModelInvocationScope,
    request: ModelInvocationRequest,
    cacheAllowed: boolean,
    attempt: number,
    outcome: {
      readonly outcome: ModelUsageEvent["outcome"];
      readonly latencyMs: number;
      readonly occurredAt: Date;
      readonly usage?: ModelInvocationResult["usage"];
      readonly providerRequestId?: string;
    }
  ): Promise<void> {
    await this.options.usage.record({
      requestId: request.requestId,
      businessId: scope.businessId,
      runId: scope.runId,
      stateId: scope.stateId,
      profileId: profile.profileId,
      provider: profile.provider,
      model: profile.model,
      reasoning: profile.reasoning,
      attempt,
      outcome: outcome.outcome,
      inputTokens: outcome.usage?.inputTokens ?? 0,
      outputTokens: outcome.usage?.outputTokens ?? 0,
      costUsd: outcome.usage?.costUsd ?? null,
      latencyMs: outcome.latencyMs,
      cacheAllowed,
      providerRequestId: outcome.providerRequestId,
      occurredAt: outcome.occurredAt,
    });
  }
}
