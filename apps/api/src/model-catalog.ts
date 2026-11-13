import { authenticateRoutes } from './authenticated-routes.ts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied, currentMember, lockAuthorization, resolveHuman, uuidSchema } from '@tulipfarm/access';
import {
  isPlanProvider,
  loadModelCatalog,
  planProviderNames,
  type PlanProvider,
  modelFamilyIdSchema,
  modelIdentifierSchema,
  modelPriceSchema,
  modelProviderSchema,
  planModelFamilyId,
  planModelName,
  resolveModelCapabilities,
  type ResolvedModel,
  type ServedModelCatalog,
} from '@tulipfarm/config';
import {
  modelCatalogFamilySchema,
  modelCatalogImageModelSchema,
  modelCatalogSchema,
  type ModelCatalog,
  type ModelCatalogFamily,
} from '@tulipfarm/config/model-catalog';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import type { registerAuth } from './auth.ts';
import { requestBoundaryError } from './security.ts';
import { modelAvailability } from '@tulipfarm/agents/model-policy';
import { flaggedOffModels, plansOn } from '@tulipfarm/agents/model-availability';
import { creditPricing } from '@tulipfarm/extensions';

export type ModelCatalogEligibility = (input: {
  workspaceId: string;
  modelFamilyId: string;
  fallbackFor?: string;
  existing?: boolean;
}) => boolean;

export type ModelCatalogResolution = Pick<
  ResolvedModel,
  'familyId' | 'modelId' | 'mappingRevision' | 'pricingRevision' | 'rates'
> & {
  route: Pick<ResolvedModel['route'], 'modelId' | 'provider' | 'lifecycle' | 'boundedDecision'>;
};
export type ModelFamilyResolution = (input: {
  workspaceId: string;
  modelFamilyId: string;
}) => ModelCatalogResolution | null;
export type ModelCatalogSnapshot = {
  modelFamilyEligibility: ModelCatalogEligibility;
  modelFamilyResolution: ModelFamilyResolution;
  /** Families the operator paused: listed, but not offered for new chats, agents or fallback targets. */
  modelFamilyPaused?: (familyId: string) => boolean;
  /** The served model catalog; the catalog of the server environment unless given. */
  catalog?: ServedModelCatalog;
};

const projectionResolutionSchema = z.object({
  familyId: modelFamilyIdSchema,
  modelId: modelIdentifierSchema,
  mappingRevision: modelIdentifierSchema,
  pricingRevision: modelIdentifierSchema,
  rates: z.array(modelPriceSchema).min(1),
  route: z.object({
    modelId: modelIdentifierSchema,
    provider: modelProviderSchema,
    lifecycle: z.literal('current'),
    boundedDecision: z.literal(true),
  }),
});

export type ModelCatalogDependencies = {
  auth: { api: Pick<ReturnType<typeof registerAuth>['auth']['api'], 'getSession'> };
  runtime: Pick<WorkspaceRuntime, 'transaction'>;
  compatibility: { minimum: number; maximum: number };
  modelFamilyEligibility?: ModelCatalogEligibility;
  modelFamilyResolution?: ModelFamilyResolution;
  modelCatalogSnapshot?: (workspaceId: string) => Promise<ModelCatalogSnapshot>;
  /**
   * The models of `provider` the member may use on their own or a shared plan, with the provider's names; absent when
   * no plan provider is on. Every model listed here is offered, whether or not the catalog names it.
   */
  planModels?: (
    workspaceId: string,
    userId: string,
    provider: PlanProvider,
  ) => Promise<readonly { slug: string; label: string }[]>;
};

/** The plan models of plans whose feature flag, such as `copilot-plan`, is on for the workspace. */
async function offeredPlanModels(
  transaction: Parameters<typeof plansOn>[0],
  planModels: Map<string, { provider: PlanProvider; slug: string; label: string }>,
) {
  if (!planModels.size) return planModels;
  const on = await plansOn(transaction);
  return new Map([...planModels].filter(([, model]) => on.has(model.provider)));
}

function projectCatalog(
  workspaceId: string,
  date: string,
  catalog: ServedModelCatalog,
  eligible: ModelCatalogEligibility,
  resolve: ModelFamilyResolution,
  paused: (familyId: string) => boolean,
  disabled: Set<string>,
  hidden: ReadonlySet<string> = new Set(),
  planModels: ReadonlyMap<string, { provider: PlanProvider; slug: string; label: string }> = new Map(),
): ModelCatalog {
  // Models that are not selectable serve their roles and existing chats, but are never offered. Hidden models are
  // behind a workspace feature flag that is off. Plan models are offered only to a member who may use a connected
  // plan that lists them; `planModels` is keyed by `provider:slug`.
  const listed = catalog.models.filter(
    model =>
      model.selectable &&
      !hidden.has(model.id) &&
      (!isPlanProvider(model.route.type) || planModels.has(`${model.route.type}:${model.route.model}`)),
  );
  // Every other model a plan lists is offered under the id derived from its plan and slug, named by the provider.
  const named = new Set(
    catalog.models.flatMap(model =>
      isPlanProvider(model.route.type) ? [`${model.route.type}:${model.route.model}`] : [],
    ),
  );
  const selectable = [
    ...listed,
    ...[...planModels.entries()].flatMap(([key, { provider, slug, label }]) => {
      const id = named.has(key) ? null : planModelFamilyId(provider, slug);
      const model = id ? catalog.model(id) : undefined;
      return model && !hidden.has(model.id) ? [{ ...model, name: planModelName(slug, label) }] : [];
    }),
  ];
  const resolutions = new Map(
    selectable.map(family => {
      const input = { workspaceId, modelFamilyId: family.id };
      const resolution = eligible({ ...input, existing: true }) === true ? resolve(input) : null;
      const parsed = resolution === null ? null : projectionResolutionSchema.parse(resolution);
      if (parsed && (parsed.familyId !== family.id || parsed.route.modelId !== parsed.modelId))
        throw new Error('Catalog resolution mismatch');
      return [family.id, parsed];
    }),
  );
  return {
    families: selectable.map((family): ModelCatalogFamily => {
      const platformResolution = resolutions.get(family.id);
      const resolution = disabled.has(family.id) || paused(family.id) ? null : platformResolution;
      const rates = (resolution?.rates ?? family.rates).filter(
        rate =>
          rate.promptTokensAbove === null &&
          (rate.validFrom === null || date >= rate.validFrom) &&
          (rate.validUntilExclusive === null || date < rate.validUntilExclusive),
      );
      // Unmetered families have no credit rates, although their models meter at zero cost.
      const rate = family.pricing !== 'unmetered' && rates.length === 1 ? rates[0] : undefined;
      // 10^12 pico-USD per USD and 10^12 units per credit cancel, so credits per USD equals units per pico-USD.
      const creditsPerUsd = Number(creditPricing().unitsPerPicoUsd);
      const entry = {
        id: family.id,
        displayName: family.name,
        vendor: family.vendor,
        currentVersion: resolution?.modelId ?? family.route.model,
        provider: resolution?.route.provider ?? family.route.type,
        inputCreditsPerMillionTokens: rate ? rate.usdPerMillionTokens.input * creditsPerUsd : null,
        outputCreditsPerMillionTokens: rate ? rate.usdPerMillionTokens.output * creditsPerUsd : null,
        speed: family.speed,
        quality: family.quality,
        imageInput: resolveModelCapabilities(family.route.type, family.capabilities).imageInput,
        imageModelId: family.imageModel,
      };
      return modelCatalogFamilySchema.parse(
        resolution
          ? {
              ...entry,
              available: true,
              unavailableReason: null,
              mappingRevision: resolution.mappingRevision,
              pricingRevision: resolution.pricingRevision,
              fallbackFor: selectable
                .filter(
                  source =>
                    source.id !== family.id &&
                    !disabled.has(source.id) &&
                    // A paused source keeps its fallback options, so admins can move its existing agents.
                    resolutions.get(source.id) &&
                    eligible({ workspaceId, modelFamilyId: family.id, fallbackFor: source.id }) === true,
                )
                .map(source => source.id),
            }
          : {
              ...entry,
              available: false,
              unavailableReason: !platformResolution
                ? 'model-family-unavailable'
                : paused(family.id)
                  ? 'model-family-paused'
                  : 'workspace-disabled',
              mappingRevision: null,
              pricingRevision: null,
              fallbackFor: [],
            },
      );
    }),
    imageModels: catalog.catalog.imageModels
      .filter(image => !hidden.has(image.id))
      .map(image => {
        const served = catalog.imageModel(image.id);
        const creditsPerUsd = Number(creditPricing().unitsPerPicoUsd);
        const perImage =
          typeof image.pricing === 'object' && !Array.isArray(image.pricing) ? image.pricing.usdPerImage : null;
        const tokenRate = Array.isArray(image.pricing)
          ? image.pricing.filter(
              rate =>
                rate.promptTokensAbove === null &&
                (rate.validFrom === null || date >= rate.validFrom) &&
                (rate.validUntilExclusive === null || date < rate.validUntilExclusive),
            )
          : [];
        const credits = (prices: Record<string, number>) =>
          Object.fromEntries(Object.entries(prices).map(([aspect, usd]) => [aspect, usd * creditsPerUsd]));
        return modelCatalogImageModelSchema.parse({
          id: image.id,
          displayName: image.name,
          vendor: image.vendor,
          provider: served?.route.type ?? providerOfRoute(catalog, image.routes[0]!.provider),
          edits: image.edits,
          available: Boolean(served) && !image.paused && !disabled.has(image.id),
          unavailableReason: !served
            ? 'image-model-unavailable'
            : image.paused
              ? 'image-model-paused'
              : disabled.has(image.id)
                ? 'workspace-disabled'
                : null,
          creditsPerImage: perImage ? { standard: credits(perImage.standard), high: credits(perImage.high) } : null,
          outputCreditsPerMillionTokens:
            tokenRate.length === 1 ? tokenRate[0]!.usdPerMillionTokens.output * creditsPerUsd : null,
        });
      }),
    defaultChatFamilyId: catalog.defaultModel.id,
  };
}

/** The provider type of a catalog route, for an image model this deployment does not serve. */
function providerOfRoute(catalog: ServedModelCatalog, key: string) {
  return modelProviderSchema.parse(catalog.catalog.providers[key]?.type ?? key);
}

export function registerModelCatalog(app: FastifyInstance, dependencies: ModelCatalogDependencies) {
  const eligible = dependencies.modelFamilyEligibility ?? (() => false);
  const resolve = dependencies.modelFamilyResolution ?? (() => null);
  const params = z.object({ workspaceId: uuidSchema });
  const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'draft-7', io: 'input' });
  const error = json(z.object({ error: z.string() }));
  app.register(async routes => {
    const user = authenticateRoutes(routes, dependencies.auth);
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'model-catalog-not-found' });
      if (requestBoundaryError(error, reply)) return;
      return reply.code(503).send({ error: 'model-catalog-unavailable' });
    });
    routes.get(
      '/workspaces/:workspaceId/model-catalog',
      {
        schema: {
          operationId: 'getModelCatalogV1',
          summary: 'Get model families available to a current workspace member',
          tags: ['Models'],
          params: json(params),
          response: { 200: json(modelCatalogSchema), 400: error, 401: error, 404: error, 503: error },
        },
      },
      async request => {
        const { workspaceId } = params.parse(request.params);
        const userId = user(request);
        const planModels = new Map(
          dependencies.planModels
            ? (
                await Promise.all(
                  planProviderNames.map(async provider =>
                    (await dependencies.planModels!(workspaceId, userId, provider)).map(
                      ({ slug, label }) => [`${provider}:${slug}`, { provider, slug, label }] as const,
                    ),
                  ),
                )
              ).flat()
            : [],
        );
        return dependencies.runtime.transaction(workspaceId, dependencies.compatibility, async transaction => {
          await lockAuthorization(transaction, 'read');
          const actor = await resolveHuman(transaction, userId);
          await currentMember(transaction, actor);
          const snapshot = dependencies.modelCatalogSnapshot
            ? await dependencies.modelCatalogSnapshot(workspaceId)
            : { modelFamilyEligibility: eligible, modelFamilyResolution: resolve };
          const disabled = new Set(
            (await modelAvailability(transaction)).filter(row => !row.enabled).map(row => row.familyId),
          );
          return projectCatalog(
            workspaceId,
            new Date().toISOString().slice(0, 10),
            snapshot.catalog ?? loadModelCatalog(),
            snapshot.modelFamilyEligibility,
            snapshot.modelFamilyResolution,
            snapshot.modelFamilyPaused ?? (() => false),
            disabled,
            await flaggedOffModels(transaction),
            await offeredPlanModels(transaction, planModels),
          );
        });
      },
    );
  });
}
