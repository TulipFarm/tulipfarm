/**
 * The Context the L3 tier hands the real Turn driver.
 *
 * It resolves from the same two sources the L2 tier uses — the Eval Soul and the Case — through the
 * same `assembleSystemPrompt` call. That is the point: if L3 assembled its Context differently, the
 * two tiers could disagree and the disagreement would be the harness's fault rather than the
 * product's, which is the confound this framework exists to remove.
 *
 * What L3 adds is everything *around* the Context: the driver, the State machine, the durable
 * events, the completion protocol. The Context itself must stay identical.
 */

import { assembleSystemPrompt } from "@tulipfarm/agent-runtime";
import { canonicalHash, validateGuardrailsConfig } from "@tulipfarm/schema";
import type { ResolvedTurnContext, TurnContextPort } from "@tulipfarm/turn-executor";
import type { EvalCase } from "../case.ts";
import { LOOP_LIMITS } from "../case.ts";
import { type EvalSoul, soulContext } from "../eval-soul.ts";

export interface EvalTurnContextOptions {
  readonly evalCase: EvalCase;
  readonly soul: EvalSoul;
}

export interface EvalTurnContext extends TurnContextPort {
  /** The assembled prompt, so a Case can assert on it at L3 exactly as it does at L2. */
  readonly systemPrompt: string;
}

export function evalTurnContext(options: EvalTurnContextOptions): EvalTurnContext {
  const { evalCase, soul } = options;
  const raw = soul.loader.guardrailsConfig;
  if (raw === null) throw new Error("Eval Soul declares no guardrails.yaml — nothing to measure");
  const policy = validateGuardrailsConfig(raw);

  const systemPrompt = assembleSystemPrompt({
    ...soulContext(soul, evalCase.agent),
    ...evalCase.context,
  });

  const resolved: ResolvedTurnContext = {
    agentId: evalCase.agent,
    subjectId: "eval",
    modelProfileId: "eval",
    contextDigest: `sha256:${canonicalHash({ id: evalCase.id, prompt: systemPrompt })}`,
    guardrailDigest: canonicalHash(policy),
    guardrailPolicy: policy as unknown as Record<string, unknown>,
    messages: [{ role: "system", content: systemPrompt }, ...evalCase.input],
    // Untiered, exactly as the L2 tier leaves them: the fixture blocks Tools by name, and inventing
    // tiers here would measure a categorisation no Soul in this repository declares.
    tools: (evalCase.tools ?? []).map((tool) => ({ ...tool, tier: "untiered" })),
    limits: LOOP_LIMITS,
    compacted: false,
  };

  return { systemPrompt, resolve: async () => resolved };
}
