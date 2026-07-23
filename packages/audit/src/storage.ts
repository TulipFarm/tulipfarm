/**
 * Append-only persistence for audit events (SPEC §20: "Events are appended in PostgreSQL for
 * query and hash-linked into signed, sealed immutable segments in independently protected blob
 * storage"). This module defines the query-side repository contract; a PostgreSQL adapter
 * implements the same {@link AuditEventRepo} contract, and sealing to blob storage is a separate
 * concern layered on top of `listChain`.
 */

import type { AuditEvent } from "./event";

export interface AuditEventRepo {
  /** Appends `event` to its business's chain. Callers must not mutate `chainIndex`/`previousHash`
   *  after construction — this is an append-only ledger, never an update. */
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
    chain.push(Object.freeze({ ...event }));
    this.chains.set(event.businessId, chain);
  }

  async getLatest(businessId: string): Promise<AuditEvent | undefined> {
    const chain = this.chains.get(businessId);
    return chain?.at(-1);
  }

  async listChain(businessId: string): Promise<AuditEvent[]> {
    return [...(this.chains.get(businessId) ?? [])];
  }
}
