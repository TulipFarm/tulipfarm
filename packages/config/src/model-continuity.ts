import { z } from 'zod';
import pricing from './model-pricing.json' with { type: 'json' };
import families from './model-families.json' with { type: 'json' };
import { modelFamilyIdSchema, modelIdentifierSchema as identifier } from './model-identifier.ts';
import {
  buildModelCatalog,
  ModelCatalogError,
  modelCatalogRevision,
  readModelCatalogSource,
} from './model-catalog-source.ts';
import {
  modelApiSupported,
  modelCapabilitiesSchema,
  modelProviderSchema,
  resolveModelCapabilities,
  type ModelCapabilityOverrides,
  type ModelProvider,
} from './model-capabilities.ts';
import { modelRolesSchema } from './model-roles.ts';
import { modelEndpointShapeProblem } from './model-endpoints.ts';

export { modelFamilyIdSchema, modelIdentifierSchema } from './model-identifier.ts';

const ratesSchema = z
  .strictObject({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative().optional(),
    cacheWrite: z.number().nonnegative().optional(),
    cacheWrite5m: z.number().nonnegative().optional(),
    cacheWrite1h: z.number().nonnegative().optional(),
  })
  .readonly();
export const modelPriceSchema = z
  .strictObject({
    validFrom: z.iso.date().nullable(),
    validUntilExclusive: z.iso.date().nullable(),
    promptTokensAbove: z.number().int().nonnegative().nullable(),
    usdPerMillionTokens: ratesSchema,
  })
  .readonly();

const tokenLimit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const modelFamilyEntrySchema = z
  .strictObject({
    id: modelFamilyIdSchema,
    name: z.string().min(1),
    vendor: identifier,
    currentModelId: identifier,
    modelIds: z.array(identifier).min(1).readonly(),
    capabilities: modelCapabilitiesSchema
      .optional()
      .describe('Overrides of the provider default capabilities for every model in the family'),
    pricing: z
      .literal('unmetered')
      .optional()
      .describe('Unmetered families record tokens at zero cost; their models declare no rates'),
    roles: modelRolesSchema.optional(),
  })
  .readonly();
export const modelPricingEntrySchema = z
  .strictObject({
    id: identifier,
    name: z.string().min(1),
    provider: modelProviderSchema,
    providerModelId: z.string().min(1).max(200),
    metadataKey: z.string().min(1).optional(),
    metadata: z.looseObject({ max_input_tokens: tokenLimit, max_output_tokens: tokenLimit }).readonly(),
    pricingSource: z.string().min(1).optional(),
    pricingScope: z.string().min(1).optional(),
    notes: z.array(z.string()).readonly().optional(),
    rates: z
      .array(modelPriceSchema)
      .min(1)
      .readonly()
      .optional()
      .describe('Required unless the model belongs to a family with `pricing: "unmetered"`'),
    endpoint: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe(
        'OpenAI-compatible API base URL, required for and only for provider `openai-compatible`; its host must be in MODEL_ENDPOINT_HOSTS',
      ),
    credentialEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,90}_API_KEY$/)
      .refine(name => !/^(VITE_|NEXT_PUBLIC_|PUBLIC_)/.test(name), 'must not be a public variable')
      .optional()
      .describe(
        'Environment variable holding the API key, required for and only for provider `openai-compatible`; must end in _API_KEY',
      ),
  })
  .superRefine((model, ctx) => {
    const compatible = model.provider === 'openai-compatible';
    for (const field of ['endpoint', 'credentialEnv'] as const)
      if ((model[field] !== undefined) !== compatible)
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: compatible
            ? `Required for provider openai-compatible`
            : 'Only provider openai-compatible declares an endpoint and credentialEnv',
        });
    const problem = model.endpoint === undefined ? null : modelEndpointShapeProblem(model.endpoint);
    if (problem) ctx.addIssue({ code: 'custom', path: ['endpoint'], message: `Endpoint ${problem}` });
    if (model.rates && !model.rates.some(rate => rate.promptTokensAbove === null))
      ctx.addIssue({ code: 'custom', path: ['rates'], message: 'Missing base price' });
    for (const [index, rate] of (model.rates ?? []).entries()) {
      if (rate.validFrom && rate.validUntilExclusive && rate.validFrom >= rate.validUntilExclusive)
        ctx.addIssue({ code: 'custom', path: ['rates', index], message: 'Invalid price interval' });
      for (const [category, amount] of Object.entries(rate.usdPerMillionTokens))
        if (!/^\d+(\.\d{1,6})?$/.test(String(amount)))
          ctx.addIssue({
            code: 'custom',
            path: ['rates', index, 'usdPerMillionTokens', category],
            message: 'Unsupported price precision',
          });
    }
  })
  .readonly();
type ModelPrice = z.infer<typeof modelPriceSchema>;
/** A model of the effective catalog. Models of unmetered families carry zero rates. */
export type ModelPricingEntry = Omit<z.infer<typeof modelPricingEntrySchema>, 'rates'> & {
  readonly rates: readonly ModelPrice[];
};

// Every token category at zero, so metering records usage without ever failing on an unpriced category.
const unmeteredRates: readonly ModelPrice[] = Object.freeze([
  modelPriceSchema.parse({
    validFrom: null,
    validUntilExclusive: null,
    promptTokensAbove: null,
    usdPerMillionTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  }),
]);

const shippedCatalog = {
  families: z.array(modelFamilyEntrySchema).parse(families),
  models: z.array(modelPricingEntrySchema).parse(pricing.models),
};
const catalogSource = readModelCatalogSource(process.env);
const effectiveCatalog = buildModelCatalog({
  shipped: shippedCatalog,
  source: catalogSource,
  schemas: { family: modelFamilyEntrySchema, model: modelPricingEntrySchema },
});
for (const family of effectiveCatalog.families)
  for (const model of effectiveCatalog.models.filter(item => family.modelIds.includes(item.id))) {
    const name = `family ${JSON.stringify(family.id)}: model ${JSON.stringify(model.id)}`;
    if (family.pricing === 'unmetered' && model.rates)
      throw new ModelCatalogError(
        catalogSource?.label ?? 'shipped',
        `${name} has rates but the family is unmetered; remove the rates or the family pricing`,
      );
    if (family.pricing !== 'unmetered' && !model.rates)
      throw new ModelCatalogError(
        catalogSource?.label ?? 'shipped',
        `${name} has no rates; add rates or set "pricing": "unmetered" on the family`,
      );
  }
/** Concrete models of the effective catalog: the shipped catalog merged with MODEL_CATALOG_FILE or MODEL_CATALOG. */
export const modelCatalogModels: readonly ModelPricingEntry[] = Object.freeze(
  effectiveCatalog.models.map(model =>
    model.rates ? { ...model, rates: model.rates } : { ...model, rates: unmeteredRates },
  ),
);
const priceSnapshot = modelCatalogModels;

export const modelFamilyCatalogSchema = z
  .array(modelFamilyEntrySchema)
  .min(1)
  .superRefine((catalog, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (new Set(catalog.map(family => family.id)).size !== catalog.length) fail('Duplicate model family');
    const modelIds = catalog.flatMap(family => family.modelIds);
    if (new Set(modelIds).size !== modelIds.length) fail('Duplicate concrete model membership');
    if (
      modelIds.length !== priceSnapshot.length ||
      priceSnapshot.some(model => !modelIds.includes(model.id)) ||
      modelIds.some(id => !priceSnapshot.some(model => model.id === id))
    )
      fail('Catalog membership must cover the price snapshot');
    for (const family of catalog) {
      if (!family.modelIds.includes(family.currentModelId)) fail('Current model must belong to its family');
      if (
        priceSnapshot.some(
          model =>
            family.modelIds.includes(model.id) &&
            !modelApiSupported(modelProviderSchema.parse(model.provider), family.capabilities?.api),
        )
      )
        fail(`Model API must be supported by its provider (family "${family.id}")`);
    }
  })
  .readonly();
export const modelFamilies = modelFamilyCatalogSchema.parse(effectiveCatalog.families);
export const selectableModelFamilies = modelFamilies;

/**
 * The model a family runs on each provider that serves it: `currentModelId` on its own provider, and on every other
 * provider the first of `modelIds` that provider serves. The first entry is the provider the catalog prefers.
 */
export function familyProviderModels(familyId: string): readonly { provider: ModelProvider; modelId: string }[] {
  const family = modelFamilies.find(item => item.id === familyId);
  if (!family) return [];
  const byProvider = new Map<ModelProvider, string>();
  for (const modelId of [family.currentModelId, ...family.modelIds]) {
    const model = priceSnapshot.find(item => item.id === modelId);
    if (model && !byProvider.has(model.provider)) byProvider.set(model.provider, model.id);
  }
  return [...byProvider].map(([provider, modelId]) => ({ provider, modelId }));
}

/** Capabilities of a provider model ID (deployment): provider defaults, its catalog family, then `overrides`. */
export function modelCapabilities(
  provider: ModelProvider,
  providerModelId: string,
  ...overrides: readonly (ModelCapabilityOverrides | undefined)[]
) {
  const model = priceSnapshot.find(item => item.provider === provider && item.providerModelId === providerModelId);
  const family = model && modelFamilies.find(item => item.modelIds.includes(model.id));
  return resolveModelCapabilities(provider, family?.capabilities, ...overrides);
}

export const modelMappingSchema = z
  .strictObject({
    format: z.literal(1),
    revision: identifier,
    pricingRevision: identifier,
    families: z
      .array(z.strictObject({ id: modelFamilyIdSchema, modelId: identifier }).readonly())
      .min(1)
      .readonly(),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.families.map(family => family.id)).size !== value.families.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate model family' });
  })
  .readonly();
// The shipped catalog keeps its published revisions; operator catalogs get content-derived ones.
export const initialModelMapping = modelMappingSchema.parse({
  format: 1,
  revision: modelCatalogRevision('families', 'families-2026-10-19.1', shippedCatalog.families, modelFamilies),
  pricingRevision: modelCatalogRevision(
    'prices',
    'prices-2026-10-19.1',
    shippedCatalog.models,
    effectiveCatalog.models,
  ),
  families: modelFamilies.map(family => ({ id: family.id, modelId: family.currentModelId })),
});

export const qualifiedModelRouteSchema = z
  .strictObject({
    id: identifier,
    modelId: identifier,
    provider: modelProviderSchema,
    deployment: z.string().min(1).max(200),
    location: identifier,
    adapterVersion: z.literal(1),
    qualification: z.string().min(1).max(500),
    lifecycle: z.enum(['candidate', 'current', 'deprecated', 'retired']),
    maxInputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    boundedDecision: z.literal(true),
  })
  .readonly();
export const resolvedModelShapeSchema = z
  .strictObject({
    familyId: modelFamilyIdSchema,
    modelId: identifier,
    mappingRevision: identifier,
    pricingRevision: identifier,
    route: qualifiedModelRouteSchema,
    rates: z.array(modelPriceSchema).min(1).readonly(),
  })
  .readonly();
export const resolvedModelSchema = resolvedModelShapeSchema
  .superRefine((value, ctx) => {
    const family = modelFamilies.find(candidate => candidate.id === value.familyId);
    if (!family?.modelIds.includes(value.modelId))
      ctx.addIssue({ code: 'custom', message: 'Resolved family identity mismatch' });
    if (value.mappingRevision === initialModelMapping.revision && family?.currentModelId !== value.modelId)
      ctx.addIssue({ code: 'custom', message: 'Resolved mapping identity mismatch' });
    const model = priceSnapshot.find(candidate => candidate.id === value.modelId);
    const rates = model?.rates.map(({ validFrom, validUntilExclusive, promptTokensAbove, usdPerMillionTokens }) =>
      modelPriceSchema.parse({ validFrom, validUntilExclusive, promptTokensAbove, usdPerMillionTokens }),
    );
    if (
      value.pricingRevision !== initialModelMapping.pricingRevision ||
      JSON.stringify(value.rates) !== JSON.stringify(rates) ||
      value.route.modelId !== value.modelId ||
      value.route.provider !== model?.provider
    )
      ctx.addIssue({ code: 'custom', message: 'Resolved price identity mismatch' });
  })
  .readonly();
export type ResolvedModel = z.infer<typeof resolvedModelSchema>;

export class ModelResolutionError extends Error {
  readonly code: 'unknown-family' | 'unknown-model' | 'unsupported-pricing' | 'route-unavailable' | 'ambiguous-route';
  constructor(code: ModelResolutionError['code']) {
    super(code);
    this.code = code;
  }
}

export function resolveModelFamily(input: {
  familyId: string;
  mapping: unknown;
  routes: unknown;
  allowedProviders: readonly string[];
  allowedLocations: readonly string[];
}): ResolvedModel {
  const mapping = modelMappingSchema.parse(input.mapping);
  if (mapping.pricingRevision !== initialModelMapping.pricingRevision)
    throw new ModelResolutionError('unsupported-pricing');
  if (
    mapping.revision === initialModelMapping.revision &&
    JSON.stringify(mapping) !== JSON.stringify(initialModelMapping)
  )
    throw new ModelResolutionError('unknown-model');
  const family = mapping.families.find(candidate => candidate.id === input.familyId);
  if (!family || !modelFamilies.some(candidate => candidate.id === family.id))
    throw new ModelResolutionError('unknown-family');
  const model = priceSnapshot.find(candidate => candidate.id === family.modelId);
  if (!model) throw new ModelResolutionError('unknown-model');
  const curated = modelFamilies.find(candidate => candidate.id === family.id);
  if (!curated?.modelIds.includes(model.id)) throw new ModelResolutionError('unknown-model');
  const routes = z
    .array(qualifiedModelRouteSchema)
    .parse(input.routes)
    .filter(
      route =>
        route.modelId === model.id &&
        route.provider === model.provider &&
        route.lifecycle === 'current' &&
        input.allowedProviders.includes(route.provider) &&
        input.allowedLocations.includes(route.location),
    );
  if (routes.length > 1) throw new ModelResolutionError('ambiguous-route');
  const route = routes[0];
  if (!route) throw new ModelResolutionError('route-unavailable');
  if (
    route.maxInputTokens > model.metadata.max_input_tokens ||
    route.maxOutputTokens > model.metadata.max_output_tokens
  )
    throw new ModelResolutionError('route-unavailable');
  return resolvedModelSchema.parse({
    familyId: family.id,
    modelId: model.id,
    mappingRevision: mapping.revision,
    pricingRevision: mapping.pricingRevision,
    route,
    rates: model.rates.map(({ validFrom, validUntilExclusive, promptTokensAbove, usdPerMillionTokens }) => ({
      validFrom,
      validUntilExclusive,
      promptTokensAbove,
      usdPerMillionTokens,
    })),
  });
}
