import { BLOB_CONFORMANCE, type BlobPort, TAMPER_CONFORMANCE } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { InMemoryBlobError, InMemoryBlobPort } from "./blob";

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The contract itself is proven by `@tulipfarm/storage`, which runs its blob conformance suite
 * against this fake alongside both real drivers. What is left here is the fake's own affordances:
 * the things a test reaches for that no production implementation offers.
 */
/**
 * The fake declares the port structurally rather than importing it, so this file is the only thing
 * that would notice the two drifting apart — at compile time through the annotation below, and at
 * run time through the suite the real drivers are held to.
 */
describe("InMemoryBlobPort conformance", () => {
  const make = async (): Promise<BlobPort> => new InMemoryBlobPort();

  for (const check of BLOB_CONFORMANCE) {
    // The large-object checks byte-compare a multi-megabyte payload; under coverage
    // instrumentation on a loaded CI runner that comfortably clears vitest's 5000ms default.
    it(check.name, async () => {
      await check.run(make);
    }, 20_000);
  }

  for (const check of TAMPER_CONFORMANCE) {
    it(check.name, async () => {
      await check.run(async () => {
        const blobs = new InMemoryBlobPort();
        return { blobs, corrupt: async (ref) => blobs.corrupt(ref, new Uint8Array([1, 2, 3])) };
      });
    });
  }
});

describe("InMemoryBlobPort", () => {
  it("reports how many objects it is holding", async () => {
    const blobs = new InMemoryBlobPort();
    expect(blobs.size).toBe(0);

    await blobs.put(new TextEncoder().encode("one"));
    await blobs.put(new TextEncoder().encode("two"));
    await blobs.put(new TextEncoder().encode("one"));

    expect(blobs.size).toBe(2);
  });

  it("lets a test corrupt an object to prove verification bites", async () => {
    const blobs = new InMemoryBlobPort();
    const ref = await blobs.put(new TextEncoder().encode("honest"));

    blobs.corrupt(ref);

    await expect(collect(await blobs.get(ref))).rejects.toBeInstanceOf(InMemoryBlobError);
  });

  it("refuses to corrupt an object it never held", async () => {
    const blobs = new InMemoryBlobPort();
    const absent = { key: "0".repeat(64), hash: "0".repeat(64) };

    expect(() => blobs.corrupt(absent)).toThrow(InMemoryBlobError);
  });

  it("holds nothing between instances, so no test can see another's objects", async () => {
    const first = new InMemoryBlobPort();
    const ref = await first.put(new TextEncoder().encode("mine"));

    expect(await new InMemoryBlobPort().head(ref)).toBeNull();
  });
});
