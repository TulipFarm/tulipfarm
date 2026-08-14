/** Principal checks deny disabled, expired, business-mismatched, or substituted identities. */

import { PRINCIPAL_KINDS, type PrincipalKind as SchemaPrincipalKind } from "@tulipfarm/schema";

export { PRINCIPAL_KINDS };

export type PrincipalKind = SchemaPrincipalKind;

export function isPrincipalKind(kind: string): kind is PrincipalKind {
  return (PRINCIPAL_KINDS as readonly string[]).includes(kind);
}

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

/** Sessions authenticate only the same unexpired principal id in the same business. */
export function assertSessionMatchesPrincipal(
  session: SessionBinding,
  principal: Principal,
  now: Date = new Date()
): void {
  assertPrincipalAuthenticatable(principal, now);
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
