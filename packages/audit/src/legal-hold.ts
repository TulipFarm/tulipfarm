/** Legal hold blocks eligible deletion but grants no read access or event-content path. */

export type LegalHoldScope =
  | { readonly type: "business" }
  | { readonly type: "category"; readonly category: string }
  | { readonly type: "target"; readonly target: string };

export interface LegalHold {
  readonly id: string;
  readonly businessId: string;
  readonly scope: LegalHoldScope;
  readonly reason: string;
  readonly createdAt: Date;
  readonly releasedAt?: Date;
}

export type LegalHoldErrorCode = "INVALID_INPUT" | "ALREADY_RELEASED";

export class LegalHoldError extends Error {
  constructor(
    public readonly code: LegalHoldErrorCode,
    message: string
  ) {
    super(message);
    this.name = "LegalHoldError";
  }
}

export interface LegalHoldInput {
  readonly id: string;
  readonly businessId: string;
  readonly scope: LegalHoldScope;
  readonly reason: string;
  readonly createdAt: Date;
}

export function placeLegalHold(input: LegalHoldInput): LegalHold {
  if (!input.id || !input.businessId) {
    throw new LegalHoldError("INVALID_INPUT", "legal hold requires id and businessId");
  }
  if (!input.reason) {
    throw new LegalHoldError("INVALID_INPUT", "legal hold requires a reason");
  }
  return Object.freeze({
    id: input.id,
    businessId: input.businessId,
    scope: input.scope,
    reason: input.reason,
    createdAt: new Date(input.createdAt.getTime()),
  });
}

export function releaseLegalHold(hold: LegalHold, releasedAt: Date): LegalHold {
  if (hold.releasedAt !== undefined) {
    throw new LegalHoldError("ALREADY_RELEASED", `legal hold ${hold.id} is already released`);
  }
  return Object.freeze({ ...hold, releasedAt: new Date(releasedAt.getTime()) });
}

function scopeCovers(scope: LegalHoldScope, category: string, target: string): boolean {
  if (scope.type === "business") return true;
  if (scope.type === "category") return scope.category === category;
  return scope.target === target;
}

/** Whether `hold` blocks deletion in `category`/`target` at `now`. Never reads content. */
export function isHeld(
  hold: LegalHold,
  businessId: string,
  category: string,
  target: string,
  now: Date
): boolean {
  if (hold.businessId !== businessId) return false;
  if (hold.releasedAt !== undefined && hold.releasedAt.getTime() <= now.getTime()) return false;
  return scopeCovers(hold.scope, category, target);
}

/** True if any active hold in `holds` blocks deletion of this category/target at `now`. */
export function isDeletionBlocked(
  holds: readonly LegalHold[],
  businessId: string,
  category: string,
  target: string,
  now: Date
): boolean {
  return holds.some((hold) => isHeld(hold, businessId, category, target, now));
}
