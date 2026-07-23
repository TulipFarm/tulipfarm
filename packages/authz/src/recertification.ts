/**
 * Periodic access review (SPEC §12: sensitive grants and service identities require
 * recertification; SPEC §24 separation of duties). A grant under review stops counting the
 * instant it passes its review deadline without a recorded review — recertification fails
 * closed, it never auto-renews — and a reviewer can never recertify their own access.
 */

export interface RecertificationRecord {
  readonly principalId: string;
  readonly businessId: string;
  readonly grantId: string;
  readonly dueAt: Date;
  readonly reviewedAt?: Date;
  readonly reviewerPrincipalId?: string;
}

export type RecertificationDenialReason = "overdue" | "self_review" | "business_mismatch";

export class RecertificationDeniedError extends Error {
  constructor(
    public readonly reason: RecertificationDenialReason,
    message: string
  ) {
    super(message);
    this.name = "RecertificationDeniedError";
  }
}

/**
 * Throws once `record.dueAt` has passed without a review recorded at or after issuance — an
 * overdue recertification denies the grant it covers regardless of the grant's own expiry.
 */
export function assertRecertificationCurrent(
  record: RecertificationRecord,
  now: Date = new Date()
): void {
  if (record.dueAt <= now && (!record.reviewedAt || record.reviewedAt < record.dueAt)) {
    throw new RecertificationDeniedError(
      "overdue",
      `grant ${record.grantId} is past its recertification deadline`
    );
  }
}

/**
 * Throws unless `reviewerId` may record this review: same business as the reviewed principal,
 * and never the reviewed principal itself (no self-review).
 */
export function assertRecertificationReviewer(
  record: Pick<RecertificationRecord, "principalId" | "businessId">,
  reviewerId: string,
  reviewerBusinessId: string
): void {
  if (reviewerBusinessId !== record.businessId) {
    throw new RecertificationDeniedError(
      "business_mismatch",
      "reviewer does not belong to the reviewed principal's business"
    );
  }
  if (reviewerId === record.principalId) {
    throw new RecertificationDeniedError("self_review", "a principal cannot recertify itself");
  }
}
