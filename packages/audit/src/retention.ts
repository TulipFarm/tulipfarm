/** Category retention uses caller-supplied category only; legal hold wins. */

import { isDeletionBlocked, type LegalHold } from "./legal-hold";

export interface RetentionPolicy {
  readonly category: string;
  readonly retainForDays: number;
}

export type RetentionErrorCode = "INVALID_INPUT" | "NO_POLICY";

export class RetentionError extends Error {
  constructor(
    public readonly code: RetentionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RetentionError";
  }
}

function findPolicy(policies: readonly RetentionPolicy[], category: string): RetentionPolicy {
  const policy = policies.find((candidate) => candidate.category === category);
  if (!policy) {
    throw new RetentionError(
      "NO_POLICY",
      `no retention policy configured for category "${category}"`
    );
  }
  if (!Number.isFinite(policy.retainForDays) || policy.retainForDays < 0) {
    throw new RetentionError(
      "INVALID_INPUT",
      `retention policy for "${category}" must have a non-negative retainForDays`
    );
  }
  return policy;
}

/** True once `retainForDays` has elapsed since `occurredAt`, independent of legal hold. */
export function isRetentionExpired(
  occurredAt: Date,
  category: string,
  policies: readonly RetentionPolicy[],
  now: Date
): boolean {
  const policy = findPolicy(policies, category);
  const expiresAt = occurredAt.getTime() + policy.retainForDays * 24 * 60 * 60 * 1000;
  return now.getTime() >= expiresAt;
}

/** Delete only after retention expires and no legal hold blocks it. */
export function eligibleForDeletion(
  businessId: string,
  category: string,
  target: string,
  occurredAt: Date,
  policies: readonly RetentionPolicy[],
  holds: readonly LegalHold[],
  now: Date
): boolean {
  if (!isRetentionExpired(occurredAt, category, policies, now)) return false;
  return !isDeletionBlocked(holds, businessId, category, target, now);
}
