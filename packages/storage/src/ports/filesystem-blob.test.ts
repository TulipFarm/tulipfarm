import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectBlobBytes } from "./blob";
import { FileSystemBlobPort } from "./filesystem-blob";

const roots: string[] = [];

async function store(): Promise<FileSystemBlobPort> {
  const root = await mkdtemp(join(tmpdir(), "tulip-blob-"));
  roots.push(root);
  return new FileSystemBlobPort(root);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileSystemBlobPort", () => {
  it("stores immutable bytes by their SHA-256 content address", async () => {
    const blobs = await store();
    const bytes = new TextEncoder().encode("report");

    const first = await blobs.put(bytes, "text/plain");
    const duplicate = await blobs.put(bytes, "text/plain");

    expect(duplicate).toEqual(first);
    await expect(collectBlobBytes(await blobs.get(first))).resolves.toEqual(bytes);
  });

  it("hashes a streamed body to the same address as the whole payload", async () => {
    const blobs = await store();
    async function* chunked(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode("re");
      yield new TextEncoder().encode("port");
    }

    const streamed = await blobs.put(chunked());

    expect(streamed).toEqual(await blobs.put(new TextEncoder().encode("report")));
    await expect(collectBlobBytes(await blobs.get(streamed))).resolves.toEqual(
      new TextEncoder().encode("report")
    );
  });

  it("leaves no temporary file behind after a write", async () => {
    const root = await mkdtemp(join(tmpdir(), "tulip-blob-"));
    roots.push(root);
    const blobs = new FileSystemBlobPort(root);

    await blobs.put(new TextEncoder().encode("report"));

    const { readdir } = await import("node:fs/promises");
    expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("reports size without reading the body, and null for an absent blob", async () => {
    const blobs = await store();
    const ref = await blobs.put(new TextEncoder().encode("report"));

    expect(await blobs.head(ref)).toEqual({ size: 6 });
    await blobs.delete(ref);
    expect(await blobs.head(ref)).toBeNull();
  });

  it("serves an inclusive byte range", async () => {
    const blobs = await store();
    const ref = await blobs.put(new TextEncoder().encode("report"));

    const middle = await collectBlobBytes(await blobs.get(ref, { start: 2, end: 4 }));
    const tail = await collectBlobBytes(await blobs.get(ref, { start: 3 }));

    expect(new TextDecoder().decode(middle)).toBe("por");
    expect(new TextDecoder().decode(tail)).toBe("ort");
  });

  it("rejects a nonsensical range before opening a stream", async () => {
    const blobs = await store();
    const ref = await blobs.put(new TextEncoder().encode("report"));

    await expect(blobs.get(ref, { start: -1 })).rejects.toMatchObject({
      code: "blob_invalid_range",
    });
    await expect(blobs.get(ref, { start: 4, end: 2 })).rejects.toMatchObject({
      code: "blob_invalid_range",
    });
  });

  it("rejects a read of an absent blob before any byte is yielded", async () => {
    const blobs = await store();
    const ref = await blobs.put(new TextEncoder().encode("report"));
    await blobs.delete(ref);

    await expect(blobs.get(ref)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects bytes changed underneath a content address", async () => {
    const root = await mkdtemp(join(tmpdir(), "tulip-blob-"));
    roots.push(root);
    const blobs = new FileSystemBlobPort(root);
    const ref = await blobs.put(new TextEncoder().encode("original"));
    const path = join(root, ref.hash.slice(0, 2), ref.hash);
    expect(await readFile(path, "utf8")).toBe("original");
    await writeFile(path, "tampered", "utf8");

    await expect(collectBlobBytes(await blobs.get(ref))).rejects.toMatchObject({
      code: "blob_tampered",
    });
  });

  it("refuses to adopt an existing object whose bytes no longer match its address", async () => {
    const root = await mkdtemp(join(tmpdir(), "tulip-blob-"));
    roots.push(root);
    const blobs = new FileSystemBlobPort(root);
    const bytes = new TextEncoder().encode("original");
    const ref = await blobs.put(bytes);
    await writeFile(join(root, ref.hash.slice(0, 2), ref.hash), "tampered", "utf8");

    await expect(blobs.put(bytes)).rejects.toMatchObject({ code: "blob_tampered" });
  });
});
