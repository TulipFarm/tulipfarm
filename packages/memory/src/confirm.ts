/**
 * Confirmation of inferred Memory (SPEC §14.2).
 *
 * An inferred statement lives here — outside the assertion store — until the scope's owner
 * confirms it. Denial and expiry are not failures to handle later: they delete the pending record
 * and leave nothing durable behind. That is the whole point of the split, so an Agent cannot
 * bootstrap a belief into memory by inferring it and waiting.
 */

import type { MemoryAssertion, MemoryDeps, RememberRequest } from "./memory";
import { commitAssertion } from "./memory";
import type { MemoryScopeDenialReason, MemoryScopeRequest } from "./scope";
import { authorizeMemoryScope } from "./scope";
import {
  endMemorySpan,
  MEMORY_METRICS,
  MEMORY_SPANS,
  recordMemoryCounter,
  setMemorySpanAttributes,
  startMemorySpan,
} from "./telemetry";

export const DEFAULT_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface PendingMemory {
  readonly pendingId: string;
  readonly businessId: string;
  readonly request: RememberRequest;
  readonly requestedAt: string;
  readonly expiresAt: string;
}

export interface PendingMemoryStore {
  put(pending: PendingMemory): Promise<void>;
  get(businessId: string, pendingId: string): Promise<PendingMemory | undefined>;
  delete(businessId: string, pendingId: string): Promise<void>;
  deleteReferencingAssertion(
    businessId: string,
    assertionId: string,
    statement: string
  ): Promise<number>;
}

export class InMemoryPendingMemoryStore implements PendingMemoryStore {
  private readonly byId = new Map<string, PendingMemory>();

  private key(businessId: string, pendingId: string): string {
    return `${businessId}:${pendingId}`;
  }

  async put(pending: PendingMemory): Promise<void> {
    this.byId.set(this.key(pending.businessId, pending.pendingId), pending);
  }

  async get(businessId: string, pendingId: string): Promise<PendingMemory | undefined> {
    return this.byId.get(this.key(businessId, pendingId));
  }

  async delete(businessId: string, pendingId: string): Promise<void> {
    this.byId.delete(this.key(businessId, pendingId));
  }

  async deleteReferencingAssertion(
    businessId: string,
    assertionId: string,
    statement: string
  ): Promise<number> {
    let deleted = 0;
    for (const pending of this.byId.values()) {
      if (pending.businessId !== businessId) continue;
      const request = pending.request;
      const referencesAssertion =
        request.supersedesId === assertionId ||
        request.statement.includes(assertionId) ||
        request.subject.includes(assertionId) ||
        (statement.length > 0 && request.statement.includes(statement));
      if (!referencesAssertion) continue;
      this.byId.delete(this.key(businessId, pending.pendingId));
      deleted += 1;
    }
    return deleted;
  }
}

export interface ResolvePendingRequest {
  readonly businessId: string;
  readonly pendingId: string;
  readonly decision: "confirm" | "deny";
}

export type ResolvePendingResult =
  | { readonly outcome: "saved"; readonly assertion: MemoryAssertion }
  | { readonly outcome: "denied"; readonly reason?: MemoryScopeDenialReason | string }
  | { readonly outcome: "expired" }
  | { readonly outcome: "not_found" };

/**
 * Resolve one pending inferred memory.
 *
 * The confirming principal is reauthorized against the target scope — a confirmation prompt
 * answered by the wrong person confirms nothing, and leaves the record for the real owner.
 *
 * `denied` and `not_found` are deliberately distinct: an attempt to resolve someone else's
 * pending memory is a security-relevant event, and collapsing it here would destroy the signal
 * audit needs. The distinction is for the caller, never for the requester — a caller that
 * forwards `reason` to an unauthorized principal turns it into an existence oracle for
 * `pendingId`. Collapse `denied`-with-`reason` into the same response as `not_found` at every
 * boundary you expose. See `registerPendingMemoryRoutes` in apps/api/src/memory/routes.ts.
 */
export async function resolvePendingMemory(
  deps: MemoryDeps,
  request: ResolvePendingRequest,
  scopeRequest: MemoryScopeRequest
): Promise<ResolvePendingResult> {
  const span = startMemorySpan(deps.telemetry, MEMORY_SPANS.confirmation, {
    decision: request.decision,
  });
  const pending = await deps.pending.get(request.businessId, request.pendingId);
  // A resolved record is gone, so a replayed confirmation cannot create a second version.
  if (pending === undefined) {
    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.confirmationDecisions, 1, {
      decision: request.decision,
      outcome: "not_found",
    });
    setMemorySpanAttributes(span, { decision: request.decision, outcome: "not_found" });
    endMemorySpan(span);
    return { outcome: "not_found" };
  }

  const access = authorizeMemoryScope(deps.settings.scopes, pending.request.target, scopeRequest);
  if (!access.allowed) {
    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.confirmationDecisions, 1, {
      decision: request.decision,
      outcome: "denied",
      reason: access.reason,
      scope: pending.request.target.scope,
    });
    setMemorySpanAttributes(span, {
      decision: request.decision,
      outcome: "denied",
      reason: access.reason,
      scope: pending.request.target.scope,
    });
    endMemorySpan(span);
    return { outcome: "denied", reason: access.reason };
  }

  if (deps.now().getTime() > Date.parse(pending.expiresAt)) {
    await deps.pending.delete(request.businessId, request.pendingId);
    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.confirmationDecisions, 1, {
      decision: request.decision,
      outcome: "expired",
      scope: pending.request.target.scope,
    });
    setMemorySpanAttributes(span, {
      decision: request.decision,
      outcome: "expired",
      scope: pending.request.target.scope,
    });
    endMemorySpan(span);
    return { outcome: "expired" };
  }

  if (request.decision === "deny") {
    await deps.pending.delete(request.businessId, request.pendingId);
    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.confirmationDecisions, 1, {
      decision: "deny",
      outcome: "denied",
      scope: pending.request.target.scope,
    });
    setMemorySpanAttributes(span, {
      decision: "deny",
      outcome: "denied",
      scope: pending.request.target.scope,
    });
    endMemorySpan(span);
    return { outcome: "denied" };
  }

  const committed = await commitAssertion(deps, pending.request, scopeRequest);
  if (!committed.ok) {
    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.confirmationDecisions, 1, {
      decision: "confirm",
      outcome: "denied",
      reason: committed.reason,
      scope: pending.request.target.scope,
    });
    setMemorySpanAttributes(span, {
      decision: "confirm",
      outcome: "denied",
      reason: committed.reason,
      scope: pending.request.target.scope,
    });
    endMemorySpan(span);
    return { outcome: "denied", reason: committed.reason };
  }
  await deps.pending.delete(request.businessId, request.pendingId);
  recordMemoryCounter(deps.telemetry, MEMORY_METRICS.confirmationDecisions, 1, {
    decision: "confirm",
    outcome: "saved",
    scope: pending.request.target.scope,
    memory_type: committed.assertion.memoryType,
  });
  setMemorySpanAttributes(span, {
    decision: "confirm",
    outcome: "saved",
    scope: pending.request.target.scope,
    memory_type: committed.assertion.memoryType,
  });
  endMemorySpan(span);
  return { outcome: "saved", assertion: committed.assertion };
}
