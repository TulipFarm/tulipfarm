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
 */
export async function resolvePendingMemory(
  deps: MemoryDeps,
  request: ResolvePendingRequest,
  scopeRequest: MemoryScopeRequest
): Promise<ResolvePendingResult> {
  const pending = await deps.pending.get(request.businessId, request.pendingId);
  // A resolved record is gone, so a replayed confirmation cannot create a second version.
  if (pending === undefined) return { outcome: "not_found" };

  const access = authorizeMemoryScope(deps.settings.scopes, pending.request.target, scopeRequest);
  if (!access.allowed) return { outcome: "denied", reason: access.reason };

  if (deps.now().getTime() > Date.parse(pending.expiresAt)) {
    await deps.pending.delete(request.businessId, request.pendingId);
    return { outcome: "expired" };
  }

  if (request.decision === "deny") {
    await deps.pending.delete(request.businessId, request.pendingId);
    return { outcome: "denied" };
  }

  const committed = await commitAssertion(deps, pending.request, scopeRequest);
  if (!committed.ok) return { outcome: "denied", reason: committed.reason };
  await deps.pending.delete(request.businessId, request.pendingId);
  return { outcome: "saved", assertion: committed.assertion };
}
