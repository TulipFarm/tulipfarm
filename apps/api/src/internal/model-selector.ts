import { asEffortPreset, isDeprecatedTierAlias } from "@tulipfarm/schema";

/** Preserves routing intent only; the Worker resolves the actual model and fallback chain. */

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
