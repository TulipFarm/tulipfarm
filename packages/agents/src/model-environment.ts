import {
  defaultModelEndpoints,
  familyProviderModels,
  initialBundleModels,
  initialModelMapping,
  selectableModelFamilies,
  modelEndpointHosts,
  modelEndpointProblem,
  modelEndpointShapeProblem,
  modelPricing,
  ModelResolutionError,
  normalizeModelEndpoint,
  resolveModelBundle,
  serverModelBundle,
  type ModelProvider,
  type ResolvedModel,
} from '@tulipfarm/config';
import { inferDecision, inferenceRouteSchema, routeCapabilities, type InferenceRoute } from './inference.ts';
import type { ModelContinuity } from './continuity.ts';
import type { ModelRouteHealth } from './model-health.ts';
import type { ModelBundleStore } from './model-bundles.ts';

const credentials = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  xai: 'XAI_API_KEY',
  google: 'GEMINI_API_KEY',
  azure: 'AZURE_FOUNDRY_API_KEY',
} as const satisfies Record<Exclude<ModelProvider, 'openai-compatible'>, string>;
type BaseUrlProvider = keyof typeof defaultModelEndpoints;
// Paths the request URLs append to these base URLs; a base URL that already ends in one would double it.
const appendedPaths: Partial<Record<BaseUrlProvider, string>> = { anthropic: '/v1/', google: '/v1beta/' };
const location = 'server';
const runBudgetPicoUsd = '10000000000000';

/**
 * Model families come from `MODEL_FAMILIES`; when it is unset, every catalog family that a configured provider credential
 * can serve. A family runs on the catalog's preferred provider when its credential is set, otherwise on the first other
 * provider of the family that has one. `<PROVIDER>_BASE_URL` replaces a provider's built-in origin, and an
 * `openai-compatible` catalog model brings its own endpoint and credential variable; such endpoints must be on a
 * MODEL_ENDPOINT_HOSTS host (see `modelEndpointProblem`).
 */
export function modelEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const invalid = (detail?: string) =>
    new Error(detail ? `Invalid server model configuration: ${detail}` : 'Invalid server model configuration');
  if (
    Object.keys(env).some(
      key =>
        /^(VITE_|NEXT_PUBLIC_|PUBLIC_)(MODEL_|AZURE_FOUNDRY_|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|GEMINI_API_KEY)/.test(
          key,
        ) && env[key],
    )
  )
    throw invalid();
  try {
    modelEndpointHosts(env);
  } catch (error) {
    throw invalid((error as Error).message);
  }
  const checkedEndpoint = (provider: ModelProvider, name: string, value: string) => {
    const shape = modelEndpointShapeProblem(value);
    if (shape) throw invalid(`${name} ${shape}`);
    const endpoint = normalizeModelEndpoint(value);
    const problem = modelEndpointProblem(provider, endpoint, env);
    if (problem) throw invalid(`${name} ${problem}`);
    return endpoint;
  };
  const baseUrls: Record<BaseUrlProvider, string> = { ...defaultModelEndpoints };
  for (const [provider, name, value] of [
    ['anthropic', 'ANTHROPIC_BASE_URL', env.ANTHROPIC_BASE_URL],
    ['openai', 'OPENAI_BASE_URL', env.OPENAI_BASE_URL],
    ['xai', 'XAI_BASE_URL', env.XAI_BASE_URL],
    ['google', 'GEMINI_BASE_URL', env.GEMINI_BASE_URL],
  ] as const) {
    if (!value?.trim()) continue;
    const endpoint = checkedEndpoint(provider, name, value.trim());
    const appended = appendedPaths[provider];
    if (appended && endpoint.endsWith(appended)) throw invalid(`${name} must not end in ${appended}; it is appended`);
    baseUrls[provider] = endpoint;
  }
  const catalogModel = (modelId: string) => modelPricing.models.find(candidate => candidate.id === modelId);
  const credentialName = (provider: ModelProvider, modelId: string) =>
    provider === 'openai-compatible' ? catalogModel(modelId)?.credentialEnv : credentials[provider];
  const credentialOf = (provider: ModelProvider, modelId: string) => {
    const name = credentialName(provider, modelId);
    return name ? env[name] : undefined;
  };
  const credentialed = (candidate: { provider: ModelProvider; modelId: string }) =>
    Boolean(credentialOf(candidate.provider, candidate.modelId));
  const endpointOf = (provider: ModelProvider, modelId: string) => {
    if (provider === 'azure') return env.AZURE_FOUNDRY_ENDPOINT;
    if (provider !== 'openai-compatible') return baseUrls[provider];
    const declared = catalogModel(modelId)?.endpoint;
    if (!declared) throw invalid();
    return checkedEndpoint(provider, `model ${JSON.stringify(modelId)} endpoint`, declared);
  };
  const servingModel = (familyId: string) => {
    const candidates = familyProviderModels(familyId);
    return (candidates.find(credentialed) ?? candidates[0])?.modelId;
  };
  const listed = (env.MODEL_FAMILIES ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const familyIds = listed.length
    ? listed
    : selectableModelFamilies
        .filter(family => familyProviderModels(family.id).some(credentialed))
        .map(family => family.id);
  if (!familyIds.length) return null;
  if (new Set(familyIds).size !== familyIds.length) throw invalid();
  const configured = familyIds.map(familyId => {
    const model = initialBundleModels.find(candidate => candidate.id === servingModel(familyId));
    const deployment = modelPricing.models.find(candidate => candidate.id === model?.id)?.providerModelId;
    if (!model || !deployment) throw invalid();
    const endpoint = endpointOf(model.provider, model.id);
    const credential = credentialOf(model.provider, model.id);
    const common = { endpoint, model: deployment, maxOutputTokens: Math.min(4096, model.maxOutputTokens) };
    const inference = inferenceRouteSchema.safeParse(
      model.provider === 'azure'
        ? { ...common, provider: 'azure', auth: { kind: 'api-key', value: credential } }
        : { ...common, provider: model.provider, apiKey: credential },
    );
    if (!inference.success) throw invalid();
    const route = {
      id: `server-${model.id}`,
      modelId: model.id,
      provider: model.provider,
      deployment,
      location,
      adapterVersion: 1 as const,
      qualification: 'server-configuration',
      lifecycle: 'current' as const,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: common.maxOutputTokens,
      boundedDecision: true as const,
    };
    if ('auth' in inference.data) Object.freeze(inference.data.auth);
    return { familyId, model, route, inference: Object.freeze(inference.data) };
  });
  const bundle = serverModelBundle({
    models: configured.map(item => item.model),
    routes: configured.map(item => item.route),
    pricingRevision: initialModelMapping.pricingRevision,
    families: configured.map(item => ({ id: item.familyId, modelId: item.model.id })),
  });
  const restrictions = Object.freeze({
    allowedProviders: [...new Set(configured.map(item => item.model.provider))],
    allowedLocations: [location],
  });
  const defaultFamily = env.MODEL_DEFAULT_FAMILY || undefined;
  if (defaultFamily && !familyIds.includes(defaultFamily)) throw invalid();
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
  return {
    bundle,
    restrictions,
    inference,
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
        legacyFamily: () => defaultFamily,
        health: health(deploymentKey),
        infer: (resolution, input, timeoutMs, signal) => {
          const route = inference(resolution);
          if (!route) throw new Error('Model route unavailable');
          return inferDecision({ ...route, timeoutMs }, input, signal);
        },
      };
    },
  };
}
export type ModelEnvironment = NonNullable<ReturnType<typeof modelEnvironment>>;
