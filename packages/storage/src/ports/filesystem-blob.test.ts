import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemBlobPort } from "./filesystem-blob";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileSystemBlobPort", () => {
  it("stores immutable bytes by their SHA-256 content address", async () => {
    const root = await mkdtemp(join(tmpdir(), "tulip-blob-"));
    roots.push(root);
    const store = new FileSystemBlobPort(root);
    const bytes = new TextEncoder().encode("report");

    const first = await store.put(bytes, "text/plain");
    const duplicate = await store.put(bytes, "text/plain");

    expect(duplicate).toEqual(first);
    await expect(store.get(first)).resolves.toEqual(bytes);
  });

  it("detects bytes changed underneath a content address", async () => {
    const root = await mkdtemp(join(tmpdir(), "tulip-blob-"));
    roots.push(root);
    const store = new FileSystemBlobPort(root);
    const ref = await store.put(new TextEncoder().encode("original"));
    const path = join(root, ref.hash.slice(0, 2), ref.hash);
    expect(await readFile(path, "utf8")).toBe("original");
    await writeFile(path, "tampered", "utf8");

    await expect(store.get(ref)).rejects.toMatchObject({ code: "blob_tampered" });
  });
});
