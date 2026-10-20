import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical } from './model-catalog-source.ts';
import {
  familyProviderModels,
  initialModelMapping,
  modelCatalogModels,
  modelFamilies,
  modelMappingSchema,
  modelPriceSchema,
  qualifiedModelRouteSchema,
  resolvedModelShapeSchema,
  resolvedModelSchema,
  ModelResolutionError,
} from './model-continuity.ts';
import { modelFamilyIdSchema, modelIdentifierSchema as identifier } from './model-identifier.ts';

const bundleModelSchema = z
  .strictObject({
    id: identifier,
    familyId: modelFamilyIdSchema,
    vendor: identifier,
    provider: qualifiedModelRouteSchema.unwrap().shape.provider,
    maxInputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    rates: z.array(modelPriceSchema).min(1).readonly(),
  })
  .readonly();

export const initialBundleModels = z
  .array(bundleModelSchema)
  .readonly()
  .parse(
    modelCatalogModels.map(model => {
      const family = modelFamilies.find(candidate => candidate.modelIds.includes(model.id));
      return {
        id: model.id,
        familyId: family?.id,
        vendor: family?.vendor,
        provider: model.provider,
        maxInputTokens: model.metadata.max_input_tokens,
        maxOutputTokens: model.metadata.max_output_tokens,
        rates: model.rates.map(({ validFrom, validUntilExclusive, promptTokensAbove, usdPerMillionTokens }) => ({
          validFrom,
          validUntilExclusive,
          promptTokensAbove,
          usdPerMillionTokens,
        })),
      };
    }),
  );

export const modelBundleSchema = z
  .strictObject({
    format: z.literal(1),
    id: identifier,
    mapping: modelMappingSchema,
    models: z.array(bundleModelSchema).min(1).readonly(),
    routes: z.array(qualifiedModelRouteSchema).min(1).readonly(),
  })
  .superRefine((bundle, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (
      new Set(bundle.models.map(model => model.id)).size !== bundle.models.length ||
      new Set(bundle.routes.map(route => route.id)).size !== bundle.routes.length
    )
      fail('Duplicate bundle identity');
    if (
      bundle.mapping.revision === initialModelMapping.revision &&
      JSON.stringify(bundle.mapping) !== JSON.stringify(initialModelMapping)
    )
      fail('Initial mapping is immutable');
    for (const model of bundle.models) {
      const original = initialBundleModels.find(item => item.id === model.id);
      const family = modelFamilies.find(item => item.id === model.familyId);
      if (
        !family ||
        family.vendor !== model.vendor ||
        !familyProviderModels(family.id).some(item => item.provider === model.provider) ||
        (original &&
          (original.familyId !== model.familyId ||
            original.vendor !== model.vendor ||
            original.provider !== model.provider))
      )
        fail('Family and vendor identity is immutable');
      if (
        bundle.mapping.pricingRevision === initialModelMapping.pricingRevision &&
        (!original || JSON.stringify(original.rates) !== JSON.stringify(model.rates))
      )
        fail('Initial pricing is immutable');
      for (const rate of model.rates) {
        if (rate.validFrom && rate.validUntilExclusive && rate.validFrom >= rate.validUntilExclusive)
          fail('Invalid price interval');
        for (const amount of Object.values(rate.usdPerMillionTokens))
          if (!/^\d+(\.\d{1,6})?$/.test(String(amount))) fail('Unsupported price precision');
      }
      for (const [index, rate] of model.rates.entries()) {
        if (
          model.rates
            .slice(index + 1)
            .some(
              other =>
                other.promptTokensAbove === rate.promptTokensAbove &&
                (rate.validFrom === null ||
                  other.validUntilExclusive === null ||
                  rate.validFrom < other.validUntilExclusive) &&
                (other.validFrom === null ||
                  rate.validUntilExclusive === null ||
                  other.validFrom < rate.validUntilExclusive),
            )
        )
          fail('Ambiguous price schedule');
      }
      if (!model.rates.some(rate => rate.promptTokensAbove === null)) fail('Missing base price');
    }
    for (const route of bundle.routes) {
      const model = bundle.models.find(item => item.id === route.modelId);
      if (
        !model ||
        route.provider !== model.provider ||
        route.maxInputTokens > model.maxInputTokens ||
        route.maxOutputTokens > model.maxOutputTokens ||
        route.lifecycle !== 'current'
      )
        fail('Invalid qualified route');
    }
    for (const family of bundle.mapping.families) {
      if (
        !bundle.models.some(model => model.id === family.modelId && model.familyId === family.id) ||
        !bundle.routes.some(route => route.modelId === family.modelId)
      )
        fail('Unqualified family mapping');
    }
  })
  .readonly();
export type ModelBundle = z.infer<typeof modelBundleSchema>;

type ServerBundleContent = Pick<ModelBundle, 'models' | 'routes'> &
  Pick<ModelBundle['mapping'], 'pricingRevision' | 'families'>;
const serverBundleId = /^server-[0-9a-f]{64}$/;

/**
 * Bundle of a server model configuration. Its id (and mapping revision) is the SHA-256 of the rest of its content,
 * so a stored bundle can be checked against the id that runs recorded.
 */
export function serverModelBundle(content: ServerBundleContent): ModelBundle {
  const { models, routes, pricingRevision, families } = content;
  const digest = createHash('sha256')
    .update(JSON.stringify(canonical({ format: 1, models, routes, mapping: { format: 1, pricingRevision, families } })))
    .digest('hex');
  const id = `server-${digest}`;
  return modelBundleSchema.parse({
    format: 1,
    id,
    models,
    routes,
    mapping: { format: 1, revision: id, pricingRevision, families },
  });
}

/** Parses a stored server bundle and returns it only when its content hashes to `bundleId`. */
export function verifyServerModelBundle(bundleId: string, stored: unknown): ModelBundle {
  const bundle = modelBundleSchema.parse(stored);
  const expected = serverModelBundle({
    models: bundle.models,
    routes: bundle.routes,
    pricingRevision: bundle.mapping.pricingRevision,
    families: bundle.mapping.families,
  });
  if (
    !serverBundleId.test(bundleId) ||
    expected.id !== bundleId ||
    JSON.stringify(canonical(bundle)) !== JSON.stringify(canonical(expected))
  )
    throw new Error('Untrusted model bundle');
  return expected;
}

export function resolveModelBundle(input: {
  bundle: unknown;
  familyId: string;
  allowedProviders: readonly string[];
  allowedLocations: readonly string[];
}) {
  const bundle = modelBundleSchema.parse(input.bundle);
  const family = bundle.mapping.families.find(item => item.id === input.familyId);
  if (!family) throw new ModelResolutionError('unknown-family');
  const model = bundle.models.find(item => item.id === family.modelId);
  if (!model) throw new ModelResolutionError('unknown-model');
  const routes = bundle.routes.filter(
    route =>
      route.modelId === model.id &&
      input.allowedProviders.includes(route.provider) &&
      input.allowedLocations.includes(route.location),
  );
  if (routes.length > 1) throw new ModelResolutionError('ambiguous-route');
  const route = routes[0];
  if (!route) throw new ModelResolutionError('route-unavailable');
  return resolvedModelShapeSchema.parse({
    familyId: family.id,
    modelId: model.id,
    mappingRevision: bundle.mapping.revision,
    pricingRevision: bundle.mapping.pricingRevision,
    route,
    rates: model.rates,
  });
}

export function parseModelResolution(resolution: unknown, trustedBundle?: unknown) {
  if (trustedBundle === undefined) return resolvedModelSchema.parse(resolution);
  const parsed = resolvedModelShapeSchema.parse(resolution);
  const expected = resolveModelBundle({
    bundle: trustedBundle,
    familyId: parsed.familyId,
    allowedProviders: [parsed.route.provider],
    allowedLocations: [parsed.route.location],
  });
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) throw new Error('Resolved bundle identity mismatch');
  return expected;
}
