import { setTimeout as delay } from 'node:timers/promises';
import { defaultCallTimeoutMs } from '@tulipfarm/config';
import { recordKnowledgeImport } from '@tulipfarm/observability';
import type { Clock, Telemetry } from '@tulipfarm/memory-core/ports/runtime';

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: milliseconds => delay(milliseconds),
};
export const knowledgeHostPolicy = Object.freeze({
  callTimeoutMs: defaultCallTimeoutMs,
});
export const knowledgeTelemetry: Telemetry = { recordImport: recordKnowledgeImport };
