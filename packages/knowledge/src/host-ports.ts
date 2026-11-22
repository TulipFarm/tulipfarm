import { setTimeout as delay } from 'node:timers/promises';
import { defaultCallTimeoutMs } from '@tulipfarm/config';
import { isFeatureEnabled, recordKnowledgeImport } from '@tulipfarm/observability';
import type { Clock, FeatureFlags, Telemetry } from '@tulipfarm/memory-core/ports/runtime';

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: milliseconds => delay(milliseconds),
};
export const knowledgeHostPolicy = Object.freeze({
  callTimeoutMs: defaultCallTimeoutMs,
});
export const knowledgeFeatureFlags: FeatureFlags<'default-connection-knowledge'> = {
  enabled: (name, userId, workspaceId) => isFeatureEnabled(name, { id: userId }, { id: workspaceId }),
};
export const knowledgeTelemetry: Telemetry = { recordImport: recordKnowledgeImport };
