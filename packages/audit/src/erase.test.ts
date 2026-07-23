import { createHmac, randomUUID } from "node:crypto";
import type { BlobPort, BlobRef } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { EraseError, eraseSegment, type SegmentKeyPort } from "./erase";
import { placeLegalHold } from "./legal-hold";
import { type SealSigner, sealSegment } from "./seal";
import { InMemoryAuditEventRepo } from "./storage";
import { AuditWriter } from "./writer";

function hmacSigner(): SealSigner {
  return {
    async sign(bytes) {
      return createHmac("sha256", "key").update(bytes).digest("base64");
    },
    async verify(bytes, signature) {
      return createHmac("sha256", "key").update(bytes).digest("base64") === signature;
    },
  };
}

function inMemoryBlob(): BlobPort {
  const store = new Map<string, Uint8Array>();
  return {
    async put(bytes) {
      const hash = createHmac("sha256", "blob").update(bytes).digest("hex");
      const ref: BlobRef = { key: hash, hash };
      store.set(ref.key, bytes);
      return ref;
    },
    async get(ref) {
      const bytes = store.get(ref.key);
      if (!bytes) throw new Error("not found");
      return bytes;
    },
    async delete(ref) {
      store.delete(ref.key);
    },
  };
}

function fakeKeyPort(): SegmentKeyPort & { destroyed: string[] } {
  const destroyed: string[] = [];
  return {
    destroyed,
    async destroy(segmentId) {
      destroyed.push(segmentId);
    },
  };
}

async function sealedFixture() {
  const writer = new AuditWriter(new InMemoryAuditEventRepo());
  const events = [
    await writer.append({
      actor: { principalId: "user-1", businessId: "biz-1" },
      effectivePrincipal: { principalId: "user-1", businessId: "biz-1" },
      action: "test.action",
      target: "target-1",
      decision: "allow",
      reasonCodes: [],
      correlationId: randomUUID(),
      occurredAt: new Date("2026-07-01T00:00:00.000Z"),
    }),
  ];
  return sealSegment(events, null, hmacSigner(), inMemoryBlob(), new Date());
}

describe("eraseSegment", () => {
  it("destroys the segment key and returns a tombstone with only hash/count evidence", async () => {
    const segment = await sealedFixture();
    const keyPort = fakeKeyPort();
    const tombstone = await eraseSegment(
      "segment-1",
      segment,
      "security",
      "target-1",
      "retention expired",
      [],
      keyPort,
      new Date("2026-08-01")
    );

    expect(keyPort.destroyed).toEqual(["segment-1"]);
    expect(tombstone.segmentHash).toBe(segment.segmentHash);
    expect(tombstone.eventCount).toBe(segment.eventCount);
    expect(Object.keys(tombstone).sort()).not.toContain("payload");
  });

  it("refuses to erase a segment under active legal hold", async () => {
    const segment = await sealedFixture();
    const keyPort = fakeKeyPort();
    const hold = placeLegalHold({
      id: "hold-1",
      businessId: "biz-1",
      scope: { type: "target", target: "target-1" },
      reason: "litigation",
      createdAt: new Date("2026-01-01"),
    });

    await expect(
      eraseSegment(
        "segment-1",
        segment,
        "security",
        "target-1",
        "retention expired",
        [hold],
        keyPort,
        new Date("2026-08-01")
      )
    ).rejects.toThrow(EraseError);
    expect(keyPort.destroyed).toEqual([]);
  });
});
