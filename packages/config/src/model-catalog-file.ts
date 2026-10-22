import { z } from 'zod';
import { modelApiSupported, modelCapabilitiesSchema, modelProviderSchema } from './model-capabilities.ts';
import { modelFamilyIdSchema, modelIdentifierSchema } from './model-identifier.ts';

// The model catalog file: every model a deployment serves, how each is reached, what it costs, and which one is the
// default. The app validates it at startup; `schemas/model-catalog.v1.json` is generated from this module.

export const modelCatalogSchemaUrl = 'https://tulipfarm.ai/schemas/model-catalog.v1.json';

/**
 * Background features that use a model nobody chose. Without a model that has the role, titles come from the chat's
 * model, table search and recommendations are off, and the other features use the default model.
 */
export const modelCatalogRoles = Object.freeze([
  'title',
  'compaction',
  'review',
  'plan',
  'heartbeat',
  'public-guide',
  'table-search',
  'recommendation',
] as const);
export type ModelCatalogRole = (typeof modelCatalogRoles)[number];

/** Environment variables a provider reads when the catalog does not name others. */
export const modelProviderDefaults = Object.freeze({
  anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY', endpointEnv: 'ANTHROPIC_BASE_URL' },
  openai: { apiKeyEnv: 'OPENAI_API_KEY', endpointEnv: 'OPENAI_BASE_URL' },
  xai: { apiKeyEnv: 'XAI_API_KEY', endpointEnv: 'XAI_BASE_URL' },
  google: { apiKeyEnv: 'GEMINI_API_KEY', endpointEnv: 'GEMINI_BASE_URL' },
  azure: { apiKeyEnv: 'AZURE_FOUNDRY_API_KEY', endpointEnv: 'AZURE_FOUNDRY_ENDPOINT' },
} as const);
type BuiltInProvider = keyof typeof modelProviderDefaults;
const builtInProviders = Object.keys(modelProviderDefaults) as BuiltInProvider[];

const envName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,127}$/, 'Must be an environment variable name')
  .refine(name => !/^(VITE_|NEXT_PUBLIC_|PUBLIC_)/.test(name), 'Must not be a public (client-exposed) variable');

const providerSchema = z
  .strictObject({
    type: modelProviderSchema.describe('API this provider speaks'),
    apiKeyEnv: envName
      .optional()
      .describe(
        'Environment variable holding the API key. Never the key itself. Defaults to the type\'s standard variable, such as AZURE_FOUNDRY_API_KEY; required for type "openai-compatible".',
      ),
    endpointEnv: envName
      .optional()
      .describe(
        'Environment variable holding the API base URL. Defaults to the type\'s standard variable, such as AZURE_FOUNDRY_ENDPOINT; required for type "openai-compatible".',
      ),
  })
  .describe('How to reach one provider account. Models name it by its key in `providers`.');

const usd = z.number().nonnegative();
const rateSchema = z
  .strictObject({
    validFrom: z.iso.date().nullable().default(null).describe('First day this rate applies (UTC); null for always'),
    validUntilExclusive: z.iso
      .date()
      .nullable()
      .default(null)
      .describe('Day this rate stops applying (UTC); null for open-ended'),
    promptTokensAbove: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .default(null)
      .describe(
        'Long-context tier: applies to whole requests whose prompt exceeds this many tokens; null for base rate',
      ),
    usdPerMillionTokens: z.strictObject({
      input: usd,
      output: usd,
      cacheRead: usd.optional(),
      cacheWrite: usd.optional(),
      cacheWrite5m: usd.optional(),
      cacheWrite1h: usd.optional(),
    }),
  })
  .describe('A price in USD per million tokens');

const tokenLimit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const routeSchema = z
  .strictObject({
    provider: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,49}$/)
      .describe(
        'A key in `providers`, or a built-in provider (anthropic, openai, xai, google, azure) with its standard variables',
      ),
    model: z
      .string()
      .min(1)
      .max(200)
      .describe('Model or deployment name sent to the provider, such as an Azure Foundry deployment name'),
  })
  .describe('One provider that serves the model');

const modelSchema = z
  .strictObject({
    id: modelFamilyIdSchema.describe(
      'Stable ID chats, agents and settings store. Keep it when the underlying model version changes.',
    ),
    name: z.string().min(1).max(100).describe('Name people see in the model picker'),
    vendor: modelIdentifierSchema.describe('Who makes the model, for branding, such as anthropic or openai'),
    routes: z
      .array(routeSchema)
      .min(1)
      .describe(
        'Where the model runs, in order of preference. The first route whose provider has its API key set serves it; see `missingKeys` for when none has.',
      ),
    default: z
      .boolean()
      .default(false)
      .describe('New chats and agents use this model. Exactly one model is the default; it must be selectable.'),
    paused: z
      .boolean()
      .default(false)
      .describe('Still serves existing chats and agents, but cannot be chosen for new ones'),
    selectable: z
      .boolean()
      .default(true)
      .describe(
        'Shown in the model picker. False keeps the model for its roles only, such as a cheap model that titles chats.',
      ),
    roles: z
      .array(z.enum(modelCatalogRoles))
      .default([])
      .describe(
        `Background features this model runs: ${modelCatalogRoles.join(', ')}. Each role on at most one model.`,
      ),
    limits: z.strictObject({
      maxInputTokens: tokenLimit,
      maxOutputTokens: tokenLimit,
    }),
    capabilities: modelCapabilitiesSchema.optional().describe("Overrides of the provider type's default behavior"),
    pricing: z
      .union([
        z.literal('unmetered').describe('Tokens are recorded at zero cost'),
        z.array(rateSchema).min(1).describe('Rates; one must have no tier and no dates limits overlap'),
      ])
      .describe('"unmetered", or the rates this deployment is billed'),
    notes: z.array(z.string()).optional().describe('Free-form notes, such as where prices were checked'),
  })
  .describe('One model people can choose');

const catalogShape = z
  .strictObject({
    $schema: z.string().optional().describe(`Schema URL for editors: ${modelCatalogSchemaUrl}`),
    version: z.literal(1).describe('Catalog format version'),
    missingKeys: z
      .enum(['fail', 'skip'])
      .default('fail')
      .describe(
        'When no route of a model has its API key set: "fail" stops startup; "skip" leaves the model out. With "skip", a skipped default passes to the first remaining selectable, unpaused model, and a skipped role falls back as if no model had it. Startup fails when no model remains.',
      ),
    providers: z
      .record(z.string().regex(/^[a-z][a-z0-9-]{0,49}$/), providerSchema)
      .default({})
      .describe("Provider accounts. Only needed to use other variables than a built-in provider's defaults."),
    models: z.array(modelSchema).min(1),
  })
  .describe('TulipFarm model catalog: every model a deployment serves');

type CatalogShape = z.infer<typeof catalogShape>;
type Issue = { path: (string | number)[]; message: string };

function rateProblems(rates: readonly z.infer<typeof rateSchema>[]): Issue[] {
  const issues: Issue[] = [];
  if (!rates.some(rate => rate.promptTokensAbove === null))
    issues.push({ path: [], message: 'Needs a base rate (promptTokensAbove null)' });
  for (const [index, rate] of rates.entries()) {
    if (rate.validFrom && rate.validUntilExclusive && rate.validFrom >= rate.validUntilExclusive)
      issues.push({ path: [index], message: 'validFrom must be before validUntilExclusive' });
    for (const [category, amount] of Object.entries(rate.usdPerMillionTokens))
      if (amount !== undefined && !/^\d+(\.\d{1,6})?$/.test(String(amount)))
        issues.push({ path: [index, 'usdPerMillionTokens', category], message: 'At most 6 decimal places' });
    const overlaps = rates
      .slice(index + 1)
      .some(
        other =>
          other.promptTokensAbove === rate.promptTokensAbove &&
          (rate.validFrom === null ||
            other.validUntilExclusive === null ||
            rate.validFrom < other.validUntilExclusive) &&
          (other.validFrom === null || rate.validUntilExclusive === null || other.validFrom < rate.validUntilExclusive),
      );
    if (overlaps) issues.push({ path: [index], message: 'Overlaps another rate with the same tier' });
  }
  return issues;
}

const providerType = (catalog: CatalogShape, key: string) =>
  catalog.providers[key]?.type ?? builtInProviders.find(name => name === key);

/** Rules across entries that JSON Schema cannot state. */
function catalogProblems(catalog: CatalogShape): Issue[] {
  const issues: Issue[] = [];
  for (const [key, provider] of Object.entries(catalog.providers)) {
    if ((builtInProviders as string[]).includes(key) && provider.type !== key)
      issues.push({ path: ['providers', key, 'type'], message: `Provider "${key}" must have type "${key}"` });
    if (provider.type === 'openai-compatible')
      for (const field of ['apiKeyEnv', 'endpointEnv'] as const)
        if (!provider[field])
          issues.push({ path: ['providers', key, field], message: 'Required for type "openai-compatible"' });
  }
  const seen = new Set<string>();
  const roleOwners = new Map<string, number>();
  for (const [index, model] of catalog.models.entries()) {
    const at = (...path: (string | number)[]) => ['models', index, ...path];
    if (seen.has(model.id)) issues.push({ path: at('id'), message: `Duplicate model id "${model.id}"` });
    seen.add(model.id);
    const types = model.routes.map((route, routeIndex) => {
      const type = providerType(catalog, route.provider);
      if (!type)
        issues.push({
          path: at('routes', routeIndex, 'provider'),
          message: `Unknown provider "${route.provider}"; declare it in providers`,
        });
      else if (!modelApiSupported(type, model.capabilities?.api))
        issues.push({ path: at('capabilities', 'api'), message: `Provider type ${type} does not support this API` });
      if (model.routes.findIndex(other => other.provider === route.provider) !== routeIndex)
        issues.push({
          path: at('routes', routeIndex, 'provider'),
          message: `Duplicate route provider "${route.provider}"`,
        });
      return type;
    });
    if (model.default && model.paused)
      issues.push({ path: at('paused'), message: 'The default model cannot be paused' });
    if (model.default && !model.selectable)
      issues.push({ path: at('selectable'), message: 'The default model must be selectable' });
    if (
      model.roles.includes('public-guide') &&
      (!types.includes('azure') || (model.capabilities?.api ?? 'chat-completions') !== 'chat-completions')
    )
      issues.push({
        path: at('roles'),
        message: 'The public-guide model needs an Azure route using the chat-completions API',
      });
    for (const [roleIndex, role] of model.roles.entries()) {
      if (model.roles.indexOf(role) !== roleIndex)
        issues.push({ path: at('roles', roleIndex), message: `Duplicate role "${role}"` });
      const owner = roleOwners.get(role);
      if (owner !== undefined && owner !== index)
        issues.push({ path: at('roles', roleIndex), message: `Role "${role}" is already on models[${owner}]` });
      else roleOwners.set(role, index);
    }
    if (model.pricing !== 'unmetered')
      for (const issue of rateProblems(model.pricing))
        issues.push({ path: at('pricing', ...issue.path), message: issue.message });
  }
  const defaults = catalog.models.filter(model => model.default).length;
  if (defaults !== 1)
    issues.push({ path: ['models'], message: `Exactly one model must have "default": true; found ${defaults}` });
  return issues;
}

export const modelCatalogFileSchema = catalogShape.superRefine((catalog, ctx) => {
  for (const issue of catalogProblems(catalog)) ctx.addIssue({ code: 'custom', ...issue });
});
export type ModelCatalogFile = z.infer<typeof modelCatalogFileSchema>;
export type ModelCatalogFileModel = ModelCatalogFile['models'][number];

/** The published JSON Schema. Cross-entry rules, such as one default and unique roles, are enforced only by the validator. */
export function modelCatalogJsonSchema() {
  return {
    ...z.toJSONSchema(catalogShape, { target: 'draft-2020-12', io: 'input' }),
    $id: modelCatalogSchemaUrl,
    title: 'TulipFarm model catalog',
  };
}
