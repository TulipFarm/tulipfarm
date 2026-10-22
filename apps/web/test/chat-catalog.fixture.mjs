import { catalogFamily } from '../src/features/models/catalog-fixture.ts';

export const chatCatalog = {
  families: [
    ['claude-sonnet', 'anthropic'],
    ['gpt-sol', 'azure'],
    ['claude-haiku', 'anthropic'],
    ['deepseek-pro', 'azure'],
    ['deepseek-flash', 'azure'],
    ['kimi', 'azure'],
    ['kimi-code', 'azure'],
    ['gemini-pro', 'google'],
  ].map(([id, provider]) =>
    catalogFamily(id, {
      provider,
      currentVersion: `${id}-fixture`,
      ...(id === 'gemini-pro' ? { available: false, unavailableReason: 'model-family-unavailable' } : {}),
    }),
  ),
};
