import shippedPricing from './model-pricing.json' with { type: 'json' };
import { modelCatalogModels } from './model-continuity.ts';

/** Pricing policy and sources of the shipped catalog, with the models of the effective catalog. */
export const modelPricing = Object.freeze({ ...shippedPricing, models: modelCatalogModels });
export { ModelCatalogError, modelCatalogModes, type ModelCatalogMode } from './model-catalog-source.ts';
export * from './model-continuity.ts';
export * from './model-capabilities.ts';
export * from './model-endpoints.ts';
export * from './model-cost.ts';
export * from './model-bundle.ts';
export * from './knowledge-embeddings.ts';
export * from './compaction.ts';
export * from './model-roles.ts';
export * from './model-role-defaults.ts';
export * from './timeouts.ts';
