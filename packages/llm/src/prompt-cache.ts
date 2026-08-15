/**
 * Decides whether a prompt's stable prefix should ask the provider to cache it.
 *
 * Cache read, cache write and reasoning tokens were already captured, priced and charged on this
 * path — but nothing ever *requested* caching, so hits were whatever the provider happened to do
 * by default. Asking is not free in either direction, which is why the decision lives here rather
 * than at the call site:
 *
 * - A cache **write** costs roughly 25% more than an ordinary input token, so annotating a prefix
 *   too short for the provider to cache pays a premium for nothing.
 * - A sensitive request must not have its prompt written into a provider-side cache at all. That
 *   is already decided during routing; this module's job is to honour it rather than re-derive it.
 */

/** Why a prompt was left unannotated. Every branch is a deliberate no, never a default. */
export type PromptCacheSkip =
  /** Routing decided against it — the model declares no caching support, or the request is sensitive. */
  | "routing_withheld"
  /** No profile decided. A raw model id names a model without a governance posture, so nothing checked sensitivity. */
  | "routing_unknown"
  /** The provider caches without being asked; an annotation would be inert. */
  | "provider_implicit"
  /** No known caching contract for this provider, so the wire format is a guess. */
  | "provider_unknown"
  /** Below the provider's minimum cacheable prefix — the write premium could never be earned back. */
  | "prefix_too_short";

/** Provider options that mark the end of a cacheable prefix, in the shape the SDK passes through. */
export type PromptCacheAnnotation = {
  readonly anthropic: { readonly cacheControl: { readonly type: "ephemeral" } };
};

export type PromptCacheDecision =
  | { readonly kind: "annotate"; readonly providerOptions: PromptCacheAnnotation }
  | { readonly kind: "skip"; readonly reason: PromptCacheSkip };

export interface PromptCacheInput {
  /** The provider the head of the chain belongs to. */
  readonly provider: string | undefined;
  /** The model the head of the chain names; minimum cacheable length varies by model family. */
  readonly modelId: string | undefined;
  /**
   * Routing's allowance, `primary.allowCaching && !requirements.sensitive`.
   *
   * `undefined` means no profile decided, which is not the same as `true`: it means nothing
   * checked sensitivity, so the only safe answer is no.
   */
  readonly cacheAllowed: boolean | undefined;
  /** Size of the stable prefix — instructions plus tool declarations — in characters. */
  readonly prefixChars: number;
}

/** How a provider is asked to cache, if at all. */
type CacheContract = "explicit" | "implicit" | "unknown";

const PROVIDER_CACHE_CONTRACT: Readonly<Record<string, CacheContract>> = {
  anthropic: "explicit",
  openai: "implicit",
  azure: "implicit",
  // The subscription CLIs cache inside their own agent SDK and are handed a transcript, not a
  // provider-options payload, so there is nothing here to annotate.
  "claude-code": "implicit",
  codex: "implicit",
  // A compatible endpoint may proxy anything, so neither the contract nor the minimum is knowable.
  "openai-compatible": "unknown",
};

/** Anthropic declines to cache a shorter prefix rather than erroring, so this must be respected. */
const ANTHROPIC_MIN_CACHEABLE_TOKENS = 1024;
/** Haiku models require twice the prefix before Anthropic will cache it. */
const ANTHROPIC_HAIKU_MIN_CACHEABLE_TOKENS = 2048;

/**
 * Deliberately pessimistic characters-per-token.
 *
 * English averages closer to 4. Dividing by a larger number under-counts tokens, so a prefix has
 * to be comfortably over the provider minimum before it is annotated. Erring the other way would
 * pay the write premium on prompts the provider was never going to cache.
 */
const CHARS_PER_TOKEN = 5;

const EPHEMERAL: PromptCacheAnnotation = { anthropic: { cacheControl: { type: "ephemeral" } } };

/** The minimum cacheable prefix for a model, in characters. */
function minCacheableChars(modelId: string | undefined): number {
  const tokens = /haiku/i.test(modelId ?? "")
    ? ANTHROPIC_HAIKU_MIN_CACHEABLE_TOKENS
    : ANTHROPIC_MIN_CACHEABLE_TOKENS;
  return tokens * CHARS_PER_TOKEN;
}

/**
 * Whether to annotate the stable prompt prefix for provider-side caching.
 *
 * Fail-closed on every unknown: an un-annotated prompt costs full price, while a wrongly
 * annotated one can write a sensitive prefix into a cache this deployment does not control.
 */
export function decidePromptCache(input: PromptCacheInput): PromptCacheDecision {
  if (input.cacheAllowed === undefined) return { kind: "skip", reason: "routing_unknown" };
  if (!input.cacheAllowed) return { kind: "skip", reason: "routing_withheld" };

  const contract = PROVIDER_CACHE_CONTRACT[input.provider ?? ""] ?? "unknown";
  if (contract === "implicit") return { kind: "skip", reason: "provider_implicit" };
  if (contract === "unknown") return { kind: "skip", reason: "provider_unknown" };

  if (input.prefixChars < minCacheableChars(input.modelId)) {
    return { kind: "skip", reason: "prefix_too_short" };
  }
  return { kind: "annotate", providerOptions: EPHEMERAL };
}
