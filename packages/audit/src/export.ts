/** Audit exports verify from payload-free events and seal signatures, never protected blobs. */

import type { AuditEvent } from "./event";
import type { SealedSegment, SealSigner } from "./seal";
import { verifySegmentSeal } from "./seal";
import type { VerifyExpectation, VerifyResult } from "./verify";
import { verifyChain } from "./verify";

export interface AuditExportBundle {
  readonly businessId: string;
  readonly generatedAt: Date;
  readonly events: readonly AuditEvent[];
  readonly seals: readonly SealedSegment[];
}

export type ExportErrorCode = "EMPTY" | "BUSINESS_MISMATCH";

export class ExportError extends Error {
  constructor(
    public readonly code: ExportErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ExportError";
  }
}

/** Builds an export bundle for one business. `events` and `seals` must already be scoped to it. */
export function buildExport(
  businessId: string,
  events: readonly AuditEvent[],
  seals: readonly SealedSegment[],
  generatedAt: Date
): AuditExportBundle {
  for (const event of events) {
    if (event.businessId !== businessId) {
      throw new ExportError("BUSINESS_MISMATCH", `event ${event.id} belongs to another business`);
    }
  }
  for (const seal of seals) {
    if (seal.businessId !== businessId) {
      throw new ExportError(
        "BUSINESS_MISMATCH",
        `segment ${seal.segmentHash} belongs to another business`
      );
    }
  }
  return Object.freeze({
    businessId,
    generatedAt: new Date(generatedAt.getTime()),
    events: Object.freeze([...events]),
    seals: Object.freeze([...seals]),
  });
}

export interface ExportVerifyResult {
  readonly chain: VerifyResult;
  readonly sealsValid: boolean;
  readonly invalidSeals: readonly string[];
}

/** Verifies hashes/signatures only; crypto-erased segments still verify. */
export async function verifyExport(
  bundle: AuditExportBundle,
  signer: SealSigner,
  expectation: VerifyExpectation = {}
): Promise<ExportVerifyResult> {
  const chain = verifyChain(bundle.events, expectation);
  const invalidSeals: string[] = [];
  for (const seal of bundle.seals) {
    const ok = await verifySegmentSeal(seal, signer);
    if (!ok) invalidSeals.push(seal.segmentHash);
  }
  return { chain, sealsValid: invalidSeals.length === 0, invalidSeals };
}
