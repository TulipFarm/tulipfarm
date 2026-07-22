import { describe, expect, it } from "vitest";
import type { BlobPort, BlobRef } from "./blob";

// Deterministic content hash for the test double — a real adapter uses sha256.
function contentHash(bytes: Uint8Array): string {
  let h = 2166136261;
  for (const b of bytes) {
    h = Math.imul(h ^ b, 16777619) >>> 0;
  }
  return h.toString(16);
}

// A content-addressed in-memory blob store proves the port stays provider-neutral
// (no S3/filesystem type leaks) and keys payloads by content hash (SPEC §19).
function fakeBlobStore(): BlobPort {
  const store = new Map<string, Uint8Array>();
  return {
    put: async (bytes: Uint8Array) => {
      const hash = contentHash(bytes);
      store.set(hash, bytes);
      return { key: hash, hash };
    },
    get: async (ref: BlobRef) => {
      const bytes = store.get(ref.hash);
      if (!bytes) throw new Error(`blob not found: ${ref.hash}`);
      return bytes;
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
    expect([...(await blob.get(ref))]).toEqual([9, 8, 7]);
  });

  it("deletes by reference", async () => {
    const blob = fakeBlobStore();
    const ref = await blob.put(new Uint8Array([1]));
    await blob.delete(ref);
    await expect(blob.get(ref)).rejects.toThrow(/not found/);
  });
});
