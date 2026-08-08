import type { ModelInvocationRequest } from "../ports/model";
import type { ModelRequirements } from "./profile";

/**
 * What a model must be able to do to serve one invocation.
 *
 * Kept pure and derived only from the request so that routing is reproducible: replaying a Run must
 * reach the same requirements, and therefore the same ModelProfile, as the original execution. Any
 * input that is not on the request (wall-clock, provider health, load) would make two identical
 * turns route differently with nothing in the record explaining why.
 *
 * Governance inputs the request cannot carry — residency, retention, training, sensitivity — are
 * supplied by the caller as `policy` and merged verbatim. They belong to the Run's Guardrails, not
 * to the transcript, and this function must not invent them.
 */

/** Rough characters-per-token for context estimation across the providers in use. */
const CHARS_PER_TOKEN = 4;

/** Headroom for the answer itself, so a prompt that only just fits does not pick a model it overruns. */
const RESPONSE_HEADROOM_TOKENS = 1_024;

export type ModelRequirementsPolicy = Omit<
  ModelRequirements,
  "needsTools" | "needsStructuredOutput" | "estimatedContextTokens" | "sensitive"
> & {
  /** Sensitive work keeps caching off regardless of what the profile permits (SPEC §17). */
  readonly sensitive?: boolean;
};

export function estimateContextTokens(request: ModelInvocationRequest): number {
  const transcript = request.messages.reduce((total, m) => total + m.content.length, 0);
  const tools = (request.tools ?? []).reduce(
    (total, t) =>
      total + t.name.length + (t.description?.length ?? 0) + JSON.stringify(t.inputSchema).length,
    0
  );
  const schema =
    request.outputSchema === undefined ? 0 : JSON.stringify(request.outputSchema).length;

  return (
    Math.ceil((transcript + tools + schema) / CHARS_PER_TOKEN) +
    (request.maxOutputTokens ?? RESPONSE_HEADROOM_TOKENS)
  );
}

export function deriveModelRequirements(
  request: ModelInvocationRequest,
  policy: ModelRequirementsPolicy = {}
): ModelRequirements {
  const { sensitive = false, ...governance } = policy;
  return {
    ...governance,
    needsTools: (request.tools?.length ?? 0) > 0,
    needsStructuredOutput: request.outputSchema !== undefined,
    estimatedContextTokens: estimateContextTokens(request),
    sensitive,
  };
}
