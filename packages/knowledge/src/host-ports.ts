import { setTimeout as delay } from 'node:timers/promises';
import {
  calculateKnowledgeEmbeddingCost,
  defaultCallTimeoutMs,
  knowledgeEmbeddingProfile,
  type KnowledgeEmbeddingsConfig,
} from '@tulipfarm/config';
import { createEmbeddingProvider, prepareEmbeddingInputs } from '@tulipfarm/memory-core/embedding-provider';
import { recordUsage } from '@tulipfarm/extensions';
import { isFeatureEnabled, recordKnowledgeImport } from '@tulipfarm/observability';
import {
  markKnowledgeDispatched,
  recordKnowledgeCreditOutcome,
  reserveKnowledgeCredits,
} from '@tulipfarm/workspace-storage/knowledge-credits';
import type { Clock, FeatureFlags, Telemetry, UsageMeter } from '@tulipfarm/memory-core/ports/runtime';
export type { KnowledgeEmbeddingsConfig } from '@tulipfarm/config';

export function prepareKnowledgeEmbeddingInputs(inputs: readonly string[]) {
  return prepareEmbeddingInputs(inputs, knowledgeEmbeddingProfile);
}

export function createKnowledgeEmbeddingProvider(
  config: KnowledgeEmbeddingsConfig,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
) {
  return createEmbeddingProvider(config, knowledgeEmbeddingProfile, options);
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: milliseconds => delay(milliseconds),
};
export const knowledgeHostPolicy = Object.freeze({
  embeddingProfile: knowledgeEmbeddingProfile,
  callTimeoutMs: defaultCallTimeoutMs,
});
export const knowledgeFeatureFlags: FeatureFlags<'default-connection-knowledge'> = {
  enabled: (name, userId, workspaceId) => isFeatureEnabled(name, { id: userId }, { id: workspaceId }),
};
export const knowledgeTelemetry: Telemetry = { recordImport: recordKnowledgeImport };
export const knowledgeUsageMeter: UsageMeter<Parameters<typeof reserveKnowledgeCredits>[0]> = {
  cost: calculateKnowledgeEmbeddingCost,
  reserve: reserveKnowledgeCredits,
  markDispatched: markKnowledgeDispatched,
  outcome: recordKnowledgeCreditOutcome,
  record: recordUsage,
};
