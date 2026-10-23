import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import {
  modelCatalogFileSchema,
  modelProviderDefaults,
  type ImageModelApi,
  type ModelCatalogFile,
  type ModelCatalogFileImageModel,
  type ModelCatalogFileModel,
  type ModelCatalogRole,
} from './model-catalog-file.ts';
import { resolveModelCapabilities, type ModelCapabilityOverrides, type ModelProvider } from './model-capabilities.ts';
import {
  defaultModelEndpoints,
  modelEndpointHosts,
  modelEndpointProblem,
  modelEndpointShapeProblem,
  normalizeModelEndpoint,
} from './model-endpoints.ts';
import { modelPriceSchema, type ModelPrice } from './model-continuity.ts';

// Reads the model catalog (MODEL_CATALOG_FILE, MODEL_CATALOG, or the shipped catalog) and works out which of its
// models this deployment serves with the provider keys it has.

/** The catalog a deployment serves when neither MODEL_CATALOG_FILE nor MODEL_CATALOG is set. */
export const shippedModelCatalogPath = fileURLToPath(new URL('../catalog/models.json', import.meta.url));

export class ModelCatalogError extends Error {
  constructor(source: string, detail: string) {
    super(`Invalid model catalog (${source}): ${detail}`);
    this.name = 'ModelCatalogError';
  }
}

/** Settings the catalog replaced, and what replaces each. Startup fails while one is set. */
export const removedModelSettings = Object.freeze({
  MODEL_FAMILIES: 'list the models to serve in "models"',
  MODEL_PAUSED_FAMILIES: 'set "paused": true on the model',
  MODEL_DEFAULT_FAMILY: 'set "default": true on the model',
  MODEL_CATALOG_MODE: 'the catalog replaces the shipped one entirely; copy the models to keep into it',
  CHAT_TITLE_MODEL_FAMILY: 'add "title" to the model\'s "roles"',
  SKILL_REVIEW_MODEL_FAMILY: 'add "review" to the model\'s "roles"',
  PLAN_SPECIALIST_MODEL_FAMILY: 'add "plan" to the model\'s "roles"',
  GMAIL_HEARTBEAT_MODEL_FAMILY: 'add "heartbeat" to the model\'s "roles"',
  PUBLIC_GUIDE_MODEL_FAMILY: 'add "public-guide" to the model\'s "roles"',
  TABLE_SEARCH_MODEL_FAMILY: 'add "table-search" to the model\'s "roles"',
  RECOMMENDATION_MODEL_FAMILY: 'add "recommendation" to the model\'s "roles"',
});

type Env = Record<string, string | undefined>;
const value = (env: Env, name: string) => env[name]?.trim() || undefined;

function rejectRemovedSettings(env: Env) {
  const set = Object.entries(removedModelSettings).filter(([name]) => value(env, name));
  if (set.length)
    throw new Error(
      `Model settings moved to the model catalog (MODEL_CATALOG_FILE or MODEL_CATALOG; see ${shippedModelCatalogPath}). Remove ${set
        .map(([name, replacement]) => `${name} (${replacement})`)
        .join(', ')}.`,
    );
}

const describeIssues = (error: z.ZodError) =>
  error.issues.map(issue => `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`).join('; ');

type ReadCatalog = { source: string; catalog: ModelCatalogFile };
const readCatalogs = new Map<string, ReadCatalog>();

/** The validated catalog the environment names, read once per file path or inline value. */
export function readModelCatalog(env: Env = process.env): ReadCatalog {
  rejectRemovedSettings(env);
  const file = value(env, 'MODEL_CATALOG_FILE');
  const inline = value(env, 'MODEL_CATALOG');
  if (file && inline) throw new ModelCatalogError('MODEL_CATALOG_FILE, MODEL_CATALOG', 'set only one of them');
  const key = inline === undefined ? `file:${file ?? shippedModelCatalogPath}` : `inline:${inline}`;
  const cached = readCatalogs.get(key);
  if (cached) return cached;
  const source = inline !== undefined ? 'MODEL_CATALOG' : file ? `MODEL_CATALOG_FILE=${file}` : 'shipped catalog';
  let text = inline ?? '';
  if (inline === undefined)
    try {
      text = readFileSync(file ?? shippedModelCatalogPath, 'utf8');
    } catch (error) {
      throw new ModelCatalogError(source, `cannot read the file (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ModelCatalogError(source, `not valid JSON (${(error as Error).message})`);
  }
  const parsed = modelCatalogFileSchema.safeParse(json);
  if (!parsed.success) throw new ModelCatalogError(source, describeIssues(parsed.error));
  const read = Object.freeze({ source, catalog: parsed.data });
  readCatalogs.set(key, read);
  return read;
}

type BaseUrlProvider = keyof typeof defaultModelEndpoints;
// Paths the request URLs append to these base URLs; a base URL that already ends in one would double it.
const appendedPaths: Partial<Record<BaseUrlProvider, string>> = { anthropic: '/v1/', google: '/v1beta/' };

export type ServedModelRoute = {
  /** The route's key in `providers`, or a built-in provider name. */
  readonly provider: string;
  readonly type: ModelProvider;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly endpointEnv: string;
  /** Normalized API base URL, checked against MODEL_ENDPOINT_HOSTS. */
  readonly endpoint: string;
};
export type ServedModel = Omit<ModelCatalogFileModel, 'pricing'> & {
  readonly pricing: ModelCatalogFileModel['pricing'];
  /** The first route whose key (and endpoint, where one is required) is set. */
  readonly route: ServedModelRoute;
  /** Rates of `pricing`; unmetered models record every token category at zero. */
  readonly rates: readonly ModelPrice[];
};
export type ServedImageModel = ModelCatalogFileImageModel & {
  /** The first route whose key (and endpoint, where one is required) is set. */
  readonly route: ServedModelRoute & { readonly api: ImageModelApi };
};
export type ServedModelCatalog = {
  /** Where the catalog came from: `MODEL_CATALOG_FILE=<path>`, `MODEL_CATALOG` or `shipped catalog`. */
  readonly source: string;
  readonly catalog: ModelCatalogFile;
  /** Served models, in catalog order. */
  readonly models: readonly ServedModel[];
  /** Models of the catalog left out because no route has its key (`"missingKeys": "skip"`). */
  readonly skipped: readonly string[];
  /** New chats, new agents and features without a model of their own use this model. */
  readonly defaultModel: ServedModel;
  model(id: string): ServedModel | undefined;
  /** The served model with `role`, or null when none has it. */
  role(role: ModelCatalogRole): ServedModel | null;
  /** Served image models, in catalog order. */
  readonly imageModels: readonly ServedImageModel[];
  imageModel(id: string): ServedImageModel | undefined;
  /** The served `"default": true` image model, or null. Another image model never replaces it. */
  readonly defaultImageModel: ServedImageModel | null;
  /** Startup notes about skipped models and a moved default. */
  readonly warnings: readonly string[];
};

const unmeteredRates: readonly ModelPrice[] = Object.freeze([
  modelPriceSchema.parse({
    validFrom: null,
    validUntilExclusive: null,
    promptTokensAbove: null,
    usdPerMillionTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  }),
]);

function providerOf(catalog: ModelCatalogFile, key: string) {
  const declared = catalog.providers[key];
  const type = (declared?.type ?? key) as ModelProvider;
  const defaults = type === 'openai-compatible' ? undefined : modelProviderDefaults[type];
  return {
    type,
    apiKeyEnv: declared?.apiKeyEnv ?? defaults!.apiKeyEnv,
    endpointEnv: declared?.endpointEnv ?? defaults!.endpointEnv,
  };
}

/** Variable names the catalog reads: provider keys and endpoints, including built-in defaults. */
export function modelCatalogEnvNames(catalog: ModelCatalogFile): readonly string[] {
  const providers = new Set(
    [...catalog.models, ...catalog.imageModels].flatMap(model => model.routes.map(route => route.provider)),
  );
  return [...providers].flatMap(key => {
    const provider = providerOf(catalog, key);
    return [provider.apiKeyEnv, provider.endpointEnv];
  });
}

const publicPrefix = /^(VITE_|NEXT_PUBLIC_|PUBLIC_)/;
const builtInModelVariable =
  /^(VITE_|NEXT_PUBLIC_|PUBLIC_)(MODEL_|AZURE_FOUNDRY_|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|GEMINI_API_KEY)/;

const servedCatalogs = new WeakMap<ModelCatalogFile, Map<string, ServedModelCatalog>>();

/**
 * The models this deployment serves: every model of the catalog that has a route with its key set (and endpoint, for
 * Azure and OpenAI-compatible providers). Throws when the catalog is invalid, a removed setting is set, a key sits in a
 * public variable, an endpoint is not allowed, or no model can be served.
 */
export function loadModelCatalog(env: Env = process.env): ServedModelCatalog {
  const { source, catalog } = readModelCatalog(env);
  const names = modelCatalogEnvNames(catalog);
  const exposed = Object.keys(env).filter(
    key =>
      env[key] &&
      (builtInModelVariable.test(key) || (publicPrefix.test(key) && names.includes(key.replace(publicPrefix, '')))),
  );
  if (exposed.length)
    throw new Error(
      `Invalid server model configuration: ${exposed.join(', ')} would reach the browser; set model keys and endpoints without a VITE_, NEXT_PUBLIC_ or PUBLIC_ prefix`,
    );
  const key = JSON.stringify([
    names.map(name => value(env, name) ?? null),
    env.MODEL_ENDPOINT_HOSTS ?? null,
    env.NODE_ENV ?? null,
  ]);
  const cache = servedCatalogs.get(catalog) ?? new Map<string, ServedModelCatalog>();
  servedCatalogs.set(catalog, cache);
  const cached = cache.get(key);
  if (cached) return cached;
  try {
    modelEndpointHosts(env);
  } catch (error) {
    throw new Error(`Invalid server model configuration: ${(error as Error).message}`);
  }
  const fail = (detail: string) => new ModelCatalogError(source, detail);
  /** The first route of `routes` whose provider has its key (and endpoint) set, and the variables it needs. */
  function firstRoute(at: string, routes: readonly { provider: string; model: string }[]) {
    let route: ServedModelRoute | undefined;
    let routeIndex = -1;
    const needed: string[] = [];
    for (const [index, { provider: key, model: name }] of routes.entries()) {
      const provider = providerOf(catalog, key);
      const endpointRequired = provider.type === 'azure' || provider.type === 'openai-compatible';
      const configured = value(env, provider.endpointEnv);
      needed.push(endpointRequired ? `${provider.apiKeyEnv} and ${provider.endpointEnv}` : provider.apiKeyEnv);
      if (!value(env, provider.apiKeyEnv) || (endpointRequired && !configured)) continue;
      const where = `${at}.routes.${index}: ${provider.endpointEnv}`;
      let endpoint: string | undefined = defaultModelEndpoints[provider.type as BaseUrlProvider];
      if (configured) {
        const shape = modelEndpointShapeProblem(configured);
        if (shape) throw fail(`${where} ${shape}`);
        endpoint = normalizeModelEndpoint(configured);
        const problem = modelEndpointProblem(provider.type, endpoint, env);
        if (problem) throw fail(`${where} ${problem}`);
        const appended = appendedPaths[provider.type as BaseUrlProvider];
        if (appended && endpoint.endsWith(appended)) throw fail(`${where} must not end in ${appended}; it is appended`);
      }
      if (!route) {
        route = Object.freeze({ provider: key, ...provider, model: name, endpoint: endpoint! });
        routeIndex = index;
      }
    }
    return { route, routeIndex, needed };
  }
  const missing = (at: string, id: string, needed: string[]) =>
    fail(
      `${at} "${id}" has no route with its key set; set ${needed.join(', or ')}, remove the model, or set "missingKeys": "skip"`,
    );
  const served: ServedModel[] = [];
  const skipped: string[] = [];
  for (const [index, model] of catalog.models.entries()) {
    const { route, needed } = firstRoute(`models.${index}`, model.routes);
    if (route)
      served.push(
        Object.freeze({
          ...model,
          route,
          rates:
            model.pricing === 'unmetered' ? unmeteredRates : model.pricing.map(rate => modelPriceSchema.parse(rate)),
        }),
      );
    else if (catalog.missingKeys === 'skip') skipped.push(model.id);
    else throw missing(`models.${index}`, model.id, needed);
  }
  const servedImages: ServedImageModel[] = [];
  for (const [index, image] of catalog.imageModels.entries()) {
    const { route, routeIndex, needed } = firstRoute(`imageModels.${index}`, image.routes);
    if (route)
      servedImages.push(
        Object.freeze({ ...image, route: Object.freeze({ ...route, api: image.routes[routeIndex]!.api }) }),
      );
    else if (catalog.missingKeys === 'skip') skipped.push(image.id);
    else throw missing(`imageModels.${index}`, image.id, needed);
  }
  if (!served.length)
    throw fail(
      `no model has a route with its key set; set a provider key such as ${[...new Set(catalog.models.flatMap(model => model.routes.map(route => providerOf(catalog, route.provider).apiKeyEnv)))].join(', ')}`,
    );
  const warnings = skipped.length ? [`Models without a provider key are not served: ${skipped.join(', ')}.`] : [];
  const declared = catalog.models.find(model => model.default)!;
  let defaultModel = served.find(model => model.id === declared.id);
  if (!defaultModel) {
    defaultModel = served.find(model => model.selectable && !model.paused);
    if (!defaultModel) throw fail(`the default model "${declared.id}" is not served and no other model can replace it`);
    warnings.push(`The default model ${declared.id} is not served; ${defaultModel.id} is the default.`);
  }
  const result: ServedModelCatalog = Object.freeze({
    source,
    catalog,
    models: Object.freeze(served),
    skipped: Object.freeze(skipped),
    defaultModel,
    model: (id: string) => served.find(model => model.id === id),
    role: (role: ModelCatalogRole) => served.find(model => model.roles.includes(role)) ?? null,
    imageModels: Object.freeze(servedImages),
    imageModel: (id: string) => servedImages.find(image => image.id === id),
    defaultImageModel: servedImages.find(image => image.default) ?? null,
    warnings: Object.freeze(warnings),
  });
  cache.set(key, result);
  return result;
}

/**
 * Capabilities of a provider model (deployment): provider defaults, the catalog model it serves, then `overrides`.
 * Reads the catalog of `process.env`.
 */
export function modelCapabilities(
  provider: ModelProvider,
  providerModelId: string,
  ...overrides: readonly (ModelCapabilityOverrides | undefined)[]
) {
  const { catalog } = readModelCatalog(process.env);
  const model = catalog.models.find(candidate =>
    candidate.routes.some(
      route => route.model === providerModelId && providerOf(catalog, route.provider).type === provider,
    ),
  );
  return resolveModelCapabilities(provider, model?.capabilities, ...overrides);
}
