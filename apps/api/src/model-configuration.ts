import type { Pool } from 'pg';
import { createModelRouteHealth, type ModelContinuity } from '@tulipfarm/agents/chat';
import type { ModelFamilyEligibility } from '@tulipfarm/agents/model-policy';
import { modelBundleStore } from '@tulipfarm/agents/model-bundles';
import type { ModelCatalogSnapshot } from './model-catalog.ts';
import { modelEnvironment } from './model-environment.ts';

export function createModelConfiguration(input: { pool: Pool; env?: NodeJS.ProcessEnv }) {
  const environment = modelEnvironment(input.env);
  const modelFamilyResolution: ModelCatalogSnapshot['modelFamilyResolution'] = request => {
    const resolution = environment.resolve(request.modelFamilyId);
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
  const modelFamilyPaused = (familyId: string) => environment.paused(familyId);
  const isChatGpt = (familyId: string) => environment.catalog.model(familyId)?.route.type === 'chatgpt';
  const snapshot: ModelCatalogSnapshot = {
    catalog: environment.catalog,
    modelFamilyResolution,
    modelFamilyPaused,
    modelFamilyEligibility: request => {
      if (!modelFamilyResolution(request)) return false;
      // Paused and non-selectable models keep serving existing work but cannot be chosen anew.
      if (
        !request.existing &&
        (modelFamilyPaused(request.modelFamilyId) || !environment.catalog.model(request.modelFamilyId)?.selectable)
      )
        return false;
      if (request.fallbackFor === undefined) return true;
      // A member's ChatGPT plan is never a fallback, and a ChatGPT reply never falls back to a deployment-paid model.
      if (isChatGpt(request.modelFamilyId) || isChatGpt(request.fallbackFor)) return false;
      return (
        request.fallbackFor !== request.modelFamilyId &&
        modelFamilyResolution({ workspaceId: request.workspaceId, modelFamilyId: request.fallbackFor }) !== null
      );
    },
  };
  // Agents, policies and compaction run without a requesting member, so they can never use a member's ChatGPT plan.
  const modelFamilyEligibility: ModelFamilyEligibility = async request =>
    !isChatGpt(request.modelFamilyId) && snapshot.modelFamilyEligibility(request);
  const bundles = modelBundleStore(input.pool);
  const modelContinuity: ModelContinuity = environment.continuity(
    key => createModelRouteHealth(input.pool, key),
    bundles,
  );
  /** Records this server's bundle so runs admitted under it stay valid after a configuration change. */
  const registerModelBundle = async () => {
    await bundles.register(environment.bundle);
  };
  return {
    catalog: environment.catalog,
    modelCatalogSnapshot: async (_workspaceId: string) => snapshot,
    modelFamilyEligibility,
    modelContinuity,
    registerModelBundle,
  };
}
