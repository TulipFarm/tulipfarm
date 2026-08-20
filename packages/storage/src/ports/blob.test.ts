import { describe, expect, it } from "vitest";
import { type BlobBody, type BlobPort, type BlobRef, collectBlobBytes } from "./blob";

// Deterministic content hash for the test double — a real adapter uses sha256.
function contentHash(bytes: Uint8Array): string {
  let h = 2166136261;
  for (const b of bytes) {
    h = Math.imul(h ^ b, 16777619) >>> 0;
  }
  return h.toString(16);
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

// A content-addressed in-memory blob store proves the port stays provider-neutral
// (no S3/filesystem type leaks) and keys payloads by content hash (SPEC §19).
function fakeBlobStore(): BlobPort {
  const store = new Map<string, Uint8Array>();
  return {
    put: async (body: BlobBody) => {
      const bytes = body instanceof Uint8Array ? body : await collectBlobBytes(body);
      const hash = contentHash(bytes);
      store.set(hash, bytes);
      return { key: hash, hash };
    },
    get: async (ref: BlobRef, range) => {
      const bytes = store.get(ref.hash);
      if (!bytes) throw new Error(`blob not found: ${ref.hash}`);
      if (!range) return oneChunk(bytes);
      return oneChunk(
        bytes.slice(range.start, range.end === undefined ? undefined : range.end + 1)
      );
    },
    head: async (ref: BlobRef) => {
      const bytes = store.get(ref.hash);
      return bytes === undefined ? null : { size: bytes.byteLength };
    },
    delete: async (ref: BlobRef) => {
      store.delete(ref.hash);
    },
  };
}

describe("BlobPort", () => {
  it("stores and retrieves a content-addressed payload", async () => {
    const blob = fakeBlobStore();
    const ref = await blob.put(new Uint8Array([9, 8, 7]));
    expect(ref.hash).toBe(ref.key);
    expect([...(await collectBlobBytes(await blob.get(ref)))]).toEqual([9, 8, 7]);
  });

  it("accepts a body that arrives in chunks", async () => {
    const blob = fakeBlobStore();
    async function* chunked(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3]);
    }

    const streamed = await blob.put(chunked());

    expect(streamed).toEqual(await blob.put(new Uint8Array([1, 2, 3])));
  });

  it("reports size without reading the body, and null when absent", async () => {
    const blob = fakeBlobStore();
    const ref = await blob.put(new Uint8Array([1, 2, 3, 4]));

    expect(await blob.head(ref)).toEqual({ size: 4 });
    await blob.delete(ref);
    expect(await blob.head(ref)).toBeNull();
  });

  it("serves an inclusive byte range", async () => {
    const blob = fakeBlobStore();
    const ref = await blob.put(new Uint8Array([0, 1, 2, 3, 4]));

    expect([...(await collectBlobBytes(await blob.get(ref, { start: 1, end: 3 })))]).toEqual([
      1, 2, 3,
    ]);
    expect([...(await collectBlobBytes(await blob.get(ref, { start: 3 })))]).toEqual([3, 4]);
  });

  it("deletes by reference", async () => {
    const blob = fakeBlobStore();
    const ref = await blob.put(new Uint8Array([1]));
    await blob.delete(ref);
    await expect(blob.get(ref)).rejects.toThrow(/not found/);
  });
});

describe("collectBlobBytes", () => {
  it("joins chunks in order", async () => {
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([]);
      yield new Uint8Array([3, 4, 5]);
    }

    expect([...(await collectBlobBytes(chunks()))]).toEqual([1, 2, 3, 4, 5]);
  });
});
