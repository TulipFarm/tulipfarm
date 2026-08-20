import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { collectBlobBytes } from "./blob";
import { InMemoryS3 } from "./in-memory-s3";
import { S3_PART_BYTES, S3BlobError, S3BlobPort } from "./s3-blob";

function pattern(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 17 + 3) % 251;
  return bytes;
}

async function* inChunks(bytes: Uint8Array, chunk = 64 * 1024): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    yield bytes.subarray(offset, Math.min(offset + chunk, bytes.length));
  }
}

describe("S3BlobPort", () => {
  it("writes a small object in one request, with no staging and no copy", async () => {
    const s3 = new InMemoryS3();
    const blobs = new S3BlobPort(s3);
    await blobs.put(new TextEncoder().encode("small enough"));

    expect(s3.calls.put).toBe(1);
    expect(s3.calls.multipart).toBe(0);
    expect(s3.calls.copy).toBe(0);
    expect(s3.keys()).toHaveLength(1);
  });

  it("never holds more than one part of a large object in memory", async () => {
    const s3 = new InMemoryS3();
    const blobs = new S3BlobPort(s3);
    const payload = pattern(S3_PART_BYTES * 3 + 1024);

    await blobs.put(inChunks(payload));

    expect(s3.calls.multipart).toBe(1);
    // The whole point: the largest single write is one part, not the object.
    expect(s3.largestWrite).toBeLessThan(payload.byteLength);
    expect(s3.largestWrite).toBeLessThanOrEqual(S3_PART_BYTES + 64 * 1024);
  });

  it("leaves only the content-addressed object behind, not the staged one", async () => {
    const s3 = new InMemoryS3();
    const blobs = new S3BlobPort(s3);
    const payload = pattern(S3_PART_BYTES + 512);

    const ref = await blobs.put(inChunks(payload));

    expect(s3.calls.copy).toBe(1);
    expect(s3.keys()).toEqual([`${ref.hash.slice(0, 2)}/${ref.hash}`]);
    expect(s3.hasDanglingUpload()).toBe(false);
  });

  it("reassembles a multipart upload into exactly the bytes it was handed", async () => {
    const s3 = new InMemoryS3();
    const blobs = new S3BlobPort(s3);
    const payload = pattern(S3_PART_BYTES * 2 + 7);

    const ref = await blobs.put(inChunks(payload));

    expect(ref.hash).toBe(createHash("sha256").update(payload).digest("hex"));
    const read = await collectBlobBytes(await blobs.get(ref));
    expect(Buffer.from(read).equals(Buffer.from(payload))).toBe(true);
  });

  it("abandons no multipart upload when the body fails partway through", async () => {
    const s3 = new InMemoryS3();
    const blobs = new S3BlobPort(s3);
    async function* failing(): AsyncIterable<Uint8Array> {
      yield pattern(S3_PART_BYTES + 16);
      throw new Error("the source went away");
    }

    await expect(blobs.put(failing())).rejects.toThrow("the source went away");
    // An abandoned multipart bills for its parts until a lifecycle rule reaps it, and a provider
    // may have none, so the failing call has to clean up after itself.
    expect(s3.calls.abort).toBe(1);
    expect(s3.hasDanglingUpload()).toBe(false);
  });

  it("puts identical content at one address however it arrived", async () => {
    const s3 = new InMemoryS3();
    const blobs = new S3BlobPort(s3);
    const payload = pattern(S3_PART_BYTES + 100);

    const streamed = await blobs.put(inChunks(payload));
    const whole = await blobs.put(payload);

    expect(whole.hash).toBe(streamed.hash);
    expect(s3.keys()).toEqual([`${streamed.hash.slice(0, 2)}/${streamed.hash}`]);
  });

  it("keeps a prefix in front of every key it writes", async () => {
    const s3 = new InMemoryS3();
    const blobs = new S3BlobPort(s3, { prefix: "tulip/" });

    const ref = await blobs.put(new TextEncoder().encode("prefixed"));

    expect(s3.keys()).toEqual([`tulip/${ref.hash.slice(0, 2)}/${ref.hash}`]);
    const read = await collectBlobBytes(await blobs.get(ref));
    expect(new TextDecoder().decode(read)).toBe("prefixed");
  });

  it("keeps two prefixes in one bucket from seeing each other", async () => {
    const s3 = new InMemoryS3();
    const mine = new S3BlobPort(s3, { prefix: "mine/" });
    const yours = new S3BlobPort(s3, { prefix: "yours/" });

    const ref = await mine.put(new TextEncoder().encode("not yours"));

    expect(await yours.head(ref)).toBeNull();
  });

  it("refuses a ref whose key was not derived from its content", async () => {
    const blobs = new S3BlobPort(new InMemoryS3());
    const ref = await blobs.put(new TextEncoder().encode("honest"));

    await expect(blobs.get({ key: "elsewhere", hash: ref.hash })).rejects.toBeInstanceOf(
      S3BlobError
    );
  });

  it("passes a content type through to the object it writes", async () => {
    const s3 = new InMemoryS3();
    const blobs = new S3BlobPort(s3);

    const ref = await blobs.put(new TextEncoder().encode("%PDF-1.7"), "application/pdf");

    expect((await blobs.head(ref))?.contentType).toBe("application/pdf");
  });
});
