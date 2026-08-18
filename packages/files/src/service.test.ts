import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemBlobPort } from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "./limits";
import type { FileRecord, FileRepo, NewFile } from "./repo";
import { FileError, FileService } from "./service";

const BUSINESS = "biz";
const OWNER = "principal-a";
const STRANGER = "principal-b";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** An in-memory repo, so these tests are about the pipeline rather than about SQL. */
class MemoryFileRepo implements FileRepo {
  readonly rows: FileRecord[] = [];

  async create(file: NewFile): Promise<FileRecord> {
    const record: FileRecord = { ...file, createdAt: new Date() };
    this.rows.push(record);
    return record;
  }

  async get(businessId: string, id: string): Promise<FileRecord | null> {
    return this.rows.find((r) => r.businessId === businessId && r.id === id) ?? null;
  }

  async listByOwner(businessId: string, owner: string, limit: number): Promise<FileRecord[]> {
    return this.rows
      .filter((r) => r.businessId === businessId && r.ownerPrincipalId === owner)
      .slice(0, limit);
  }

  async delete(businessId: string, id: string): Promise<boolean> {
    const index = this.rows.findIndex((r) => r.businessId === businessId && r.id === id);
    if (index === -1) return false;
    this.rows.splice(index, 1);
    return true;
  }

  async anyReferencesBlob(hash: string): Promise<boolean> {
    return this.rows.some((r) => r.blob.hash === hash);
  }
}

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

describe("FileService.upload", () => {
  let root: string;
  let blobs: FileSystemBlobPort;
  let repo: MemoryFileRepo;
  let service: FileService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tulip-files-"));
    blobs = new FileSystemBlobPort(root);
    repo = new MemoryFileRepo();
    service = new FileService({ repo, blobs, newId: () => randomUUID() });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function upload(overrides: Partial<Parameters<FileService["upload"]>[0]> = {}) {
    return service.upload({
      businessId: BUSINESS,
      ownerPrincipalId: OWNER,
      filename: "shot.png",
      claimedMediaType: "image/png",
      declaredBytes: PNG.byteLength,
      body: once(PNG),
      ...overrides,
    });
  }

  it("stores the sniffed type, the claimed type, and the real size", async () => {
    const file = await upload({ claimedMediaType: "image/jpeg" });
    expect(file.mediaType).toBe("image/png");
    expect(file.claimedMediaType).toBe("image/jpeg");
    expect(file.sizeBytes).toBe(PNG.byteLength);
  });

  it("owns the File by the uploading Principal", async () => {
    const file = await upload();
    expect(file.ownerPrincipalId).toBe(OWNER);
  });

  // The order is the point: a declared length over the cap must cost a header, not a write.
  it("refuses an oversized upload before anything reaches storage", async () => {
    let consumed = false;
    const body = (async function* () {
      consumed = true;
      yield PNG;
    })();

    await expect(upload({ declaredBytes: MAX_FILE_BYTES + 1, body })).rejects.toThrow(FileError);
    expect(consumed).toBe(false);
    expect(repo.rows).toHaveLength(0);
  });

  // A client can declare any length it likes, so the stream itself has to enforce the cap.
  it("refuses a body that exceeds the cap despite an honest-looking declared length", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    chunk.set(PNG, 0);
    const body = (async function* () {
      for (let i = 0; i <= MAX_FILE_BYTES / chunk.byteLength; i += 1) yield chunk;
    })();

    await expect(upload({ declaredBytes: 10, body })).rejects.toMatchObject({
      reason: "too_large",
    });
    expect(repo.rows).toHaveLength(0);
  });

  it("refuses a file whose real type contradicts its claim", async () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    await expect(
      upload({ claimedMediaType: "image/png", body: once(html), filename: "x.png" })
    ).rejects.toMatchObject({ reason: "disallowed_type" });
    expect(repo.rows).toHaveLength(0);
  });

  it("refuses SVG", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    await expect(
      upload({ claimedMediaType: "image/svg+xml", body: once(svg), filename: "x.svg" })
    ).rejects.toMatchObject({ reason: "disallowed_type" });
  });

  it("refuses an empty body rather than storing a zero-byte File", async () => {
    const body = (async function* (): AsyncIterable<Uint8Array> {})();
    await expect(upload({ body, declaredBytes: 0 })).rejects.toMatchObject({ reason: "empty" });
    expect(repo.rows).toHaveLength(0);
  });

  it("normalises a traversal-shaped filename and never lets it reach the storage key", async () => {
    const file = await upload({ filename: "../../etc/shadow.png" });
    expect(file.filename).toBe("shadow.png");
    expect(file.blob.key).toBe(file.blob.hash);
    expect(file.blob.key).not.toContain("/");
    expect(file.blob.key).not.toContain("shadow");
  });

  // Content-addressed storage means one refused upload must not take an accepted File's bytes.
  it("keeps the bytes of an accepted File when a byte-identical upload is refused", async () => {
    const text = new TextEncoder().encode("hello, world");
    const accepted = await upload({
      claimedMediaType: "text/plain",
      filename: "note.txt",
      body: once(text),
      declaredBytes: text.byteLength,
    });

    await expect(
      upload({
        claimedMediaType: "text/html",
        filename: "note.html",
        body: once(text),
        declaredBytes: text.byteLength,
      })
    ).rejects.toMatchObject({ reason: "disallowed_type" });

    expect(await blobs.head(accepted.blob)).not.toBeNull();
  });

  it("removes the bytes of a refused upload nothing else references", async () => {
    const html = new TextEncoder().encode("<html>not a png at all</html>");
    const hash = createHash("sha256").update(html).digest("hex");

    await expect(upload({ claimedMediaType: "image/png", body: once(html) })).rejects.toMatchObject(
      { reason: "disallowed_type" }
    );

    expect(await blobs.head({ key: hash, hash })).toBeNull();
    expect(repo.rows).toHaveLength(0);
  });
});

describe("FileService.read", () => {
  let root: string;
  let service: FileService;
  let repo: MemoryFileRepo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tulip-files-"));
    repo = new MemoryFileRepo();
    service = new FileService({
      repo,
      blobs: new FileSystemBlobPort(root),
      newId: () => randomUUID(),
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seed(): Promise<FileRecord> {
    return await service.upload({
      businessId: BUSINESS,
      ownerPrincipalId: OWNER,
      filename: "shot.png",
      claimedMediaType: "image/png",
      declaredBytes: PNG.byteLength,
      body: once(PNG),
    });
  }

  it("returns the File to its owner", async () => {
    const file = await seed();
    expect((await service.read(BUSINESS, file.id, OWNER)).id).toBe(file.id);
  });

  it("refuses a second Principal, since a File is private by default", async () => {
    const file = await seed();
    await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toBeInstanceOf(FileError);
  });

  // Distinguishing "not yours" from "does not exist" turns the route into an existence oracle.
  it("tells a stranger the same thing it tells someone guessing an id", async () => {
    const file = await seed();
    const denied = await service.read(BUSINESS, file.id, STRANGER).catch((e: FileError) => e);
    const missing = await service.read(BUSINESS, randomUUID(), STRANGER).catch((e: FileError) => e);
    expect((denied as FileError).reason).toBe((missing as FileError).reason);
  });

  it("does not leak a File across businesses", async () => {
    const file = await seed();
    await expect(service.read("other-biz", file.id, OWNER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("streams back the stored bytes", async () => {
    const file = await seed();
    const { body } = await service.content(BUSINESS, file.id, OWNER);
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(Buffer.from(PNG))).toBe(true);
  });
});
