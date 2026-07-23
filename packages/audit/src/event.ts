/**
 * Canonical audit event shape (SPEC §20): actor/effective principal, correlation, lineage, and
 * safe (non-protected) evidence only. Protected contents never enter the event body — callers
 * pass a {@link BlobRef} under separate access control instead (SPEC §13 DLP boundary).
 */

import type { BlobRef } from "@tulipfarm/storage";

export type AuditDecision = "allow" | "deny";

/** Minimal principal reference. `@tulipfarm/audit` does not depend on `@tulipfarm/authz`. */
export interface AuditPrincipalRef {
  readonly principalId: string;
  readonly businessId: string;
}

/** Caller-supplied fields for one audit event, before chain linkage is computed. */
export interface AuditEventInput {
  readonly actor: AuditPrincipalRef;
  readonly effectivePrincipal: AuditPrincipalRef;
  readonly agentId?: string;
  readonly runId?: string;
  readonly stateId?: string;
  readonly action: string;
  readonly target: string;
  readonly decision: AuditDecision;
  readonly reasonCodes: readonly string[];
  readonly guardrailDigest?: string;
  readonly bundleDigest?: string;
  readonly sourceClassification?: string;
  readonly destinationClassification?: string;
  readonly requestHash?: string;
  readonly resultHash?: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly safeMetadata?: Record<string, unknown>;
  /** References to Artifacts holding sensitive contents, never the contents themselves. */
  readonly safeRefs?: readonly BlobRef[];
}

/** A stored, hash-linked audit event. `businessId` scopes the chain (one ledger per business). */
export interface AuditEvent extends AuditEventInput {
  readonly id: string;
  readonly businessId: string;
  readonly chainIndex: number;
  readonly previousHash: string | null;
  readonly hash: string;
}
