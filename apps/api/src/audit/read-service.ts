/** Audit ledger read side: list is paged; verify re-derives the full hash chain. */

import { type AuditEvent, type VerifyIssue, verifyChain } from "@tulipfarm/audit";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { AuditPage, AuditPageQuery } from "./repo";

/** Read-only audit repo surface. */
export interface AuditChainReader {
  listPage(businessId: string, options?: AuditPageQuery): Promise<AuditPage>;
  listChain(businessId: string): Promise<AuditEvent[]>;
  count(businessId: string): Promise<number>;
}

export interface AuditVerifyReport {
  readonly valid: boolean;
  readonly eventCount: number;
  readonly issues: readonly VerifyIssue[];
  /** Hash of the newest event, so an operator can pin it externally and re-check it later. */
  readonly tailHash: string | null;
  readonly checkedAt: string;
}

/** Externally-held count and tail hash; required to detect tail deletion. */
export interface AuditAnchor {
  readonly eventCount?: number;
  readonly tailHash?: string | null;
}

/** Verify is linear and reads every row; above this limit, use export/seal. */
export const VERIFY_MAX_EVENTS = 50_000;

export class AuditTooLargeError extends Error {
  constructor(readonly eventCount: number) {
    super(
      `audit chain has ${eventCount} events, above the ${VERIFY_MAX_EVENTS} verification ceiling`
    );
    this.name = "AuditTooLargeError";
  }
}

export class AuditReadService {
  constructor(
    private readonly repo: AuditChainReader,
    private readonly businessId: string = DEPLOYMENT_BUSINESS_ID
  ) {}

  async list(options: AuditPageQuery = {}): Promise<AuditPage> {
    return this.repo.listPage(this.businessId, options);
  }

  /** Re-derive the chain; pass `anchor` to also detect tail deletion. */
  async verify(anchor: AuditAnchor = {}): Promise<AuditVerifyReport> {
    const eventCount = await this.repo.count(this.businessId);
    if (eventCount > VERIFY_MAX_EVENTS) throw new AuditTooLargeError(eventCount);

    const events = await this.repo.listChain(this.businessId);
    const result = verifyChain(events, {
      ...(anchor.eventCount !== undefined ? { eventCount: anchor.eventCount } : {}),
      ...(anchor.tailHash !== undefined ? { tailHash: anchor.tailHash } : {}),
    });
    return {
      valid: result.valid,
      eventCount: events.length,
      issues: result.issues,
      tailHash: events.at(-1)?.hash ?? null,
      checkedAt: new Date().toISOString(),
    };
  }
}
