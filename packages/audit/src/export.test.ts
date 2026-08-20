import { createHmac, randomUUID } from "node:crypto";
import { type BlobPort, type BlobRef, collectBlobBytes } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import type { AuditEvent } from "./event";
import { buildExport, ExportError, verifyExport } from "./export";
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

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

function inMemoryBlob(): BlobPort {
  const store = new Map<string, Uint8Array>();
  return {
    async put(body) {
      const bytes = body instanceof Uint8Array ? body : await collectBlobBytes(body);
      const hash = createHmac("sha256", "blob").update(bytes).digest("hex");
      const ref: BlobRef = { key: hash, hash };
      store.set(ref.key, bytes);
      return ref;
    },
    async get(ref) {
      const bytes = store.get(ref.key);
      if (!bytes) throw new Error("not found");
      return oneChunk(bytes);
    },
    async head(ref) {
      const bytes = store.get(ref.key);
      return bytes === undefined ? null : { size: bytes.byteLength };
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

describe("export", () => {
  it("builds and verifies a bundle without reading blob content", async () => {
    const events = await appendEvents(3);
    const blob = inMemoryBlob();
    const seal = await sealSegment(events, null, hmacSigner(), blob, new Date());
    const bundle = buildExport("biz-1", events, [seal], new Date());

    let readCalled = false;
    const spiedSigner: SealSigner = {
      ...hmacSigner(),
    };
    void spiedSigner;
    const originalGet = blob.get.bind(blob);
    blob.get = async (ref) => {
      readCalled = true;
      return originalGet(ref);
    };

    const result = await verifyExport(bundle, hmacSigner());
    expect(result.chain.valid).toBe(true);
    expect(result.sealsValid).toBe(true);
    expect(readCalled).toBe(false);
  });

  it("flags a tampered event as invalid", async () => {
    const events = await appendEvents(2);
    const seal = await sealSegment(events, null, hmacSigner(), inMemoryBlob(), new Date());
    const tampered = { ...events[1], target: "tampered" } as AuditEvent;
    const bundle = buildExport("biz-1", [events[0], tampered], [seal], new Date());

    const result = await verifyExport(bundle, hmacSigner());
    expect(result.chain.valid).toBe(false);
  });

  it("flags an invalid seal signature", async () => {
    const events = await appendEvents(1);
    const seal = await sealSegment(events, null, hmacSigner(), inMemoryBlob(), new Date());
    const bundle = buildExport("biz-1", events, [seal], new Date());

    const wrongSigner: SealSigner = {
      async sign(bytes) {
        return createHmac("sha256", "wrong").update(bytes).digest("base64");
      },
      async verify(bytes, signature) {
        return createHmac("sha256", "wrong").update(bytes).digest("base64") === signature;
      },
    };
    const result = await verifyExport(bundle, wrongSigner);
    expect(result.sealsValid).toBe(false);
    expect(result.invalidSeals).toEqual([seal.segmentHash]);
  });

  it("rejects mixing another business's events into the bundle", async () => {
    const events = await appendEvents(1);
    expect(() => buildExport("biz-2", events, [], new Date())).toThrow(ExportError);
  });
});
