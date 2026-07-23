/**
 * Distinct principal kinds SPEC §12 requires (user/Agent/Routine/integration adapter/API/service),
 * plus the checks that keep a disabled, expired, or business-mismatched principal from
 * authenticating or substituting for another (SPEC §12 non-amplification, §24 confused-deputy).
 */

export type PrincipalKind =
  | "user"
  | "agent"
  | "routine"
  | "integration_adapter"
  | "api"
  | "service";

export type PrincipalStatus = "active" | "disabled" | "expired";

export interface Principal {
  readonly id: string;
  readonly businessId: string;
  readonly kind: PrincipalKind;
  readonly status: PrincipalStatus;
  /** Absent for principals without a fixed lease/expiry (e.g. a standing user account). */
  readonly expiresAt?: Date;
}

/** A session's durable binding to the principal it was issued for. */
export interface SessionBinding {
  readonly sid: string;
  readonly principalId: string;
  readonly businessId: string;
  readonly expiresAt: Date;
}

export type PrincipalDenialReason = "disabled" | "expired" | "substitution";

export class PrincipalDeniedError extends Error {
  constructor(
    public readonly reason: PrincipalDenialReason,
    message: string
  ) {
    super(message);
    this.name = "PrincipalDeniedError";
  }
}

/** Throws when the principal cannot authenticate: disabled, or past its recorded expiry. */
export function assertPrincipalAuthenticatable(principal: Principal, now: Date = new Date()): void {
  if (principal.status === "disabled") {
    throw new PrincipalDeniedError("disabled", `principal ${principal.id} is disabled`);
  }
  if (principal.status === "expired" || (principal.expiresAt && principal.expiresAt <= now)) {
    throw new PrincipalDeniedError("expired", `principal ${principal.id} has expired`);
  }
}

/**
 * Throws unless `session` was issued for exactly `principal` — same principal id, same
 * business_id, not expired. A session never authenticates a different principal or crosses a
 * business boundary (SPEC §12 non-amplification).
 */
export function assertSessionMatchesPrincipal(
  session: SessionBinding,
  principal: Principal,
  now: Date = new Date()
): void {
  if (session.expiresAt <= now) {
    throw new PrincipalDeniedError("expired", `session ${session.sid} has expired`);
  }
  if (session.principalId !== principal.id || session.businessId !== principal.businessId) {
    throw new PrincipalDeniedError(
      "substitution",
      `session ${session.sid} does not authenticate principal ${principal.id}`
    );
  }
}
