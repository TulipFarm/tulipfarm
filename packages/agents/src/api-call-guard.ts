import { createHash } from 'node:crypto';
import { z } from 'zod';
import { API_CALL_LIMITS } from '@tulipfarm/api-calls/contracts';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { isOwnServiceUrl, ownServiceDomains } from './own-service.ts';

export const apiLimitReply =
  'I stopped after 50 API calls, the limit for one request. Some work may not be finished. Ask me to continue.';
export const apiFailureReply =
  "I couldn't finish this request because the API calls kept failing, so I stopped instead of repeating them. Ask me to try a different way.";
export const apiRefusedReply =
  'Nothing was sent. This same call was already refused. Use a different allowed address or the built-in tools instead.';

const fingerprint = (call: unknown) => createHash('sha256').update(canonicalJson(call)).digest('hex');
const apiCall = z.object({ tool: z.literal('api.request') });
const failed = z.object({ status: z.literal('failed'), code: z.string() });

export function createApiCallGuard(
  priorCalls: readonly unknown[] = [],
  priorResults: readonly { call: unknown; output: unknown }[] = [],
) {
  let calls = priorCalls.filter(call => apiCall.safeParse(call).success).length;
  const refused = new Set<string>();
  const failures = new Map<string, number>();
  const ownDomains = ownServiceDomains();
  let ownRefusals = 0;
  let repeatedRefusal = false;
  const recordResult = (call: unknown, value: unknown) => {
    if (!apiCall.safeParse(call).success) return false;
    const failure = failed.safeParse(value);
    if (!failure.success) {
      if (z.object({ status: z.literal('sent') }).safeParse(value).success) failures.clear();
      return false;
    }
    if (failure.data.code === 'call-limit') calls = API_CALL_LIMITS.callsPerScope;
    const key = `api.request:${failure.data.code}`;
    failures.set(key, (failures.get(key) ?? 0) + 1);
    const url = z.object({ url: z.string() }).safeParse(call);
    if (
      failure.data.code === 'own-service' ||
      (failure.data.code === 'address-denied' && url.success && isOwnServiceUrl(url.data.url, ownDomains))
    )
      ownRefusals++;
    if (failure.data.code === 'address-denied' || failure.data.code === 'own-service') {
      const key = fingerprint(call);
      repeatedRefusal ||= refused.has(key);
      refused.add(key);
    }
    return true;
  };
  for (const { call, output } of priorResults) recordResult(call, output);
  return {
    get limitReached() {
      return calls >= API_CALL_LIMITS.callsPerScope;
    },
    get failuresSpent() {
      return ownRefusals >= 3 || [...failures.values()].some(count => count >= 3);
    },
    get stoppingReply() {
      return repeatedRefusal
        ? apiRefusedReply
        : this.limitReached
          ? apiLimitReply
          : this.failuresSpent
            ? apiFailureReply
            : undefined;
    },
    refused(call: unknown) {
      return refused.has(fingerprint(call));
    },
    record(call: unknown, value: unknown) {
      if (apiCall.safeParse(call).success) calls++;
      return recordResult(call, value);
    },
  };
}
