import { asEffortPreset, isDeprecatedTierAlias } from "@tulipfarm/schema";

/**
 * What the turn asks the router for — a ModelProfile ref or an effort preset, never a model.
 *
 * This process deliberately does **not** resolve a model here. It used to: it ran tier selection,
 * then shipped the winning provider model id across the process boundary in a field named
 * `modelProfileId`. Two things followed, and both were bugs. The name lied about its contents. And
 * because only that one id crossed, the worker rebuilt a *single* model, so every fallback provider
 * the operator had configured sat inert — the chain was selected here and discarded in transit.
 *
 * Routing therefore belongs where the invocation happens. This function's whole job is to name the
 * intent faithfully and let the worker's router decide, with the Run's real requirements in hand.
 */

/** Chat request fields that bear on model choice. */
export interface ModelSelectorRequest {
  readonly model?: string;
}

/** Nothing chosen means `auto`: the system picks, which is the default a participant should get. */
const DEFAULT_SELECTOR = "auto";

export function resolveModelSelector(
  request: ModelSelectorRequest,
  log: (message: string) => void = console.warn
): string {
  const selector = request.model;
  if (selector === undefined || selector.length === 0) return DEFAULT_SELECTOR;

  if (isDeprecatedTierAlias(selector)) {
    const preset = asEffortPreset(selector);
    log(`[llm] request used retired tier name "${selector}"; forwarding as effort "${preset}"`);
    return preset ?? DEFAULT_SELECTOR;
  }

  // An effort preset or a ModelProfile ref passes through untouched, and so does a raw provider
  // model id — a stored request Artifact is immutable, so an old Run must keep resolving.
  return selector;
}
