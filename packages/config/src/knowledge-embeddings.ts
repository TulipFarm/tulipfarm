import { z } from 'zod';

export const knowledgeEmbeddingProfile = Object.freeze({
  id: 'azure-eastus-text-embedding-3-large-v1-1536-cl100k-prep1',
  provider: 'azure-openai',
  region: 'eastus',
  resourceKind: 'AIServices',
  deploymentName: 'text-embedding-3-large',
  deploymentSku: 'GlobalStandard',
  model: 'text-embedding-3-large',
  modelVersion: '1',
  dimensions: 1536,
  tokenizer: 'cl100k_base',
  tokenizerVersion: 'js-tiktoken@1.0.21',
  inputPreparationRevision: 'final-input-verbatim-v1',
  maxInputTokens: 8192,
  maxBatchInputs: 32,
  maxBatchTokens: 16384,
  maxInputBytes: 131072,
  quota: Object.freeze({ tokens: 500000, tokenWindowSeconds: 60, requests: 500, requestWindowSeconds: 10 }),
  pricing: Object.freeze({
    revision: 'azure-eastus-embedding-3-large-global-2026-10-03',
    inspectedOn: '2026-10-03',
    effectiveFrom: '2024-06-01',
    source:
      'https://prices.azure.com/api/retail/prices?%24filter=armRegionName%20eq%20%27eastus%27%20and%20meterId%20eq%20%273bb5c055-3783-5f9b-bb9f-efc93d2784b9%27',
    productName: 'Azure OpenAI',
    skuName: 'text-embedding-3-large-glbl',
    meterId: '3bb5c055-3783-5f9b-bb9f-efc93d2784b9',
    skuId: 'DZH318Z0HHG7/0HK4',
    currency: 'USD',
    unitOfMeasure: '1K',
    usdPerUnit: '0.00013',
    providerPicoUsdPerToken: '130000',
  }),
});

export type KnowledgeEmbeddingProfile = typeof knowledgeEmbeddingProfile;
export type KnowledgeEmbeddingsProvider = 'azure-foundry' | 'openai-compatible';
export type KnowledgeEmbeddingsConfig =
  | { readonly kind: 'disabled' }
  | {
      readonly kind: 'enabled';
      readonly provider: KnowledgeEmbeddingsProvider;
      /** Base URL with a trailing slash. Azure Foundry appends `openai/v1/embeddings`; OpenAI-compatible appends `embeddings`. */
      readonly endpoint: string;
      readonly apiKey: string;
      /** Model or deployment name sent in the request. Responses must still report `profile.model`. */
      readonly requestModel: string;
      readonly profile: KnowledgeEmbeddingProfile;
    };

// HTTPS, or plain HTTP only on loopback. No credentials, query, or fragment.
const baseUrlPattern =
  /^(?:https:\/\/[a-z0-9.-]+|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]))(?::\d{1,5})?(?:\/[\w.~%-]+)*\/?$/i;

function baseUrl(value: string | undefined) {
  if (!value || !baseUrlPattern.test(value)) return undefined;
  return value.endsWith('/') ? value : `${value}/`;
}

/**
 * Stored vectors use one profile: `text-embedding-3-large` at 1536 dimensions, matching
 * `vector(1536)` in workspace storage. Any provider must return that model and size.
 */
export function parseKnowledgeEmbeddingsConfig(
  env: Readonly<Record<string, string | undefined>>,
): KnowledgeEmbeddingsConfig {
  const invalid = () => new Error('Invalid server knowledge embeddings configuration');
  for (const key of Object.keys(env)) {
    if (/^(PUBLIC_|VITE_|NEXT_PUBLIC_)(KNOWLEDGE_EMBEDDINGS_|AZURE_FOUNDRY_)/.test(key) && env[key] !== undefined)
      throw invalid();
  }
  const enabled = env.KNOWLEDGE_EMBEDDINGS_ENABLED;
  if (enabled === undefined || enabled === '' || enabled === 'false') return Object.freeze({ kind: 'disabled' });
  if (enabled !== 'true') throw invalid();
  const profile = knowledgeEmbeddingProfile;
  const provider = env.KNOWLEDGE_EMBEDDINGS_PROVIDER || 'azure-foundry';
  if (provider !== 'azure-foundry' && provider !== 'openai-compatible') throw invalid();
  const dimensions = env.KNOWLEDGE_EMBEDDINGS_DIMENSIONS;
  if (dimensions && dimensions !== String(profile.dimensions)) throw invalid();
  const requestModel =
    env.KNOWLEDGE_EMBEDDINGS_MODEL || (provider === 'azure-foundry' ? profile.deploymentName : profile.model);
  if (!/^[\x21-\x7e]{1,256}$/.test(requestModel)) throw invalid();
  const endpoint =
    provider === 'azure-foundry' ? baseUrl(env.AZURE_FOUNDRY_ENDPOINT) : baseUrl(env.KNOWLEDGE_EMBEDDINGS_BASE_URL);
  const apiKey = provider === 'azure-foundry' ? env.AZURE_FOUNDRY_API_KEY : env.KNOWLEDGE_EMBEDDINGS_API_KEY;
  if (!endpoint || !apiKey || !/^[\x21-\x7e]+$/.test(apiKey)) throw invalid();
  return Object.freeze({ kind: 'enabled', provider, endpoint, apiKey, requestModel, profile });
}

export function calculateKnowledgeEmbeddingCost(input: { inputTokens: number; date: string }) {
  const parsed = z
    .object({
      inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      date: z.iso.date().refine(date => date >= knowledgeEmbeddingProfile.pricing.effectiveFrom),
    })
    .safeParse(input);
  if (!parsed.success) throw new Error('Invalid knowledge embedding cost input');
  return {
    providerPicoUsd: (
      BigInt(parsed.data.inputTokens) * BigInt(knowledgeEmbeddingProfile.pricing.providerPicoUsdPerToken)
    ).toString(),
    pricingRevision: knowledgeEmbeddingProfile.pricing.revision,
    date: parsed.data.date,
  };
}
