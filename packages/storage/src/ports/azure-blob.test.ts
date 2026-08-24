import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AZURE_BLOCK_BYTES, AzureBlobError, AzureBlobPort } from "./azure-blob";
import { collectBlobBytes } from "./blob";
import { InMemoryAzureBlob } from "./in-memory-azure-blob";

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

describe("AzureBlobPort", () => {
  it("writes a small object in one upload, with no staging and no copy", async () => {
    const azure = new InMemoryAzureBlob();
    const blobs = new AzureBlobPort(azure);
    await blobs.put(new TextEncoder().encode("small enough"));

    expect(azure.calls.put).toBe(1);
    expect(azure.calls.stageBlock).toBe(0);
    expect(azure.calls.commit).toBe(0);
    expect(azure.calls.copy).toBe(0);
    expect(azure.keys()).toHaveLength(1);
  });

  it("never holds more than one block of a large object in memory", async () => {
    const azure = new InMemoryAzureBlob();
    const blobs = new AzureBlobPort(azure);
    const payload = pattern(AZURE_BLOCK_BYTES * 3 + 1024);

    await blobs.put(inChunks(payload));

    expect(azure.calls.commit).toBe(1);
    // The whole point: the largest single write is one block, not the object.
    expect(azure.largestWrite).toBeLessThan(payload.byteLength);
    expect(azure.largestWrite).toBeLessThanOrEqual(AZURE_BLOCK_BYTES + 64 * 1024);
  });

  it("leaves only the content-addressed object behind, not the staged one", async () => {
    const azure = new InMemoryAzureBlob();
    const blobs = new AzureBlobPort(azure);
    const payload = pattern(AZURE_BLOCK_BYTES + 512);

    const ref = await blobs.put(inChunks(payload));

    expect(azure.calls.copy).toBe(1);
    expect(azure.keys()).toEqual([`${ref.hash.slice(0, 2)}/${ref.hash}`]);
    expect(azure.hasUncommittedBlocks()).toBe(false);
  });

  it("reassembles a staged upload into exactly the bytes it was handed", async () => {
    const azure = new InMemoryAzureBlob();
    const blobs = new AzureBlobPort(azure);
    const payload = pattern(AZURE_BLOCK_BYTES * 2 + 7);

    const ref = await blobs.put(inChunks(payload));

    expect(ref.hash).toBe(createHash("sha256").update(payload).digest("hex"));
    const read = await collectBlobBytes(await blobs.get(ref));
    expect(Buffer.from(read).equals(Buffer.from(payload))).toBe(true);
  });

  it("commits nothing when the body fails partway through", async () => {
    const azure = new InMemoryAzureBlob();
    const blobs = new AzureBlobPort(azure);
    async function* failing(): AsyncIterable<Uint8Array> {
      yield pattern(AZURE_BLOCK_BYTES + 16);
      throw new Error("the source went away");
    }

    await expect(blobs.put(failing())).rejects.toThrow("the source went away");
    // Uncommitted blocks are Azure's to garbage-collect, so the failing call needs no abort — but
    // it must never have committed a visible blob.
    expect(azure.calls.commit).toBe(0);
    expect(azure.keys()).toEqual([]);
  });

  it("puts identical content at one address however it arrived", async () => {
    const azure = new InMemoryAzureBlob();
    const blobs = new AzureBlobPort(azure);
    const payload = pattern(AZURE_BLOCK_BYTES + 100);

    const streamed = await blobs.put(inChunks(payload));
    const whole = await blobs.put(payload);

    expect(whole.hash).toBe(streamed.hash);
    expect(azure.keys()).toEqual([`${streamed.hash.slice(0, 2)}/${streamed.hash}`]);
  });

  it("keeps a prefix in front of every key it writes", async () => {
    const azure = new InMemoryAzureBlob();
    const blobs = new AzureBlobPort(azure, { prefix: "tulip/" });

    const ref = await blobs.put(new TextEncoder().encode("prefixed"));

    expect(azure.keys()).toEqual([`tulip/${ref.hash.slice(0, 2)}/${ref.hash}`]);
    const read = await collectBlobBytes(await blobs.get(ref));
    expect(new TextDecoder().decode(read)).toBe("prefixed");
  });

  it("keeps two prefixes in one container from seeing each other", async () => {
    const azure = new InMemoryAzureBlob();
    const mine = new AzureBlobPort(azure, { prefix: "mine/" });
    const yours = new AzureBlobPort(azure, { prefix: "yours/" });

    const ref = await mine.put(new TextEncoder().encode("not yours"));

    expect(await yours.head(ref)).toBeNull();
  });

  it("refuses a ref whose key was not derived from its content", async () => {
    const blobs = new AzureBlobPort(new InMemoryAzureBlob());
    const ref = await blobs.put(new TextEncoder().encode("honest"));

    await expect(blobs.get({ key: "elsewhere", hash: ref.hash })).rejects.toBeInstanceOf(
      AzureBlobError
    );
  });

  it("passes a content type through to the object it writes", async () => {
    const azure = new InMemoryAzureBlob();
    const blobs = new AzureBlobPort(azure);

    const ref = await blobs.put(new TextEncoder().encode("%PDF-1.7"), "application/pdf");

    expect((await blobs.head(ref))?.contentType).toBe("application/pdf");
  });

  it("carries a content type through a staged multi-block upload too", async () => {
    const azure = new InMemoryAzureBlob();
    const blobs = new AzureBlobPort(azure);
    const payload = pattern(AZURE_BLOCK_BYTES + 512);

    const ref = await blobs.put(inChunks(payload), "application/octet-stream");

    expect((await blobs.head(ref))?.contentType).toBe("application/octet-stream");
  });
});
