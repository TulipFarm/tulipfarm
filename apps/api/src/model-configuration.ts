import type { Pool } from 'pg';
import { createModelRouteHealth, type ModelContinuity } from '@tulipfarm/agents/chat';
import type { ModelFamilyEligibility } from '@tulipfarm/agents/model-policy';
import { modelBundleStore } from '@tulipfarm/agents/model-bundles';
import type { ModelCatalogSnapshot } from './model-catalog.ts';
import { modelEnvironment } from './model-environment.ts';

export function createModelConfiguration(input: { pool: Pool; env?: NodeJS.ProcessEnv }) {
  const environment = modelEnvironment(input.env);
  const modelFamilyResolution: ModelCatalogSnapshot['modelFamilyResolution'] = request => {
    const resolution = environment?.resolve(request.modelFamilyId);
    if (!resolution) return null;
    return {
      familyId: resolution.familyId,
      modelId: resolution.modelId,
      mappingRevision: resolution.mappingRevision,
      pricingRevision: resolution.pricingRevision,
      rates: resolution.rates,
      route: {
        modelId: resolution.route.modelId,
        provider: resolution.route.provider,
        lifecycle: resolution.route.lifecycle,
        boundedDecision: resolution.route.boundedDecision,
      },
    };
  };
  const snapshot: ModelCatalogSnapshot = {
    modelFamilyResolution,
    modelFamilyEligibility: request => {
      if (!modelFamilyResolution(request)) return false;
      if (request.fallbackFor === undefined) return true;
      return (
        request.fallbackFor !== request.modelFamilyId &&
        modelFamilyResolution({ workspaceId: request.workspaceId, modelFamilyId: request.fallbackFor }) !== null
      );
    },
  };
  const modelFamilyEligibility: ModelFamilyEligibility = async request => snapshot.modelFamilyEligibility(request);
  const bundles = modelBundleStore(input.pool);
  const modelContinuity: ModelContinuity | null =
    environment?.continuity(key => createModelRouteHealth(input.pool, key), bundles) ?? null;
  /** Records this server's bundle so runs admitted under it stay valid after a configuration change. */
  const registerModelBundle = async () => {
    if (environment) await bundles.register(environment.bundle);
  };
  return {
    modelCatalogSnapshot: async (_workspaceId: string) => snapshot,
    modelFamilyEligibility,
    modelContinuity,
    registerModelBundle,
  };
}
