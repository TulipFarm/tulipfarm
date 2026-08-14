/** Only append path that computes audit chain linkage; callers never set hashes. */

import { randomUUID } from "node:crypto";
import { computeEventHash } from "./chain";
import { type AuditEvent, type AuditEventInput, normalizeAuditEventInput } from "./event";
import { AuditAppendConflictError, type AuditEventRepo } from "./storage";

const MAX_APPEND_ATTEMPTS = 32;

export class AuditWriter {
  constructor(private readonly repo: AuditEventRepo) {}

  async append(input: AuditEventInput): Promise<AuditEvent> {
    const normalized = normalizeAuditEventInput(input);
    const businessId = normalized.actor.businessId;
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
      const previous = await this.repo.getLatest(businessId);
      const chainIndex = previous ? previous.chainIndex + 1 : 0;
      const previousHash = previous ? previous.hash : null;
      const id = randomUUID();
      const hash = computeEventHash(normalized, id, businessId, chainIndex, previousHash);
      const event: AuditEvent = Object.freeze({
        ...normalized,
        id,
        businessId,
        chainIndex,
        previousHash,
        hash,
      });

      try {
        await this.repo.append(event);
        return event;
      } catch (error) {
        if (!(error instanceof AuditAppendConflictError)) throw error;
      }
    }
    throw new AuditAppendConflictError();
  }
}
