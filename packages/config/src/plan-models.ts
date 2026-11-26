import {
  isByokProvider,
  isPlanProvider,
  planProviderNames,
  type ByokProvider,
  type ModelCatalogFile,
  type ModelCatalogFileModel,
  type PlanProvider,
} from './model-catalog-file.ts';

// Every model a member's plan or BYOK API key lists is offered as its own model family, without needing a static
// entry in models.json. Its id is derived from the provider and model id, so chats and preferences keep it across
// restarts and deployments.

const familyPrefixes: Readonly<Record<PlanProvider, string>> = Object.freeze({
  chatgpt: 'chatgpt-',
  claude: 'claude-plan-',
  copilot: 'copilot-',
  'byok-anthropic': 'byok-anthropic-',
  'byok-openai': 'byok-openai-',
  'byok-google': 'byok-google-',
  'byok-xai': 'byok-xai-',
  'byok-openai-compatible': 'byok-compat-',
});

/**
 * Historical short family IDs from before plan models moved off models.json. Kept so existing chats and saved agents
 * stored with these IDs continue to resolve to their plan and model.
 */
const legacyPlanFamilies: Readonly<Record<string, { readonly provider: PlanProvider; readonly model: string }>> =
  Object.freeze({
    'chatgpt-sol': { provider: 'chatgpt', model: 'gpt-6.1-sol' },
    'chatgpt-astra': { provider: 'chatgpt', model: 'gpt-6-astra' },
    'chatgpt-luna': { provider: 'chatgpt', model: 'gpt-6-luna' },
    'claude-plan-sonnet': { provider: 'claude', model: 'claude-sonnet-5' },
    'claude-plan-opus': { provider: 'claude', model: 'claude-opus-5-5' },
    'claude-plan-haiku': { provider: 'claude', model: 'claude-haiku-4-5' },
    'copilot-claude-sonnet': { provider: 'copilot', model: 'claude-sonnet-5.5' },
    'copilot-claude-opus': { provider: 'copilot', model: 'claude-opus-5.5' },
    'copilot-gpt-sol': { provider: 'copilot', model: 'gpt-6.1-sol' },
    'copilot-gpt-luna': { provider: 'copilot', model: 'gpt-6-luna' },
  });

/** Limits for a plan or BYOK model when neither the provider nor the catalog reports limits. */
export const planModelDefaultLimits: Readonly<
  Record<PlanProvider, { readonly maxInputTokens: number; readonly maxOutputTokens: number }>
> = Object.freeze({
  chatgpt: Object.freeze({ maxInputTokens: 272_000, maxOutputTokens: 64_000 }),
  claude: Object.freeze({ maxInputTokens: 200_000, maxOutputTokens: 64_000 }),
  copilot: Object.freeze({ maxInputTokens: 128_000, maxOutputTokens: 32_000 }),
  'byok-anthropic': Object.freeze({ maxInputTokens: 200_000, maxOutputTokens: 64_000 }),
  'byok-openai': Object.freeze({ maxInputTokens: 128_000, maxOutputTokens: 32_000 }),
  'byok-google': Object.freeze({ maxInputTokens: 1_000_000, maxOutputTokens: 65_536 }),
  'byok-xai': Object.freeze({ maxInputTokens: 131_072, maxOutputTokens: 32_000 }),
  'byok-openai-compatible': Object.freeze({ maxInputTokens: 128_000, maxOutputTokens: 16_384 }),
});

// Provider model ids a subscription family id can carry: lowercase words joined by single dots or hyphens. A dot
// becomes "--", which such an id never contains, so the family id decodes back to exactly one model id.
const encodableModel = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
// BYOK model slugs can also contain "/", "_", ":" (e.g. OpenRouter "anthropic/claude-sonnet-4:beta").
const encodableByokModel = /^[a-z0-9][a-z0-9./_:-]*$/;
const maxFamilyId = 100;

function encodeByokSlug(slug: string): string {
  return slug
    .replaceAll('--', '--h')
    .replaceAll('.', '--d')
    .replaceAll('/', '--s')
    .replaceAll('_', '--u')
    .replaceAll(':', '--c');
}

function decodeByokSlug(encoded: string): string {
  return encoded.replace(/--([dsuhc])/g, (_, code: string) =>
    code === 'd' ? '.' : code === 's' ? '/' : code === 'u' ? '_' : code === 'c' ? ':' : '--',
  );
}

const customConnectionPrefix = /^([0-9a-f]{8})-(.+)$/;

function connectionTag(connectionId: string | null | undefined): string | null {
  if (!connectionId) return null;
  const hex = connectionId.replaceAll('-', '').slice(0, 8).toLowerCase();
  return /^[0-9a-f]{8}$/.test(hex) ? hex : null;
}

/**
 * The family id of `model` on `provider`, or null when the id can't carry it, such as Copilot's `auto`.
 * For `byok-openai-compatible`, pass `connectionId` so models from different custom endpoints stay distinct families.
 */
export function planModelFamilyId(provider: PlanProvider, model: string, connectionId?: string | null): string | null {
  if (model === 'auto') return null;
  if (isByokProvider(provider)) {
    const lower = model.toLowerCase();
    if (!encodableByokModel.test(lower)) return null;
    const tag = provider === 'byok-openai-compatible' ? connectionTag(connectionId) : null;
    const prefix = tag ? `${familyPrefixes[provider]}${tag}-` : familyPrefixes[provider];
    const id = prefix + encodeByokSlug(lower);
    return id.length <= maxFamilyId && /^[a-z][a-z0-9-]{0,99}$/.test(id) ? id : null;
  }
  if (!encodableModel.test(model)) return null;
  const id = familyPrefixes[provider] + model.replaceAll('.', '--');
  return id.length <= maxFamilyId ? id : null;
}

/**
 * The provider, model, and optional 8-hex custom connection prefix a family id from `planModelFamilyId` (or a legacy
 * plan id) names, or null for any other id.
 */
export function planModelOfFamily(
  familyId: string,
): { provider: PlanProvider; model: string; connectionPrefix?: string } | null {
  const legacy = legacyPlanFamilies[familyId];
  if (legacy) return { provider: legacy.provider, model: legacy.model };
  for (const provider of planProviderNames) {
    const prefix = familyPrefixes[provider];
    if (!familyId.startsWith(prefix)) continue;
    const rest = familyId.slice(prefix.length);
    if (provider === 'byok-openai-compatible') {
      const scoped = customConnectionPrefix.exec(rest);
      if (scoped) {
        const [, tag, encoded] = scoped;
        const model = decodeByokSlug(encoded!);
        if (planModelFamilyId(provider, model, tag) === familyId) {
          return { provider, model, connectionPrefix: tag! };
        }
      }
    }
    const model = isByokProvider(provider) ? decodeByokSlug(rest) : rest.replaceAll('--', '.');
    if (planModelFamilyId(provider, model) === familyId) return { provider, model };
  }
  return null;
}

/**
 * Returns all equivalent family IDs for `familyId` (itself plus any legacy short alias or derived canonical ID),
 * so workspace availability / disable policies apply consistently across legacy and derived plan family IDs.
 */
export function equivalentPlanFamilyIds(familyId: string): readonly string[] {
  const ids = new Set<string>([familyId]);
  const legacy = legacyPlanFamilies[familyId];
  if (legacy) {
    const derived = planModelFamilyId(legacy.provider, legacy.model);
    if (derived) ids.add(derived);
  }
  const parsed = planModelOfFamily(familyId);
  if (parsed && !parsed.connectionPrefix) {
    for (const [legacyId, entry] of Object.entries(legacyPlanFamilies)) {
      if (entry.provider === parsed.provider && entry.model === parsed.model) {
        ids.add(legacyId);
      }
    }
  }
  return [...ids];
}

/**
 * A provider model id in the form plans and the model's own API both reduce to; they differ in small ways, such as
 * `claude-sonnet-4.5` and `claude-sonnet-4-5-20250929`.
 */
export const comparableProviderModel = (model: string) =>
  model
    .toLowerCase()
    .replaceAll('.', '-')
    .replace(/-\d{8}$/, '');

const acronyms: Readonly<Record<string, string>> = Object.freeze({ gpt: 'GPT', ai: 'AI', gemini: 'Gemini' });

/** A readable, versioned name from a provider model id: `claude-opus-5-5` is Claude Opus 5.5, `gpt-6.1-sol` GPT-6.1 Sol. */
export function planModelNameFromId(model: string): string {
  const words: string[] = [];
  const tokens = model.split('-').filter(token => token && !/^\d{8}$/.test(token));
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (/^\d{1,2}$/.test(token) && words.length && /^\d+(?:\.\d+)*$/.test(words.at(-1)!.split('-').at(-1)!)) {
      // A version split by hyphens, such as 5-5 in claude-opus-5-5.
      words[words.length - 1] += `.${token}`;
      continue;
    }
    if (token === 'gpt' && tokens[index + 1] && /^\d/.test(tokens[index + 1]!)) {
      words.push(`GPT-${tokens[++index]}`);
      continue;
    }
    if (/^o\d/.test(token) || /^\d/.test(token)) words.push(token);
    else words.push(acronyms[token] ?? token.charAt(0).toUpperCase() + token.slice(1));
  }
  return words.join(' ') || model;
}

/**
 * The name people see for a plan model: the provider's own name without notes in parentheses, such as "(Internal
 * only)", or one derived from the model id when the provider gave none or a name without its version.
 */
export function planModelName(model: string, label?: string | null): string {
  const named = (label ?? '')
    .replace(/\s*\([^()]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!named || named === model || (/\d/.test(model) && !/\d/.test(named))) return planModelNameFromId(model);
  return named.slice(0, 100);
}

const sameModel = (a: string, b: string) => a.replaceAll('.', '-') === b.replaceAll('.', '-');

const vendorPatterns: readonly [RegExp, string][] = [
  [/^claude/, 'anthropic'],
  [/^(gpt|o\d|codex|chatgpt)/, 'openai'],
  [/^gemini/, 'google'],
  [/^grok/, 'xai'],
];
const planVendors: Readonly<Record<PlanProvider, string>> = Object.freeze({
  chatgpt: 'openai',
  claude: 'anthropic',
  copilot: 'github',
  'byok-anthropic': 'anthropic',
  'byok-openai': 'openai',
  'byok-google': 'google',
  'byok-xai': 'xai',
  'byok-openai-compatible': 'openai-compatible',
});

/** Member plans and BYOK API key providers are always offered dynamically without needing static entries in models.json. */
export function catalogOffersPlan(_catalog: ModelCatalogFile, provider: PlanProvider) {
  return isPlanProvider(provider);
}

/** The catalog family that runs `model` on `provider`'s plan, if the catalog names one. */
export function catalogPlanFamily(catalog: ModelCatalogFile, provider: PlanProvider, model: string) {
  return catalog.models.find(
    family =>
      family.routes.length === 1 && family.routes[0]!.provider === provider && family.routes[0]!.model === model,
  );
}

export type DiscoveredModelMetadata = {
  maxInputTokens?: number | null;
  maxOutputTokens?: number | null;
  imageInput?: boolean | null;
  connectionId?: string | null;
};

/**
 * The catalog entry for `model` on `provider` (a member's subscription plan or BYOK API key). Uses provider-reported
 * metadata when present, borrows ratings/vision from any matching deployment entry, and falls back to per-provider
 * safe defaults. Always unmetered and selectable.
 */
export function planCatalogModel(
  catalog: ModelCatalogFile,
  provider: PlanProvider,
  model: string,
  label?: string | null,
  metadata?: DiscoveredModelMetadata | null,
): ModelCatalogFileModel | null {
  const id = planModelFamilyId(provider, model, metadata?.connectionId);
  if (!id || !catalogOffersPlan(catalog, provider)) return null;
  const name = planModelName(model, label);
  const listed = catalogPlanFamily(catalog, provider, model);
  if (listed) return { ...listed, id, name: label ? name : listed.name };
  const defaults = planModelDefaultLimits[provider];
  const known = catalog.models.find(
    family =>
      !family.routes.some(route => isPlanProvider(route.provider)) &&
      family.routes.some(route => sameModel(route.model, model)),
  );
  const byok = isByokProvider(provider);
  const imageInput =
    metadata?.imageInput ?? (known?.capabilities?.imageInput === true && (provider === 'chatgpt' || byok));
  const maxInputTokens =
    metadata?.maxInputTokens && metadata.maxInputTokens > 0
      ? metadata.maxInputTokens
      : byok
        ? (known?.limits.maxInputTokens ?? defaults.maxInputTokens)
        : Math.min(known?.limits.maxInputTokens ?? Infinity, defaults.maxInputTokens);
  const maxOutputTokens =
    metadata?.maxOutputTokens && metadata.maxOutputTokens > 0
      ? metadata.maxOutputTokens
      : byok
        ? (known?.limits.maxOutputTokens ?? defaults.maxOutputTokens)
        : Math.min(known?.limits.maxOutputTokens ?? Infinity, defaults.maxOutputTokens);
  const slugForVendor = model.includes('/') ? model.split('/').pop()! : model;
  return {
    id,
    name,
    vendor:
      known?.vendor ??
      vendorPatterns.find(([pattern]) => pattern.test(slugForVendor.toLowerCase()))?.[1] ??
      planVendors[provider],
    routes: [{ provider, model }],
    default: false,
    paused: false,
    selectable: true,
    speed: known?.speed ?? null,
    quality: known?.quality ?? null,
    featureFlag: null,
    roles: [],
    fallback: null,
    limits: {
      maxInputTokens,
      maxOutputTokens,
      ...(imageInput && known?.limits.imageInputTokens ? { imageInputTokens: known.limits.imageInputTokens } : {}),
    },
    ...(imageInput ? { capabilities: { imageInput: true } } : {}),
    imageModel: null,
    pricing: 'unmetered',
    notes: [
      byok
        ? `Discovered from a connected ${planVendors[provider]} API key.`
        : `Listed by the member's own ${provider} plan.`,
    ],
  };
}

export type { ByokProvider };
