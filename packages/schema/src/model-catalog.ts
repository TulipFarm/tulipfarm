import type { ModelModality } from "./definitions/common";
import type { ModelProfileSpec } from "./definitions/model";
import type { LlmConfig, ModelSpec, ProviderConnection, ProviderEntry } from "./llm";

/** Derives `soul.yaml#llm` into ModelProfiles; permissive on tools, conservative on modality. */

/** Effort a participant may ask for. `auto` resolves to the configured default. */
export const EFFORT_PRESETS = ["auto", "fast", "balanced", "thorough"] as const;
export type EffortPreset = (typeof EFFORT_PRESETS)[number];

/** Effort rungs `auto` can resolve to; `auto` is never the applied rung. */
export const EFFORT_RUNGS = ["fast", "balanced", "thorough"] as const;
export type EffortRung = (typeof EFFORT_RUNGS)[number];

export function isEffortRung(value: string): value is EffortRung {
  return (EFFORT_RUNGS as readonly string[]).includes(value);
}

/** Legacy tier names, accepted on the wire for one release and mapped onto effort presets. */
export const DEPRECATED_TIER_ALIASES: Readonly<Record<string, EffortPreset>> = {
  quick: "fast",
  standard: "balanced",
  complex: "thorough",
};

const TIER_TO_PRESET: Readonly<Record<string, EffortPreset>> = DEPRECATED_TIER_ALIASES;

/** Conservative default when a spec pins no context window; the smallest window in common use. */
const FALLBACK_CONTEXT_TOKENS = 8_192;

export function isEffortPreset(value: string): value is EffortPreset {
  return (EFFORT_PRESETS as readonly string[]).includes(value);
}

/**
 * Translate a wire selector into an effort preset. Returns `undefined` for anything else — a raw
 * model id or ModelProfile ref, which the caller resolves directly.
 */
export function asEffortPreset(value: string | undefined): EffortPreset | undefined {
  if (value === undefined) return undefined;
  if (isEffortPreset(value)) return value;
  return TIER_TO_PRESET[value];
}

/** Whether `value` is a retired tier name, so callers can log the deprecation exactly once. */
export function isDeprecatedTierAlias(value: string): boolean {
  return value in DEPRECATED_TIER_ALIASES;
}

/** A derived profile keeps the ref it was derived from so evidence can name its origin. */
export interface DerivedModelProfile extends ModelProfileSpec {
  readonly profileId: string;
  /** The pinned pricing/capability spec, carried through for cost attribution. */
  readonly spec?: ModelSpec;
}

function modalitiesFor(spec: ModelSpec | undefined): ModelModality[] {
  // Absent spec means text-only; do not claim vision we cannot prove.
  return spec?.supports_vision === true ? ["text", "image"] : ["text"];
}

function profileFrom(
  entry: ProviderEntry,
  profileId: string,
  connection: string
): DerivedModelProfile {
  const spec = entry.spec;
  return {
    profileId,
    provider: entry.provider,
    model: entry.model,
    connection,
    reasoning: spec?.supports_reasoning === true ? "high" : "medium",
    supports: {
      // Only explicit `false` denies tools; unpinned specs keep legacy tool behavior.
      tools: spec?.supports_function_calling !== false,
      structuredOutput: spec?.supports_function_calling !== false,
      contextWindowTokens: spec?.max_input_tokens ?? FALLBACK_CONTEXT_TOKENS,
      inputModalities: modalitiesFor(spec),
      outputModalities: ["text"],
    },
    allowCaching: spec?.supports_prompt_caching === true,
    ...(spec === undefined ? {} : { spec }),
  };
}

/** Credentials that make two entries for the same provider genuinely different accounts. */
function credentialKey(entry: ProviderEntry): string {
  return [entry.provider, entry.api_key_ref ?? "", entry.base_url ?? "", entry.resource_name ?? ""]
    .map((part) => part.replaceAll("|", "\\|"))
    .join("|");
}

export interface HoistedConnections {
  connections: Record<string, ProviderConnection>;
  /** Connection name for each tier entry, keyed by {@link credentialKey}. */
  nameFor: (entry: ProviderEntry) => string;
}

/** Hoist distinct credential tuples to connections; only the first provider keeps the bare name. */
export function hoistProviderConnections(config: LlmConfig): HoistedConnections {
  const connections: Record<string, ProviderConnection> = {};
  const namesByKey = new Map<string, string>();
  const countByProvider = new Map<string, number>();

  const entries = Object.values(config.tiers ?? {}).flatMap((tier) => tier.providers);
  for (const entry of entries) {
    const key = credentialKey(entry);
    if (namesByKey.has(key)) continue;

    const seen = countByProvider.get(entry.provider) ?? 0;
    countByProvider.set(entry.provider, seen + 1);
    const name = seen === 0 ? entry.provider : `${entry.provider}-${seen + 1}`;

    namesByKey.set(key, name);
    connections[name] = {
      provider: entry.provider,
      ...(entry.api_key_ref === undefined ? {} : { api_key_ref: entry.api_key_ref }),
      ...(entry.base_url === undefined ? {} : { base_url: entry.base_url }),
      ...(entry.resource_name === undefined ? {} : { resource_name: entry.resource_name }),
    };
  }

  return {
    connections,
    nameFor: (entry) => namesByKey.get(credentialKey(entry)) ?? entry.provider,
  };
}

/** Derive tier profiles with ordered fallback chains, re-checking each link before use. */
export function deriveModelProfiles(config: LlmConfig): DerivedModelProfile[] {
  const tiers = config.tiers;
  if (tiers === undefined) return [];

  const { nameFor } = hoistProviderConnections(config);
  const derived: DerivedModelProfile[] = [];
  for (const [tier, preset] of Object.entries(TIER_TO_PRESET)) {
    const providers = tiers[tier as keyof typeof tiers]?.providers ?? [];
    if (providers.length === 0) continue;

    const ids = providers.map((_, index) => (index === 0 ? preset : `${preset}-fallback-${index}`));
    providers.forEach((entry, index) => {
      const fallbacks = ids.slice(index + 1);
      derived.push({
        ...profileFrom(entry, ids[index], nameFor(entry)),
        ...(fallbacks.length === 0 ? {} : { fallbacks }),
      });
    });
  }
  return derived;
}

/** Resolve presets from config; prompt inference happens only in agent-runtime. */
export function resolveEffortPreset(
  preset: EffortPreset,
  config: Pick<LlmConfig, "presets">,
  available: (profileId: string) => boolean
): string | undefined {
  const configured = config.presets;
  const candidates =
    preset === "auto"
      ? [configured?.default, configured?.balanced, "balanced", configured?.fast, "fast"]
      : [configured?.[preset], preset];

  for (const candidate of candidates) {
    if (candidate !== undefined && available(candidate)) return candidate;
  }
  return undefined;
}
