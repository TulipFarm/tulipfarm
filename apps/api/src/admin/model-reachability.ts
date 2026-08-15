import { LlmProviderError } from "@tulipfarm/llm";
import { generateText } from "ai";
import type { ModelReachability } from "./health";

/** Verifies the deployment's model credential is still accepted, without failing on an outage. */

/** Long enough for a cold provider connection, short enough to stay inside the probe budget. */
const REACHABILITY_TIMEOUT_MS = 1_500;

/** Provider verdicts that mean *this deployment's credential* is the problem, not the provider. */
const CREDENTIAL_REASONS = new Set(["model_authentication_failed", "model_billing_inactive"]);

interface ReachabilityTarget {
  effortModel(preset: "balanced"): unknown;
}

/**
 * The smallest possible real call: enough to make the provider authenticate the credential.
 *
 * Anything that is not a credential verdict resolves successfully. A provider outage, a rate
 * limit or a timeout says nothing about this deployment's health, and letting it downgrade the
 * component would hand a third party control of our readiness page.
 */
export function modelReachability(llm: ReachabilityTarget): ModelReachability {
  return {
    async verify() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);
      try {
        await generateText({
          // biome-ignore lint/suspicious/noExplicitAny: the probe target is structural by design.
          model: llm.effortModel("balanced") as any,
          prompt: "ping",
          maxOutputTokens: 1,
          abortSignal: controller.signal,
        });
      } catch (err) {
        if (err instanceof LlmProviderError && CREDENTIAL_REASONS.has(err.reason)) throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
