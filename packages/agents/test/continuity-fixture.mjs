import { initialBundleModels, initialModelMapping, modelBundleSchema } from '@tulipfarm/config';

export const syntheticModelBundle = modelBundleSchema.parse({
  format: 1,
  id: 'synthetic-bundle',
  mapping: {
    ...initialModelMapping,
    revision: 'synthetic-mapping',
    families: initialModelMapping.families.filter(family => ['claude-opus', 'gpt-astra'].includes(family.id)),
  },
  models: initialBundleModels,
  routes: [
    { id: 'primary', modelId: 'claude-opus-5-5', provider: 'anthropic', deployment: 'claude-opus-5-5' },
    { id: 'fallback', modelId: 'gpt-6-astra', provider: 'azure', deployment: 'synthetic-astra' },
  ].map(route => ({
    ...route,
    location: 'test',
    adapterVersion: 1,
    qualification: 'synthetic local protocol fixture only',
    lifecycle: 'current',
    maxInputTokens: 20000,
    maxOutputTokens: 4096,
    boundedDecision: true,
  })),
});

export function syntheticContinuity(model) {
  return {
    activeBundle: () => ({ bundle: syntheticModelBundle, activationRevision: 1 }),
    restrictions: () => ({ allowedProviders: ['anthropic', 'azure'], allowedLocations: ['test'] }),
    trustedBundle: id => {
      if (id !== syntheticModelBundle.id) throw new Error('Unknown test bundle');
      return syntheticModelBundle;
    },
    allowed: () => true,
    actualModelIds: resolution => [resolution.modelId],
    legacyFamily: () => 'claude-opus',
    budgetPicoUsd: () => '10000000000000',
    health: { claim: async () => true, finish: async () => {} },
    infer: async (resolution, input) => ({
      kind: 'success',
      decision: await model(input),
      actualModel: resolution.modelId,
      requestId: 'synthetic',
      usage: { kind: 'unknown' },
    }),
  };
}
