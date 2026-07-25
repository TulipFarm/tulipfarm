/**
 * Signs and seals a contiguous slice of a hash-linked chain into independently protected blob
 * storage (SPEC §20: "hash-linked into signed, sealed immutable segments in independently
 * protected blob storage. A verifier can detect missing, reordered, or altered evidence.").
 * Sealing does not replace {@link verifyChain}; it adds an offline-verifiable anchor so tamper
 * can be detected even if the PostgreSQL chain itself is altered.
 */

import { canonicalHash } from "@tulipfarm/schema";
import type { BlobPort, BlobRef } from "@tulipfarm/storage";
import { recomputeEventHash } from "./chain";
import type { AuditEvent } from "./event";

/** Signs/verifies opaque bytes. Key material and algorithm choice belong to the adapter. */
export interface SealSigner {
  sign(bytes: Uint8Array): Promise<string>;
  verify(bytes: Uint8Array, signature: string): Promise<boolean>;
}

export type SealErrorCode = "EMPTY_SEGMENT" | "NON_CONTIGUOUS" | "CHAIN_BROKEN";

export class SealError extends Error {
  constructor(
    public readonly code: SealErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SealError";
  }
}

export interface SealedSegment {
  readonly businessId: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly eventCount: number;
  readonly segmentHash: string;
  readonly previousSegmentHash: string | null;
  readonly signature: string;
  readonly blobRef: BlobRef;
  readonly sealedAt: Date;
}

function serializeSegment(events: readonly AuditEvent[]): Uint8Array {
  const body = events.map((event) => ({
    id: event.id,
    chainIndex: event.chainIndex,
    previousHash: event.previousHash,
    hash: event.hash,
  }));
  return new TextEncoder().encode(JSON.stringify(body));
}

/**
 * Seals `events` (one business's contiguous chain slice, ascending `chainIndex`, no gaps) into
 * blob storage and signs the result. Throws {@link SealError} instead of sealing evidence that
 * would already fail {@link verifyChain} — a broken chain must never be signed as authentic.
 */
export async function sealSegment(
  events: readonly AuditEvent[],
  previousSegmentHash: string | null,
  signer: SealSigner,
  blob: BlobPort,
  sealedAt: Date
): Promise<SealedSegment> {
  if (events.length === 0) {
    throw new SealError("EMPTY_SEGMENT", "cannot seal an empty segment");
  }
  const businessId = events[0].businessId;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event.businessId !== businessId) {
      throw new SealError("NON_CONTIGUOUS", "segment mixes events from different businesses");
    }
    if (i > 0 && event.chainIndex !== events[i - 1].chainIndex + 1) {
      throw new SealError("NON_CONTIGUOUS", "segment chainIndex must be contiguous and ascending");
    }
    if (i > 0 && event.previousHash !== events[i - 1].hash) {
      throw new SealError("CHAIN_BROKEN", `event ${event.id} does not link to its predecessor`);
    }
    if (recomputeEventHash(event) !== event.hash) {
      throw new SealError("CHAIN_BROKEN", `event ${event.id} hash does not match its content`);
    }
  }

  const bytes = serializeSegment(events);
  const blobRef = await blob.put(bytes, "application/json");
  const eventCount = events.length;
  const segmentHash = canonicalHash({
    businessId,
    startIndex: events[0].chainIndex,
    endIndex: events.at(-1)?.chainIndex ?? -1,
    eventCount,
    previousSegmentHash,
    blobHash: blobRef.hash,
    sealedAt: sealedAt.toISOString(),
  });
  const signature = await signer.sign(new TextEncoder().encode(segmentHash));

  return Object.freeze({
    businessId,
    startIndex: events[0].chainIndex,
    endIndex: events.at(-1)?.chainIndex ?? -1,
    eventCount,
    segmentHash,
    previousSegmentHash,
    signature,
    blobRef,
    sealedAt: new Date(sealedAt.getTime()),
  });
}

/** Recomputes `segment.segmentHash` and checks its signature, without reading blob contents. */
export async function verifySegmentSeal(
  segment: SealedSegment,
  signer: SealSigner
): Promise<boolean> {
  const segmentHash = canonicalHash({
    businessId: segment.businessId,
    startIndex: segment.startIndex,
    endIndex: segment.endIndex,
    eventCount: segment.eventCount,
    previousSegmentHash: segment.previousSegmentHash,
    blobHash: segment.blobRef.hash,
    sealedAt: segment.sealedAt.toISOString(),
  });
  if (segment.eventCount !== segment.endIndex - segment.startIndex + 1) return false;
  if (segmentHash !== segment.segmentHash) return false;
  return signer.verify(new TextEncoder().encode(segmentHash), segment.signature);
}
