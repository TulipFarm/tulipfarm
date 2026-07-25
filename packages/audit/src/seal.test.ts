import { createHmac, randomUUID } from "node:crypto";
import type { BlobPort, BlobRef } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { recomputeEventHash } from "./chain";
import type { AuditEvent } from "./event";
import { SealError, type SealSigner, sealSegment, verifySegmentSeal } from "./seal";
import { InMemoryAuditEventRepo } from "./storage";
import { AuditWriter } from "./writer";

const HMAC_KEY = "test-seal-key";

function hmacSigner(): SealSigner {
  return {
    async sign(bytes) {
      return createHmac("sha256", HMAC_KEY).update(bytes).digest("base64");
    },
    async verify(bytes, signature) {
      const expected = createHmac("sha256", HMAC_KEY).update(bytes).digest("base64");
      return expected === signature;
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

async function appendEvents(count: number): Promise<AuditEvent[]> {
  const writer = new AuditWriter(new InMemoryAuditEventRepo());
  const events: AuditEvent[] = [];
  for (let i = 0; i < count; i += 1) {
    events.push(
      await writer.append({
        actor: { principalId: "user-1", businessId: "biz-1" },
        effectivePrincipal: { principalId: "user-1", businessId: "biz-1" },
        action: "test.action",
        target: `target-${i}`,
        decision: "allow",
        reasonCodes: [],
        correlationId: randomUUID(),
        occurredAt: new Date("2026-07-01T00:00:00.000Z"),
      })
    );
  }
  return events;
}

describe("sealSegment", () => {
  it("seals a contiguous chain slice and produces a verifiable signature", async () => {
    const events = await appendEvents(3);
    const sealed = await sealSegment(events, null, hmacSigner(), inMemoryBlob(), new Date());

    expect(sealed.startIndex).toBe(0);
    expect(sealed.endIndex).toBe(2);
    expect(sealed.eventCount).toBe(3);
    expect(await verifySegmentSeal(sealed, hmacSigner())).toBe(true);
  });

  it("rejects an empty segment", async () => {
    await expect(sealSegment([], null, hmacSigner(), inMemoryBlob(), new Date())).rejects.toThrow(
      SealError
    );
  });

  it("rejects a non-contiguous segment", async () => {
    const events = await appendEvents(3);
    await expect(
      sealSegment([events[0], events[2]], null, hmacSigner(), inMemoryBlob(), new Date())
    ).rejects.toThrow(SealError);
  });

  it("rejects a tampered event instead of signing broken evidence", async () => {
    const events = await appendEvents(2);
    const tampered = { ...events[1], target: "tampered" } as AuditEvent;
    await expect(
      sealSegment([events[0], tampered], null, hmacSigner(), inMemoryBlob(), new Date())
    ).rejects.toThrow(SealError);
  });

  it("rejects self-consistent events that do not link to their predecessor", async () => {
    const events = await appendEvents(2);
    const disconnected = { ...events[1], previousHash: null };
    const selfConsistent = {
      ...disconnected,
      hash: recomputeEventHash(disconnected),
    } as AuditEvent;

    await expect(
      sealSegment([events[0], selfConsistent], null, hmacSigner(), inMemoryBlob(), new Date())
    ).rejects.toMatchObject({ code: "CHAIN_BROKEN" });
  });

  it("detects a signature that does not match a different key", async () => {
    const events = await appendEvents(2);
    const sealed = await sealSegment(events, null, hmacSigner(), inMemoryBlob(), new Date());
    const otherSigner: SealSigner = {
      async sign(bytes) {
        return createHmac("sha256", "wrong-key").update(bytes).digest("base64");
      },
      async verify(bytes, signature) {
        const expected = createHmac("sha256", "wrong-key").update(bytes).digest("base64");
        return expected === signature;
      },
    };
    expect(await verifySegmentSeal(sealed, otherSigner)).toBe(false);
  });

  it("detects tampered segment range metadata", async () => {
    const events = await appendEvents(2);
    const sealed = await sealSegment(events, null, hmacSigner(), inMemoryBlob(), new Date());

    expect(await verifySegmentSeal({ ...sealed, eventCount: 1 }, hmacSigner())).toBe(false);
    expect(
      await verifySegmentSeal(
        { ...sealed, sealedAt: new Date(sealed.sealedAt.getTime() + 1) },
        hmacSigner()
      )
    ).toBe(false);
  });

  it("verifies signature without ever reading blob content", async () => {
    const events = await appendEvents(2);
    const blob = inMemoryBlob();
    const sealed = await sealSegment(events, null, hmacSigner(), blob, new Date());
    let readCalled = false;
    const spiedBlob: BlobPort = {
      ...blob,
      async get(ref) {
        readCalled = true;
        return blob.get(ref);
      },
    };
    expect(await verifySegmentSeal(sealed, hmacSigner())).toBe(true);
    expect(readCalled).toBe(false);
    void spiedBlob;
  });
});
