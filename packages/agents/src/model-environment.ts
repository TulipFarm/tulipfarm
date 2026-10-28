import {
  loadModelCatalog,
  modelImageLimits,
  ModelResolutionError,
  resolveModelBundle,
  servedModelBundle,
  serverRouteLocation,
  type ResolvedModel,
  type ServedModelCatalog,
} from '@tulipfarm/config';
import { inferDecision, inferenceRouteSchema, routeCapabilities, type InferenceRoute } from './inference.ts';
import type { ModelContinuity } from './continuity.ts';
import type { ModelRouteHealth } from './model-health.ts';
import type { ModelBundleStore } from './model-bundles.ts';

const runBudgetPicoUsd = '10000000000000';

type Environment = ReturnType<typeof buildModelEnvironment>;
const environments = new WeakMap<ServedModelCatalog, Map<string, Environment>>();

/**
 * The served models of the model catalog (see `loadModelCatalog`) as a server bundle, with the inference route of each:
 * the model's first route whose provider key is set. Throws when the catalog or its environment is invalid.
 *
 * Built once per served catalog and set of credentials, and frozen, since callers resolve models on every request.
 */
export function modelEnvironment(env: NodeJS.ProcessEnv = process.env): Environment {
  const catalog = loadModelCatalog(env);
  const credentials = catalog.models.map(model => env[model.route.apiKeyEnv]?.trim());
  const key = JSON.stringify(credentials);
  const cache = environments.get(catalog) ?? new Map<string, Environment>();
  environments.set(catalog, cache);
  const cached = cache.get(key);
  if (cached) return cached;
  const environment = buildModelEnvironment(catalog, credentials);
  cache.set(key, environment);
  return environment;
}

function buildModelEnvironment(catalog: ServedModelCatalog, credentials: readonly (string | undefined)[]) {
  const { bundle, entries } = servedModelBundle(catalog);
  const configured = entries.map(({ model, route }, index) => {
    const credential = credentials[index];
    const common = {
      endpoint: model.route.endpoint,
      model: model.route.model,
      maxOutputTokens: route.maxOutputTokens,
    };
    const inference = inferenceRouteSchema.safeParse(
      model.route.type === 'azure'
        ? { ...common, provider: 'azure', auth: { kind: 'api-key', value: credential } }
        : { ...common, provider: model.route.type, apiKey: credential },
    );
    if (!inference.success)
      throw new Error(`Invalid server model configuration: model ${model.id} cannot use ${model.route.provider}`);
    if ('auth' in inference.data) Object.freeze(inference.data.auth);
    return { familyId: model.id, route, inference: Object.freeze(inference.data) };
  });
  const restrictions = Object.freeze({
    allowedProviders: Object.freeze([...new Set(configured.map(item => item.route.provider))]),
    allowedLocations: Object.freeze([serverRouteLocation]),
  });
  const defaultFamily = catalog.defaultModel.id;
  const paused = (familyId: string) => catalog.model(familyId)?.paused ?? false;
  const binding = (resolution: ResolvedModel) =>
    configured.find(
      item => item.route.id === resolution.route.id && JSON.stringify(item.route) === JSON.stringify(resolution.route),
    ) ?? null;
  const inference = (resolution: ResolvedModel): InferenceRoute | null => binding(resolution)?.inference ?? null;
  const deploymentKey = (resolution: ResolvedModel) => {
    const route = inference(resolution);
    if (!route) throw new Error('Model route unavailable');
    return JSON.stringify([
      route.provider,
      route.endpoint,
      route.model,
      route.provider === 'azure' ? route.auth : route.apiKey,
    ]);
  };
  return Object.freeze({
    catalog,
    bundle,
    restrictions,
    defaultFamily,
    inference,
    paused,
    route: (familyId: string) => configured.find(item => item.familyId === familyId)?.inference ?? null,
    resolve(familyId: string) {
      try {
        return resolveModelBundle({ bundle, familyId, ...restrictions });
      } catch (error) {
        if (
          error instanceof ModelResolutionError &&
          (error.code === 'unknown-family' || error.code === 'route-unavailable')
        )
          return null;
        throw error;
      }
    },
    /** `bundles` supplies the bundles of earlier configurations, so runs bound to them can finish and settle. */
    continuity(
      health: (deploymentKey: (resolution: ResolvedModel) => string) => ModelRouteHealth,
      bundles?: Pick<ModelBundleStore, 'read'>,
    ): ModelContinuity {
      return {
        activeBundle: () => ({ bundle, activationRevision: 0 }),
        trustedBundle: bundleId => {
          if (bundleId === bundle.id) return bundle;
          if (!bundles) throw new Error('Model configuration changed');
          return bundles.read(bundleId);
        },
        restrictions: () => restrictions,
        allowed: (_workspaceId, resolution) => binding(resolution) !== null,
        actualModelIds: resolution => {
          const route = binding(resolution)?.inference;
          return route ? [route.model, ...routeCapabilities(route).responseModelAliases] : [];
        },
        budgetPicoUsd: () => runBudgetPicoUsd,
        defaultFamily: () => defaultFamily,
        paused,
        imageInput: resolution => {
          const route = inference(resolution);
          return route && routeCapabilities(route).imageInput ? modelImageLimits(route.provider, route.model) : null;
        },
        imageCatalog: catalog,
        health: health(deploymentKey),
        infer: (resolution, input, timeoutMs, signal) => {
          const route = inference(resolution);
          if (!route) throw new Error('Model route unavailable');
          return inferDecision({ ...route, timeoutMs }, input, signal);
        },
      };
    },
  });
}
export type ModelEnvironment = ReturnType<typeof modelEnvironment>;
