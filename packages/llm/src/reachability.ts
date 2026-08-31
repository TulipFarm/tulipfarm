import type { EmbeddingModel, LanguageModel } from "ai";
import { APICallError, embed, generateText, RetryError } from "ai";
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
  /**
   * What the model actually wrote back, truncated. A verdict alone proves the transport worked;
   * the reply is what proves the configured id is a model that answers rather than, say, a proxy
   * route that accepts anything and returns an empty completion.
   */
  readonly reply?: string;
  /** Round-trip time of the probe call, including a cold provider's handshake. */
  readonly latencyMs?: number;
  /**
   * Embedding probes only: the width of the vector the model returned. Worth surfacing because it
   * is the number the operator must record for the index, and guessing it wrong is unrecoverable
   * without a re-index.
   */
  readonly dimension?: number;
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

/**
 * Asks for a specific word rather than sending a bare "ping", so the reply distinguishes a model
 * that is answering from an endpoint that merely returns 200.
 */
const PROBE_PROMPT = 'Reply with the single word "pong" and nothing else.';

/** The reply is shown verbatim, so a model that ignores the instruction cannot flood the page. */
const MAX_REPLY_CHARS = 200;

/** Matches the asked-for word anywhere, so a model that adds punctuation or a period still passes. */
const SAID_PONG = /\bpong\b/i;

function trimReply(text: string): string {
  const clean = text.trim();
  return clean.length > MAX_REPLY_CHARS ? `${clean.slice(0, MAX_REPLY_CHARS)}…` : clean;
}

const RECONNECT = "reconnect the provider under Business → Models";

/** An HTTP status proves the provider answered; its absence proves nothing was reached. */
function httpStatus(error: unknown): number | undefined {
  const last = RetryError.isInstance(error) ? httpStatus(error.lastError) : error;
  if (typeof last === "number") return last;
  return APICallError.isInstance(last) ? last.statusCode : undefined;
}

/** The configured model the verdict is about; an operator's first question about a red row. */
function label(model: LanguageModel | EmbeddingModel): string {
  return typeof model === "string" ? model : model.modelId;
}

function report(
  error: unknown,
  timedOut: boolean,
  timeoutMs: number
): Required<Pick<ModelReachabilityReport, "verdict" | "detail">> {
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
  const startedAt = Date.now();
  try {
    const { text } = await generateText({
      model,
      prompt: PROBE_PROMPT,
      maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
      abortSignal: controller.signal,
    });
    const reply = trimReply(text);
    const latencyMs = Date.now() - startedAt;
    // Answering at all proves the credential and the model id; answering with the asked-for word is
    // what proves something is reading the prompt rather than replaying a canned or cached body.
    // Those are different facts, so they get different verdicts instead of one optimistic pass.
    if (!SAID_PONG.test(reply)) {
      return {
        verdict: "degraded",
        detail: reply
          ? "the provider answered, but not with the word it was asked for"
          : "the provider answered with an empty reply",
        reply,
        latencyMs,
      };
    }
    return { verdict: "reachable", reply, latencyMs };
  } catch (error) {
    const failure = report(error, controller.signal.aborted, timeoutMs);
    return {
      verdict: failure.verdict,
      detail: `${label(model)} — ${failure.detail}`,
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The embedding equivalent: embeds one short string and reports the width it got back.
 *
 * Shares the classifier with the chat probe so the same provider failure reads the same way on
 * both, and resolves for every outcome for the same reason.
 */
export async function checkEmbeddingReachability(
  model: EmbeddingModel,
  timeoutMs: number = MODEL_REACHABILITY_TIMEOUT_MS
): Promise<ModelReachabilityReport> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const { embedding } = await embed({
      model,
      value: "ping",
      abortSignal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    // A provider that answers with no vector has accepted the request without doing the job, which
    // would index Knowledge into nothing. That is a failure, not a pass with an odd shape.
    if (embedding.length === 0) {
      return {
        verdict: "degraded",
        detail: "the provider answered without returning a vector",
        latencyMs,
      };
    }
    return { verdict: "reachable", dimension: embedding.length, latencyMs };
  } catch (error) {
    const failure = report(error, controller.signal.aborted, timeoutMs);
    return {
      verdict: failure.verdict,
      detail: `${label(model)} — ${failure.detail}`,
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}
