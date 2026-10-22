import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { readOnlyTools, type FrameworkCall } from './tools.ts';

// These reads are serialized by the dispatcher, but can still be refreshed safely.
const repeatable = new Set<string>([
  ...readOnlyTools,
  'agents.context',
  'agents.status',
  'slack.resolve',
  'workflows.list',
  'workflows.read',
  'workflows.providers',
]);
const fingerprint = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

export function createChatToolGuard(priorCalls: readonly unknown[] = []) {
  const writes = new Set(
    priorCalls.flatMap(value => {
      const call = z.object({ tool: z.string() }).passthrough().parse(value);
      return repeatable.has(call.tool) ? [] : [fingerprint(call)];
    }),
  );
  const reads = new Set<string>();
  let idleRounds = 0;
  return {
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
      return !repeatable.has(call.tool) && writes.has(fingerprint(call));
    },
    record(call: FrameworkCall, output: string) {
      if (!repeatable.has(call.tool)) {
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
