/**
 * Single append path for audit evidence (SPEC §20). Computes chain linkage (`chainIndex`,
 * `previousHash`, `hash`) from the business's current chain tail, then appends through the repo.
 * This is the only place a chained hash is produced — callers never set it themselves.
 */

import { randomUUID } from "node:crypto";
import { computeEventHash } from "./chain";
import type { AuditEvent, AuditEventInput } from "./event";
import type { AuditEventRepo } from "./storage";

export class AuditWriter {
  constructor(private readonly repo: AuditEventRepo) {}

  async append(input: AuditEventInput): Promise<AuditEvent> {
    const businessId = input.actor.businessId;
    const previous = await this.repo.getLatest(businessId);
    const chainIndex = previous ? previous.chainIndex + 1 : 0;
    const previousHash = previous ? previous.hash : null;
    const id = randomUUID();
    const hash = computeEventHash(input, id, businessId, chainIndex, previousHash);

    const event: AuditEvent = {
      ...input,
      id,
      businessId,
      chainIndex,
      previousHash,
      hash,
    };

    await this.repo.append(event);
    return event;
  }
}
