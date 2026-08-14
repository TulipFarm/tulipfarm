/**
 * Crypto erase destroys only sealed-segment content keys and records hash/count tombstones; content
 * is never decrypted or read.
 */

import { isDeletionBlocked, type LegalHold } from "./legal-hold";
import type { SealedSegment } from "./seal";

/** Destroys the content encryption key for a sealed segment. Never returns key material. */
export interface SegmentKeyPort {
  destroy(segmentId: string): Promise<void>;
}

export type EraseErrorCode = "LEGAL_HOLD" | "ALREADY_ERASED";

export class EraseError extends Error {
  constructor(
    public readonly code: EraseErrorCode,
    message: string
  ) {
    super(message);
    this.name = "EraseError";
  }
}

export interface Tombstone {
  readonly segmentId: string;
  readonly businessId: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly eventCount: number;
  readonly segmentHash: string;
  readonly reason: string;
  readonly erasedAt: Date;
}

/** Legal hold must block crypto erase, or deny-read could be bypassed by destroying content. */
export async function eraseSegment(
  segmentId: string,
  segment: SealedSegment,
  category: string,
  target: string,
  reason: string,
  holds: readonly LegalHold[],
  keyPort: SegmentKeyPort,
  now: Date
): Promise<Tombstone> {
  if (isDeletionBlocked(holds, segment.businessId, category, target, now)) {
    throw new EraseError("LEGAL_HOLD", `segment ${segmentId} is under legal hold`);
  }
  await keyPort.destroy(segmentId);
  return Object.freeze({
    segmentId,
    businessId: segment.businessId,
    startIndex: segment.startIndex,
    endIndex: segment.endIndex,
    eventCount: segment.eventCount,
    segmentHash: segment.segmentHash,
    reason,
    erasedAt: new Date(now.getTime()),
  });
}
