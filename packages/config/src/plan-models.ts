import {
  isPlanProvider,
  planProviderNames,
  type ModelCatalogFile,
  type ModelCatalogFileModel,
  type PlanProvider,
} from './model-catalog-file.ts';

// Every model a member's plan lists is offered as its own model family, whether or not the catalog names it. Its id is
// derived from the plan and the provider's model id, so chats and preferences keep it across restarts and deployments.

const familyPrefixes: Readonly<Record<PlanProvider, string>> = Object.freeze({
  chatgpt: 'chatgpt-',
  claude: 'claude-plan-',
  copilot: 'copilot-',
});

/** Limits for a plan model the catalog does not know; a known model keeps its own when they are lower. */
export const planModelDefaultLimits: Readonly<
  Record<PlanProvider, { readonly maxInputTokens: number; readonly maxOutputTokens: number }>
> = Object.freeze({
  chatgpt: Object.freeze({ maxInputTokens: 272_000, maxOutputTokens: 64_000 }),
  claude: Object.freeze({ maxInputTokens: 200_000, maxOutputTokens: 64_000 }),
  copilot: Object.freeze({ maxInputTokens: 128_000, maxOutputTokens: 32_000 }),
});

// Provider model ids a family id can carry: lowercase words joined by single dots or hyphens. A dot becomes "--", which
// such an id never contains, so the family id decodes back to exactly one model id.
const encodableModel = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const maxFamilyId = 100;

/** The family id of `model` on `provider`'s plan, or null when the id can't carry it, such as Copilot's `auto`. */
export function planModelFamilyId(provider: PlanProvider, model: string): string | null {
  if (model === 'auto' || !encodableModel.test(model)) return null;
  const id = familyPrefixes[provider] + model.replaceAll('.', '--');
  return id.length <= maxFamilyId ? id : null;
}

/** The plan and provider model a family id from `planModelFamilyId` names, or null for any other id. */
export function planModelOfFamily(familyId: string): { provider: PlanProvider; model: string } | null {
  for (const provider of planProviderNames) {
    const prefix = familyPrefixes[provider];
    if (!familyId.startsWith(prefix)) continue;
    const model = familyId.slice(prefix.length).replaceAll('--', '.');
    if (planModelFamilyId(provider, model) === familyId) return { provider, model };
  }
  return null;
}

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
});

/** Whether the catalog lists `provider`'s plan; a catalog without its routes offers none of its models. */
export function catalogOffersPlan(catalog: ModelCatalogFile, provider: PlanProvider) {
  return catalog.models.some(model => model.routes.some(route => route.provider === provider));
}

/** The catalog family that runs `model` on `provider`'s plan, if the catalog names one. */
export function catalogPlanFamily(catalog: ModelCatalogFile, provider: PlanProvider, model: string) {
  return catalog.models.find(
    family =>
      family.routes.length === 1 && family.routes[0]!.provider === provider && family.routes[0]!.model === model,
  );
}

/**
 * The catalog entry for `model` on `provider`'s plan. A model the catalog runs on that plan keeps its entry under the
 * derived id; one it runs elsewhere keeps its vendor, ratings and image input within the plan's default limits; any
 * other gets the plan's defaults. Plan models are always unmetered, selectable and fall back to the fallback model.
 * Null when the id can't carry the model or the catalog lists no route for the plan.
 */
export function planCatalogModel(
  catalog: ModelCatalogFile,
  provider: PlanProvider,
  model: string,
  label?: string | null,
): ModelCatalogFileModel | null {
  const id = planModelFamilyId(provider, model);
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
  const imageInput = known?.capabilities?.imageInput === true && provider === 'chatgpt';
  return {
    id,
    name,
    vendor: known?.vendor ?? vendorPatterns.find(([pattern]) => pattern.test(model))?.[1] ?? planVendors[provider],
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
      maxInputTokens: Math.min(known?.limits.maxInputTokens ?? Infinity, defaults.maxInputTokens),
      maxOutputTokens: Math.min(known?.limits.maxOutputTokens ?? Infinity, defaults.maxOutputTokens),
      ...(imageInput && known.limits.imageInputTokens ? { imageInputTokens: known.limits.imageInputTokens } : {}),
    },
    ...(imageInput ? { capabilities: { imageInput: true } } : {}),
    imageModel: null,
    pricing: 'unmetered',
    notes: [`Listed by the member's own ${provider} plan; limits are defaults.`],
  };
}
