/**
 * Read side of the audit ledger.
 *
 * The ledger was write-only: `PgAuditEventRepo` persisted a hash-chained, tamper-evident record
 * that no REST endpoint and no UI could read, so the only way to answer "who repointed the Soul
 * git remote" was `psql`. A ledger nobody can read is not evidence.
 *
 * Two operations, deliberately separate:
 *
 *   list()   — a bounded, filtered page for a human reading the log.
 *   verify() — the whole chain re-derived from scratch, which is the *point* of chaining. A list
 *              view alone cannot tell you a row was deleted; only recomputing every hash and
 *              checking `previousHash` linkage can.
 */

import { type AuditEvent, type VerifyIssue, verifyChain } from "@tulipfarm/audit";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { AuditPage, AuditPageQuery } from "./repo";

/**
 * The read surface, narrowed from `PgAuditEventRepo` so tests and future adapters are not forced
 * to implement `append`.
 */
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

/**
 * An externally-held anchor: a count and tail hash an operator recorded from an earlier `verify`
 * and kept *outside* the database.
 *
 * Without one, tail deletion is undetectable in principle. Removing the last `k` events leaves
 * every remaining hash and `previousHash` link perfectly consistent, and any count derived from
 * the same table shrinks with it — so the ledger cannot testify against itself about its own
 * length. Only a value stored elsewhere can. (Middle-row deletion, reordering and tampering are
 * caught without an anchor, by linkage and index gaps.)
 */
export interface AuditAnchor {
  readonly eventCount?: number;
  readonly tailHash?: string | null;
}

/**
 * Verification cost is linear in chain length and it reads every row, so it is not something to
 * expose without a ceiling. Above this the honest answer is "use the export/seal path", not a
 * request that quietly pins a connection for minutes.
 */
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

  /**
   * Re-derives the chain and reports any tamper, gap, fork or reorder.
   *
   * Pass `anchor` to also detect tail deletion — see {@link AuditAnchor} for why that case needs
   * a value held outside the database. Without it this still catches everything that leaves a
   * trace *inside* the chain, which is the common case: the table's UPDATE/DELETE/TRUNCATE
   * trigger means reaching the rows at all requires deliberate superuser DDL.
   */
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
