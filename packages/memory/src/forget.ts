/** Lifecycle: forgetting tombstones an assertion, erasing removes it and its derived copies. */

import {
  auditEvent,
  type MemoryAssertion,
  type MemoryDeps,
  type MemoryEraseCounts,
  type MemoryEraseStoreCounts,
} from "./memory";
import type { MemoryScopeDenialReason, MemoryScopeRequest } from "./scope";
import { authorizeMemoryScope } from "./scope";
import {
  endMemorySpan,
  MEMORY_METRICS,
  MEMORY_SPANS,
  recordMemoryCounter,
  recordMemorySpanError,
  setMemorySpanAttributes,
  startMemorySpan,
} from "./telemetry";

export interface ForgetRequest {
  readonly businessId: string;
  readonly assertionId: string;
}

export type ForgetResult =
  | { readonly outcome: "forgotten"; readonly assertion: MemoryAssertion }
  | { readonly outcome: "denied"; readonly reason: MemoryScopeDenialReason }
  | { readonly outcome: "not_found" };

/** Forget tombstones an assertion and removes its statement; retained text would defeat forgetting. */
export async function forgetMemory(
  deps: MemoryDeps,
  request: ForgetRequest,
  scopeRequest: MemoryScopeRequest
): Promise<ForgetResult> {
  const now = deps.now();
  const span = startMemorySpan(deps.telemetry, MEMORY_SPANS.forget);
  const existing = await deps.store.get(request.businessId, request.assertionId);
  if (existing === undefined) {
    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.forgetOperations, 1, {
      outcome: "not_found",
    });
    setMemorySpanAttributes(span, { outcome: "not_found" });
    endMemorySpan(span);
    return { outcome: "not_found" };
  }

  const access = authorizeMemoryScope(deps.settings.scopes, existing.target, scopeRequest);
  if (!access.allowed) {
    await deps.audit?.record(
      auditEvent(scopeRequest, "memory.forget", "deny", [access.reason], now, {
        scope: existing.target.scope,
      })
    );
    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.forgetOperations, 1, {
      outcome: "denied",
      reason: access.reason,
      scope: existing.target.scope,
    });
    setMemorySpanAttributes(span, {
      outcome: "denied",
      reason: access.reason,
      scope: existing.target.scope,
    });
    endMemorySpan(span);
    return { outcome: "denied", reason: access.reason };
  }

  const tombstone: MemoryAssertion = {
    ...existing,
    statement: "",
    // Entities are derived from the statement, so leaving them would leak what was forgotten.
    entities: [],
    status: "forgotten",
    recordedUntil: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await deps.store.put(tombstone);
  await deps.audit?.record(
    auditEvent(scopeRequest, "memory.forget", "allow", [], now, {
      scope: existing.target.scope,
      version: existing.version,
    })
  );
  recordMemoryCounter(deps.telemetry, MEMORY_METRICS.forgetOperations, 1, {
    outcome: "forgotten",
    scope: existing.target.scope,
    memory_type: existing.memoryType,
  });
  setMemorySpanAttributes(span, {
    outcome: "forgotten",
    scope: existing.target.scope,
    memory_type: existing.memoryType,
  });
  endMemorySpan(span);
  return { outcome: "forgotten", assertion: tombstone };
}

export type EraseResult =
  | { readonly outcome: "erased"; readonly counts: MemoryEraseCounts }
  | { readonly outcome: "denied"; readonly reason: MemoryScopeDenialReason }
  | { readonly outcome: "not_found" };

/** Erase deletes row and derived copies; audit records only safe scope/version/count evidence. */
export async function eraseMemory(
  deps: MemoryDeps,
  request: ForgetRequest,
  scopeRequest: MemoryScopeRequest
): Promise<EraseResult> {
  const now = deps.now();
  const span = startMemorySpan(deps.telemetry, MEMORY_SPANS.erase);
  const existing = await deps.store.get(request.businessId, request.assertionId);
  if (existing === undefined) {
    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.eraseOperations, 1, {
      outcome: "not_found",
    });
    setMemorySpanAttributes(span, { outcome: "not_found" });
    endMemorySpan(span);
    return { outcome: "not_found" };
  }

  const access = authorizeMemoryScope(deps.settings.scopes, existing.target, scopeRequest);
  if (!access.allowed) {
    await deps.audit?.record(
      auditEvent(scopeRequest, "memory.erase", "deny", [access.reason], now, {
        scope: existing.target.scope,
      })
    );
    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.eraseOperations, 1, {
      outcome: "denied",
      reason: access.reason,
      scope: existing.target.scope,
    });
    setMemorySpanAttributes(span, {
      outcome: "denied",
      reason: access.reason,
      scope: existing.target.scope,
    });
    endMemorySpan(span);
    return { outcome: "denied", reason: access.reason };
  }

  let pending: number;
  try {
    pending = await deps.pending.deleteReferencingAssertion(
      request.businessId,
      request.assertionId,
      existing.statement
    );
  } catch (error) {
    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.eraseCascadeFailures, 1, {
      stage: "pending",
      scope: existing.target.scope,
    });
    recordMemorySpanError(span, "pending_cascade_failed");
    endMemorySpan(span);
    throw error;
  }

  let storeCounts: MemoryEraseStoreCounts;
  try {
    storeCounts = await deps.store.erase(existing);
  } catch (error) {
    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.eraseCascadeFailures, 1, {
      stage: "store",
      scope: existing.target.scope,
    });
    recordMemorySpanError(span, "store_cascade_failed");
    endMemorySpan(span);
    throw error;
  }
  const counts: MemoryEraseCounts = { ...storeCounts, pending };
  for (const [stage, count] of Object.entries(counts)) {
    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.eraseCascadeCounts, count, {
      stage,
      scope: existing.target.scope,
    });
  }
  await deps.audit?.record(
    auditEvent(scopeRequest, "memory.erase", "allow", [], now, {
      scope: existing.target.scope,
      version: existing.version,
      counts,
    })
  );
  recordMemoryCounter(deps.telemetry, MEMORY_METRICS.eraseOperations, 1, {
    outcome: "erased",
    scope: existing.target.scope,
    memory_type: existing.memoryType,
  });
  setMemorySpanAttributes(span, {
    outcome: "erased",
    scope: existing.target.scope,
    memory_type: existing.memoryType,
  });
  endMemorySpan(span);
  return { outcome: "erased", counts };
}
