import { z } from 'zod';
import legacy from './legacy-models-2026-10-19.json' with { type: 'json' };
import { modelFamilyIdSchema, modelIdentifierSchema as identifier } from './model-identifier.ts';
import { modelProviderSchema } from './model-capabilities.ts';

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
export type ModelPrice = z.infer<typeof modelPriceSchema>;

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

const tokenLimit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const legacyModelSchema = z
  .strictObject({
    id: identifier,
    familyId: modelFamilyIdSchema,
    vendor: identifier,
    provider: modelProviderSchema,
    providerModelId: z.string().min(1).max(200),
    maxInputTokens: tokenLimit,
    maxOutputTokens: tokenLimit,
    rates: z.array(modelPriceSchema).min(1).readonly(),
  })
  .readonly();

/**
 * Frozen record of the models and prices served before the model catalog file, for verifying the bundles, runs and
 * receipts they produced. Never configuration: deployments serve the models of their catalog file.
 */
export const legacyModels = Object.freeze(z.array(legacyModelSchema).parse(legacy.models));

/** The mapping (revision `families-2026-10-19.1`, prices `prices-2026-10-19.1`) of the frozen record above. */
export const initialModelMapping = modelMappingSchema.parse(legacy.mapping);

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
    maxInputTokens: tokenLimit,
    maxOutputTokens: tokenLimit,
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
/** A resolution of the initial mapping, checked against the frozen record. */
export const resolvedModelSchema = resolvedModelShapeSchema
  .superRefine((value, ctx) => {
    const model = legacyModels.find(candidate => candidate.id === value.modelId);
    if (model?.familyId !== value.familyId)
      ctx.addIssue({ code: 'custom', message: 'Resolved family identity mismatch' });
    if (
      value.mappingRevision === initialModelMapping.revision &&
      initialModelMapping.families.find(family => family.id === value.familyId)?.modelId !== value.modelId
    )
      ctx.addIssue({ code: 'custom', message: 'Resolved mapping identity mismatch' });
    if (
      value.pricingRevision !== initialModelMapping.pricingRevision ||
      JSON.stringify(value.rates) !== JSON.stringify(model?.rates) ||
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

/** Resolves a family through a mapping of the frozen record, as receipts made before server bundles were. */
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
  if (!family || !legacyModels.some(candidate => candidate.familyId === family.id))
    throw new ModelResolutionError('unknown-family');
  const model = legacyModels.find(candidate => candidate.id === family.modelId);
  if (!model || model.familyId !== family.id) throw new ModelResolutionError('unknown-model');
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
  if (route.maxInputTokens > model.maxInputTokens || route.maxOutputTokens > model.maxOutputTokens)
    throw new ModelResolutionError('route-unavailable');
  return resolvedModelSchema.parse({
    familyId: family.id,
    modelId: model.id,
    mappingRevision: mapping.revision,
    pricingRevision: mapping.pricingRevision,
    route,
    rates: model.rates,
  });
}
