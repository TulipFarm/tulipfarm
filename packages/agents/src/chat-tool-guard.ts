import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { API_CALL_LIMITS } from '@tulipfarm/api-calls/contracts';
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
  const refused = new Set<string>();
  const failures = new Map<string, number>();
  let apiCalls = priorCalls.filter(call => z.object({ tool: z.literal('api.request') }).safeParse(call).success).length;
  const recordFailure = (call: { tool: string }, value: unknown) => {
    if (call.tool !== 'api.request') return false;
    const failure = z.object({ status: z.literal('failed'), code: z.string() }).safeParse(value);
    if (!failure.success) return false;
    if (failure.data.code === 'call-limit') apiCalls = API_CALL_LIMITS.callsPerScope;
    const key = `${call.tool}:${failure.data.code}`;
    failures.set(key, (failures.get(key) ?? 0) + 1);
    if (failure.data.code === 'address-denied' || failure.data.code === 'own-service') refused.add(fingerprint(call));
    return true;
  };
  for (const { call, output } of priorResults) {
    const parsed = z.object({ tool: z.string() }).passthrough().safeParse(call);
    if (parsed.success) recordFailure(parsed.data, output);
  }
  let idleRounds = 0;
  return {
    get apiLimitReached() {
      return apiCalls >= API_CALL_LIMITS.callsPerScope;
    },
    get apiFailuresSpent() {
      return [...failures.values()].some(count => count >= 3);
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
      return refused.has(fingerprint(call)) || (!repeatable(call) && writes.has(fingerprint(call)));
    },
    record(call: FrameworkCall, output: string) {
      if (call.tool === 'api.request') apiCalls++;
      let failed = false;
      try {
        failed = recordFailure(call, JSON.parse(output.slice(output.indexOf('{'))));
      } catch {
        /* A non-JSON result still participates in the progress guard. */
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
