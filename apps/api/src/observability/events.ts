import type { EventEmitter } from "node:events";
import { type ModelPrice, priceCall } from "@tulipfarm/llm";
import {
  DOMAIN_EVENTS,
  type LlmStepFinishedPayload,
  type SurfaceRenderedPayload,
  type TurnFinishedPayload,
} from "@tulipfarm/storage";
import type { MetricsSink } from "./metrics";
import type { ObservabilityService } from "./service";
import type { TracesSink } from "./traces";

function fireAndForget(p: Promise<unknown>): void {
  p.catch((err) =>
    console.error(
      `[observability] subscriber failed: ${err instanceof Error ? err.message : String(err)}`
    )
  );
}

/** Run a synchronous listener body, swallowing any throw. Observability must never do that. */
function guard(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(
      `[observability] subscriber error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Drop undefined-valued keys so attributes jsonb stays compact (no `"cacheRead": null` noise). */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Wire the observability spine to the domain-event bus: each finished model step becomes an
 * `llm_call` row (cost computed + frozen here via the price map) and each finished turn a `turn`
 * summary row. `ObservabilityService.record` is best-effort, so a failed write only logs and never
 * affects the chat turn.
 */
export function subscribeObservability(
  emitter: EventEmitter,
  obs: ObservabilityService,
  opts: {
    /** Fallback price map, used only when the served model has
     *  no pinned per-token cost on its soul spec. */
    pricingOverrides?: Record<string, ModelPrice>;
    metrics?: MetricsSink;
    traces?: TracesSink;
    captureContent?: boolean;
  } = {}
): void {
  const metrics = opts.metrics;
  const traces = opts.traces;
  const captureContent = opts.captureContent === true;

  // One pricing authority, shared with the Worker branch that charges the Run budget. An operator
  // override outranks the pinned soul spec: the override exists to correct a drifted price, and a
  // spec that always won would make an override unreachable for every model that has one.
  function computeCost(p: LlmStepFinishedPayload): number | null {
    const priced = priceCall({
      // A step with no recorded provider cannot be recognised as a subscription seat, so it
      // prices like any metered call rather than silently becoming free.
      provider: p.provider ?? "",
      modelId: p.model,
      tokensIn: p.tokensIn,
      tokensOut: p.tokensOut,
      overrides: opts.pricingOverrides,
      ...(typeof p.costInPerToken === "number" && typeof p.costOutPerToken === "number"
        ? {
            spec: {
              input_cost_per_token: p.costInPerToken,
              output_cost_per_token: p.costOutPerToken,
            },
          }
        : {}),
    });
    return priced.kind === "priced" ? priced.costUsd : null;
  }
  emitter.on(DOMAIN_EVENTS.LLM_STEP_FINISHED, (p: LlmStepFinishedPayload): void =>
    guard(() => onLlmStep(p))
  );
  emitter.on(DOMAIN_EVENTS.TURN_FINISHED, (p: TurnFinishedPayload): void =>
    guard(() => onTurnFinished(p))
  );
  emitter.on(DOMAIN_EVENTS.SURFACE_RENDERED, (p: SurfaceRenderedPayload): void =>
    guard(() => metrics?.recordSurface?.(p))
  );
  emitter.on(DOMAIN_EVENTS.SURFACE_INTERACTED, (p: SurfaceRenderedPayload): void =>
    guard(() => metrics?.recordSurface?.(p))
  );
  emitter.on(DOMAIN_EVENTS.SURFACE_DELIVERED, (p: SurfaceRenderedPayload): void =>
    guard(() => metrics?.recordSurface?.(p))
  );

  function onLlmStep(p: LlmStepFinishedPayload): void {
    const costUsd = computeCost(p);
    // Queue the durable DB writes FIRST, so a later-throwing metrics/traces sink can't cost us the
    fireAndForget(
      obs.record({
        type: "llm_call",
        conversationId: p.conversationId,
        agentId: p.agentId,
        model: p.model,
        provider: p.provider,
        tier: p.tier ?? null,
        tokensIn: p.tokensIn,
        tokensOut: p.tokensOut,
        costUsd,
        durationMs: p.durationMs ?? null,
        status: p.status,
        attributes: compact({
          cacheRead: p.cacheRead,
          cacheWrite: p.cacheWrite,
          reasoning: p.reasoning,
          unpriced: costUsd === null ? true : undefined,
          completion: captureContent ? p.completionText : undefined,
        }),
      })
    );
    for (const tool of p.tools ?? []) {
      fireAndForget(
        obs.record({
          type: "tool_call",
          conversationId: p.conversationId,
          agentId: p.agentId,
          toolName: tool.name,
          status: tool.status,
          attributes: compact({
            errorCode: tool.errorCode,
            args: captureContent ? tool.args : undefined,
            result: captureContent ? tool.result : undefined,
          }),
        })
      );
    }
    metrics?.recordLlmCall({
      model: p.model,
      provider: p.provider,
      tier: p.tier,
      status: p.status,
      tokensIn: p.tokensIn,
      tokensOut: p.tokensOut,
      costUsd,
    });
    traces?.spanStep(p.conversationId, {
      name: p.model,
      kind: "llm_call",
      durationMs: p.durationMs,
      status: p.status,
      attributes: { "tulipfarm.provider": p.provider ?? "unknown" },
    });
    for (const tool of p.tools ?? []) {
      metrics?.recordToolCall({ toolName: tool.name, status: tool.status });
      traces?.spanStep(p.conversationId, {
        name: tool.name,
        kind: "tool_call",
        status: tool.status,
        attributes: tool.errorCode ? { "tulipfarm.error_code": tool.errorCode } : {},
      });
    }
  }

  function onTurnFinished(p: TurnFinishedPayload): void {
    metrics?.recordTurn({ status: p.status });
    traces?.finishTurn(p.conversationId, {
      agentId: p.agentId,
      status: p.status,
      durationMs: p.durationMs,
      steps: p.steps,
      tokensIn: p.tokensIn,
      tokensOut: p.tokensOut,
    });
    fireAndForget(
      obs.record({
        type: "turn",
        conversationId: p.conversationId,
        agentId: p.agentId,
        model: p.model ?? null,
        tier: p.tier ?? null,
        // Display rollups only; cost/token totals come from llm_call rows.
        tokensIn: p.tokensIn,
        tokensOut: p.tokensOut,
        durationMs: p.durationMs ?? null,
        status: p.status,
        attributes: { steps: p.steps },
      })
    );
  }
}
