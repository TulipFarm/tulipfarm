import type { LanguageModel } from "ai";
import { APICallError, generateText, RetryError } from "ai";
import { classifyProviderError } from "./provider-error";

/**
 * What one live call proved about a configured model.
 *
 * `degraded` is reserved for a provider that *answered* — a refused credential, a throttle, or a
 * request it did not like. Only the absence of a usable answer is `unreachable`, because a health
 * check that cannot tell those apart either cries wolf about a working provider or stays green
 * through an outage, and both make the verdict worthless.
 */
export interface ModelReachabilityReport {
  readonly verdict: "reachable" | "degraded" | "unreachable";
  /** Operator-facing, and deliberately built from classified reasons rather than provider text,
   * so no credential, URL or response body can reach a status page. */
  readonly detail?: string;
}

/**
 * Long enough for a cold subscription-CLI provider to spawn, hand-shake and answer. Callers run
 * this outside any request budget; cutting it short only loses the verdict.
 */
export const MODEL_REACHABILITY_TIMEOUT_MS = 30_000;

/**
 * Small, but not minimal: a cap of one token is rejected outright by models that reserve an
 * internal budget before writing, and a request the provider refuses says nothing about whether
 * the provider is reachable.
 */
const PROBE_MAX_OUTPUT_TOKENS = 16;

const RECONNECT = "reconnect the provider under Business → Models";

/** An HTTP status proves the provider answered; its absence proves nothing was reached. */
function httpStatus(error: unknown): number | undefined {
  const last = RetryError.isInstance(error) ? httpStatus(error.lastError) : error;
  if (typeof last === "number") return last;
  return APICallError.isInstance(last) ? last.statusCode : undefined;
}

/** The configured model the verdict is about; an operator's first question about a red row. */
function label(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}

function report(
  error: unknown,
  timedOut: boolean,
  timeoutMs: number
): Required<ModelReachabilityReport> {
  if (timedOut) {
    return {
      verdict: "unreachable",
      detail: `the provider did not answer within ${timeoutMs / 1_000}s`,
    };
  }
  const reason = classifyProviderError(error);
  if (reason === "model_authentication_failed" || reason === "model_billing_inactive") {
    return {
      verdict: "degraded",
      detail: `the provider refused this deployment's credential (${reason}) — ${RECONNECT}`,
    };
  }
  if (reason === "model_rate_limited") {
    return {
      verdict: "degraded",
      detail: "the provider is rate limiting this deployment; its credential and model are fine",
    };
  }
  if (reason === "model_not_found") {
    return {
      verdict: "unreachable",
      detail:
        "the provider has no model by the configured id — choose another under Business → Models",
    };
  }
  const status = httpStatus(error);
  if (reason === "model_provider_unavailable") {
    return {
      verdict: "unreachable",
      detail: `the provider answered ${status === undefined ? "with an error" : `HTTP ${status}`} and is not serving this deployment`,
    };
  }
  if (status !== undefined && status < 500) {
    return {
      verdict: "degraded",
      detail: `the provider answered HTTP ${status}, refusing the reachability check's own request — the provider itself is reachable`,
    };
  }
  return {
    verdict: "unreachable",
    detail: "no answer from the provider — the call never completed",
  };
}

/**
 * Makes the smallest real call the provider will authenticate, and reports what it proved.
 *
 * Resolves for every outcome: a caller polling this on a status page needs the verdict, and a
 * rejection would leave it unable to say anything but "the check itself broke".
 */
export async function checkModelReachability(
  model: LanguageModel,
  timeoutMs: number = MODEL_REACHABILITY_TIMEOUT_MS
): Promise<ModelReachabilityReport> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await generateText({
      model,
      prompt: "ping",
      maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
      abortSignal: controller.signal,
    });
    return { verdict: "reachable" };
  } catch (error) {
    const failure = report(error, controller.signal.aborted, timeoutMs);
    return { verdict: failure.verdict, detail: `${label(model)} — ${failure.detail}` };
  } finally {
    clearTimeout(timer);
  }
}
