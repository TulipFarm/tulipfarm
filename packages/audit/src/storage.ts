/**
 * Append-only persistence for audit events (SPEC §20: "Events are appended in PostgreSQL for
 * query and hash-linked into signed, sealed immutable segments in independently protected blob
 * storage"). This module defines the query-side repository contract; a PostgreSQL adapter
 * implements the same {@link AuditEventRepo} contract, and sealing to blob storage is a separate
 * concern layered on top of `listChain`.
 */

import { recomputeEventHash } from "./chain";
import type { AuditEvent } from "./event";

function snapshotEvent(event: AuditEvent): AuditEvent {
  return Object.freeze({
    ...event,
    occurredAt: new Date(event.occurredAt.getTime()),
    reasonCodes: Object.freeze([...event.reasonCodes]),
    ...(event.safeMetadata ? { safeMetadata: event.safeMetadata } : {}),
    ...(event.safeRefs
      ? {
          safeRefs: Object.freeze(
            event.safeRefs.map((ref) => Object.freeze({ key: ref.key, hash: ref.hash }))
          ),
        }
      : {}),
  });
}

/** Compare-and-append failed because another event advanced the chain first. */
export class AuditAppendConflictError extends Error {
  constructor() {
    super("audit chain advanced before the event could be appended");
    this.name = "AuditAppendConflictError";
  }
}

export interface AuditEventRepo {
  /**
   * Compare-and-append `event`. Implementations must reject unless `chainIndex` and
   * `previousHash` still describe the current tail, and must enforce this in the same durable
   * transaction as the insert.
   */
  append(event: AuditEvent): Promise<void>;
  /** The most recently appended event for `businessId`, or `undefined` if the chain is empty. */
  getLatest(businessId: string): Promise<AuditEvent | undefined>;
  /** The full chain for `businessId`, in ascending `chainIndex` order. */
  listChain(businessId: string): Promise<AuditEvent[]>;
}

/** Process-local reference implementation for tests and single-process composition. */
export class InMemoryAuditEventRepo implements AuditEventRepo {
  private readonly chains = new Map<string, AuditEvent[]>();

  async append(event: AuditEvent): Promise<void> {
    const chain = this.chains.get(event.businessId) ?? [];
    const previous = chain.at(-1);
    const expectedIndex = previous ? previous.chainIndex + 1 : 0;
    const expectedPreviousHash = previous?.hash ?? null;
    if (
      event.chainIndex !== expectedIndex ||
      event.previousHash !== expectedPreviousHash ||
      recomputeEventHash(event) !== event.hash
    ) {
      throw new AuditAppendConflictError();
    }
    chain.push(snapshotEvent(event));
    this.chains.set(event.businessId, chain);
  }

  async getLatest(businessId: string): Promise<AuditEvent | undefined> {
    const chain = this.chains.get(businessId);
    const event = chain?.at(-1);
    return event ? snapshotEvent(event) : undefined;
  }

  async listChain(businessId: string): Promise<AuditEvent[]> {
    return (this.chains.get(businessId) ?? []).map(snapshotEvent);
  }
}
