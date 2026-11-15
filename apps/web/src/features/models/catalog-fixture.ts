import type { ModelCatalog, ModelCatalogFamily } from '@tulipfarm/config/model-catalog';

type FixtureFamily = Pick<ModelCatalogFamily, 'displayName' | 'vendor' | 'provider' | 'currentVersion'>;

type Row = [id: string, displayName: string, vendor: string, provider: FixtureFamily['provider'], version: string];

// The one catalog-shaped fixture for dev mocks and browser tests. Node imports it from tests, so imports stay type-only.
const rows: Row[] = [
  ['claude-haiku', 'Claude Haiku 4.5', 'anthropic', 'anthropic', 'claude-haiku-4-5'],
  ['claude-sonnet', 'Claude Sonnet 5', 'anthropic', 'anthropic', 'claude-sonnet-5'],
  ['claude-opus', 'Claude Opus 5.5', 'anthropic', 'anthropic', 'claude-opus-5-5'],
  ['claude-fable', 'Claude Fable 5.1', 'anthropic', 'anthropic', 'claude-fable-5-1'],
  ['gpt-luna', 'GPT-6 Luna', 'openai', 'azure', 'gpt-6-luna'],
  ['gpt-sol', 'GPT-6 Sol', 'openai', 'azure', 'gpt-6-sol'],
  ['gpt-astra', 'GPT-6 Astra', 'openai', 'azure', 'gpt-6-astra'],
  ['deepseek-pro', 'DeepSeek V4 Pro', 'deepseek', 'azure', 'deepseek-v4-pro'],
  ['deepseek-flash', 'DeepSeek V4 Flash', 'deepseek', 'azure', 'deepseek-v4-flash'],
  ['grok', 'Grok 4.6', 'xai', 'azure', 'grok-4-6'],
  ['grok-fast', 'Grok 4.3 Fast', 'xai', 'azure', 'grok-4.3'],
  ['kimi', 'Kimi K2.6', 'moonshot', 'azure', 'kimi-k2-6'],
  ['kimi-code', 'Kimi K2.7 Code', 'moonshot', 'azure', 'kimi-k2-7-code'],
  ['gemini-flash', 'Gemini 3.8 Flash', 'google', 'google', 'gemini-3-8-flash'],
  ['gemini-pro', 'Gemini 3.1 Pro', 'google', 'google', 'gemini-3-1-pro'],
];
// Operator catalog entries (MODEL_CATALOG_FILE): a known vendor, an unknown one, and an OpenAI-compatible server.
const external: Row[] = [
  ['acme-claude', 'Acme Claude 1 EU', 'anthropic', 'azure', 'acme-claude-1'],
  ['acme-chat', 'Acme Chat 1', 'acme', 'azure', 'acme-chat-1'],
  ['local-llama', 'Local Llama 4', 'openai-compatible', 'openai', 'llama-4'],
];
const families = new Map<string, FixtureFamily>(
  [...rows, ...external].map(([id, displayName, vendor, provider, currentVersion]) => [
    id,
    { displayName, vendor, provider, currentVersion },
  ]),
);

export const shippedCatalogFamilyIds = rows.map(([id]) => id);
export const externalCatalogFamilyIds = external.map(([id]) => id);

/** An available catalog family; unknown ids need `displayName` and `vendor` overrides. */
export function catalogFamily(id: string, overrides: Partial<ModelCatalogFamily> = {}): ModelCatalogFamily {
  const known = families.get(id);
  const displayName = overrides.displayName ?? known?.displayName;
  const vendor = overrides.vendor ?? known?.vendor;
  if (!displayName || !vendor) throw new Error(`Catalog fixture family ${id} needs a displayName and vendor`);
  return {
    id,
    displayName,
    vendor,
    provider: known?.provider ?? 'azure',
    currentVersion: known?.currentVersion ?? `${id}-fixture`,
    inputCreditsPerMillionTokens: 100,
    outputCreditsPerMillionTokens: 500,
    available: true,
    unavailableReason: null,
    mappingRevision: 'fixture-mapping',
    pricingRevision: 'fixture-pricing',
    fallbackFor: [],
    imageInput: false,
    imageModelId: null,
    ...overrides,
  } as ModelCatalogFamily;
}

export function catalogFixture(ids: readonly string[] = shippedCatalogFamilyIds): ModelCatalog {
  return {
    families: ids.map(id => catalogFamily(id)),
    imageModels: [],
    defaultChatFamilyId: ids.includes('claude-sonnet') ? 'claude-sonnet' : (ids[0] ?? null),
  };
}
