import { z } from 'zod';

export const modelProviderSchema = z.enum(['anthropic', 'openai', 'xai', 'google', 'azure', 'openai-compatible']);
export type ModelProvider = z.infer<typeof modelProviderSchema>;

export const modelCapabilitiesSchema = z
  .strictObject({
    api: z
      .enum(['chat-completions', 'responses', 'anthropic-messages', 'gemini'])
      .optional()
      .describe(
        'Wire API. OpenAI, xAI, Azure and OpenAI-compatible endpoints support chat-completions and responses; Anthropic anthropic-messages; Google gemini',
      ),
    toolChoice: z
      .enum(['auto', 'forced'])
      .optional()
      .describe('Structured decisions force the select_action tool, or let the model answer in text (auto)'),
    reasoningOffForTools: z
      .boolean()
      .optional()
      .describe('Disable reasoning on tool requests the deployment rejects with reasoning on'),
    reasoningTokensInOutput: z
      .boolean()
      .optional()
      .describe('Usage reports reasoning tokens separately from completion tokens; count them as output'),
    streaming: z.boolean().optional().describe('Chat steps stream the response'),
    responseModelAliases: z
      .array(z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/))
      .readonly()
      .optional()
      .describe('Other model identities the provider may report for this model'),
  })
  .readonly();
export type ModelCapabilityOverrides = z.infer<typeof modelCapabilitiesSchema>;
export type ModelCapabilities = {
  readonly [Key in keyof ModelCapabilityOverrides]-?: Exclude<ModelCapabilityOverrides[Key], undefined>;
};

const base = {
  toolChoice: 'forced',
  reasoningOffForTools: false,
  reasoningTokensInOutput: false,
  responseModelAliases: [],
} as const;
export const providerModelCapabilities: Readonly<Record<ModelProvider, ModelCapabilities>> = Object.freeze({
  anthropic: Object.freeze({ ...base, api: 'anthropic-messages', streaming: true }),
  openai: Object.freeze({ ...base, api: 'chat-completions', streaming: true }),
  xai: Object.freeze({ ...base, api: 'chat-completions', streaming: true }),
  google: Object.freeze({ ...base, api: 'gemini', streaming: true }),
  azure: Object.freeze({ ...base, api: 'chat-completions', streaming: true }),
  'openai-compatible': Object.freeze({ ...base, api: 'chat-completions', streaming: true }),
});
const providerApis: Readonly<Record<ModelProvider, readonly ModelCapabilities['api'][]>> = {
  anthropic: ['anthropic-messages'],
  openai: ['chat-completions', 'responses'],
  xai: ['chat-completions', 'responses'],
  google: ['gemini'],
  azure: ['chat-completions', 'responses'],
  'openai-compatible': ['chat-completions', 'responses'],
};

export function modelApiSupported(provider: ModelProvider, api: ModelCapabilities['api'] | undefined) {
  return api === undefined || providerApis[provider].includes(api);
}

/** Provider defaults, then each override layer in order. Undefined fields keep the earlier value. */
export function resolveModelCapabilities(
  provider: ModelProvider,
  ...layers: readonly (ModelCapabilityOverrides | undefined)[]
): ModelCapabilities {
  const resolved: Record<string, unknown> = { ...providerModelCapabilities[provider] };
  for (const layer of layers)
    for (const [key, value] of Object.entries(layer ?? {})) if (value !== undefined) resolved[key] = value;
  const capabilities = resolved as ModelCapabilities;
  if (!modelApiSupported(provider, capabilities.api))
    throw new Error(`Model API ${capabilities.api} is not supported by provider ${provider}`);
  return Object.freeze({
    ...capabilities,
    responseModelAliases: Object.freeze([...capabilities.responseModelAliases]),
  });
}
