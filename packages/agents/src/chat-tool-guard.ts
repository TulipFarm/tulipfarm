import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { createApiCallGuard } from './api-call-guard.ts';
import { readOnlyCall, type FrameworkCall } from './tools.ts';

// These reads are serialized by the dispatcher, but can still be refreshed safely.
const repeatableTools = new Set<string>([
  'agents.context',
  'agents.status',
  'slack.resolve',
  // Preparing the same file with the same settings stores the same bytes, so a repeat returns the same reference.
  'tables.import.file',
  'workflows.list',
  'workflows.read',
  'workflows.providers',
]);
const repeatable = (call: { tool: string; method?: unknown }) => repeatableTools.has(call.tool) || readOnlyCall(call);
const fingerprint = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

export function createChatToolGuard(
  priorCalls: readonly unknown[] = [],
  priorResults: readonly { call: unknown; output: unknown }[] = [],
) {
  const writes = new Set(
    priorCalls.flatMap(value => {
      const call = z.object({ tool: z.string() }).passthrough().parse(value);
      return repeatable(call) ? [] : [fingerprint(call)];
    }),
  );
  const reads = new Set<string>();
  const api = createApiCallGuard(priorCalls, priorResults);
  let idleRounds = 0;
  return {
    get apiLimitReached() {
      return api.limitReached;
    },
    get apiFailuresSpent() {
      return api.failuresSpent;
    },
    get apiStoppingReply() {
      return api.stoppingReply;
    },
    refused(call: FrameworkCall) {
      return api.refused(call);
    },
    get stalled() {
      return idleRounds >= 3;
    },
    round() {
      idleRounds++;
    },
    progress() {
      idleRounds = 0;
    },
    duplicate(call: FrameworkCall) {
      return api.refused(call) || (!repeatable(call) && writes.has(fingerprint(call)));
    },
    record(call: FrameworkCall, output: string) {
      let failed = false;
      if (call.tool === 'api.request')
        try {
          failed = api.record(call, JSON.parse(output.slice(output.indexOf('{'))));
        } catch {
          api.record(call, undefined);
        }
      if (failed) {
        if (!repeatable(call)) writes.add(fingerprint(call));
        return;
      }
      if (!repeatable(call)) {
        writes.add(fingerprint(call));
        reads.clear();
        idleRounds = 0;
      } else {
        const key = fingerprint([call, output]);
        if (!reads.has(key)) idleRounds = 0;
        reads.add(key);
      }
    },
  };
}
