import type { GuardContext, ToolDispatchPort } from "@tulipfarm/agent-runtime";
import { canonicalHash, validateGuardrailsConfig } from "@tulipfarm/schema";
import { type GuardedText, TurnEventWriter, TurnGuardrails } from "@tulipfarm/turn-executor";
import type { EvalSoul } from "./eval-soul.ts";

/** One guard's refusal, as a Case can assert on it. */
export interface GuardrailDecision {
  readonly stage: string;
  readonly guard: string;
  readonly reason: string;
}

export interface EvalGuardrails {
  /** The policy hash production would have recorded on the Context. */
  readonly digest: string;
  /** Refusals in the order they happened. Empty means no guard fired. */
  readonly decisions: readonly GuardrailDecision[];
  /** Wraps the dispatcher so a blocked Tool becomes a model-visible denial. */
  guard(tools: ToolDispatchPort): ToolDispatchPort;
  input(text: string): Promise<GuardedText>;
  output(text: string): Promise<GuardedText>;
}

const SILENT = { warn: () => {} };

/**
 * The Eval Soul's guardrail policy, enforced by the class production enforces it with.
 *
 * A Case that asserted on a hand-rolled guard would keep passing after `TurnGuardrails` stopped
 * calling the pipeline — which is the regression a guardrail Case exists to catch. Everything here
 * is wiring: the policy comes from `guardrails.yaml`, the digest is computed exactly as
 * `turn-context.ts` computes it, and the refusals are read back off the real Run events.
 */
export function turnGuardrails(soul: EvalSoul, conversationId: string): EvalGuardrails {
  const raw = soul.loader.guardrailsConfig;
  // Production falls back to the default policy when a Soul ships none. The Eval Soul must not:
  // a Case measuring a guardrail would then quietly measure a policy the fixture never declared.
  if (raw === null) throw new Error("Eval Soul declares no guardrails.yaml — nothing to measure");
  const policy = validateGuardrailsConfig(raw);
  const digest = canonicalHash(policy);
  const decisions: GuardrailDecision[] = [];

  const events = new TurnEventWriter({
    events: {
      append: async (input) => {
        if (input.eventType === "guardrail.decision") {
          const payload = input.payload as { stage: string; guard: string; reason: string };
          decisions.push({
            stage: payload.stage,
            guard: payload.guard,
            reason: payload.reason,
          });
        }
        return { sequence: decisions.length };
      },
    },
    businessId: "eval",
    runId: conversationId,
    turnId: conversationId,
    attempt: 1,
  });

  const guardrails = new TurnGuardrails(SILENT);
  guardrails.configure({
    policy: policy as unknown as Record<string, unknown>,
    digest,
    context: { userId: "eval", agentId: "eval", conversationId } satisfies GuardContext,
    // Every Tool a Case exposes is untiered: the fixture blocks by name, and inventing tiers here
    // would measure a categorisation no Soul in this repository actually declares.
    toolTiers: new Map(),
  });

  return {
    digest,
    decisions,
    guard: (tools) => guardrails.guard(tools, events),
    input: (text) => guardrails.input(text, events),
    output: (text) => guardrails.output(text, events),
  };
}
