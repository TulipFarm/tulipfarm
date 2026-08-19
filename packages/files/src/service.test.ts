import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemBlobPort } from "@tulipfarm/storage";
import { Jimp } from "jimp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_IMAGE_DIMENSION } from "./bound";
import { imageSize } from "./dimensions";
import { BUSINESS_PRINCIPAL_ID, MAX_FILE_BYTES } from "./limits";
import type { FileGrantee, FileRecord, FileRepo, FileShare, NewFile } from "./repo";
import { FileError, FileService } from "./service";

const BUSINESS = "biz";
const OWNER = "principal-a";
const STRANGER = "principal-b";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** An in-memory repo, so these tests are about the pipeline rather than about SQL. */
class MemoryFileRepo implements FileRepo {
  readonly rows: FileRecord[] = [];

  async create(file: NewFile): Promise<FileRecord> {
    const record: FileRecord = {
      ...file,
      origin: file.origin ?? "uploaded",
      sourceConversationId: null,
      createdAt: new Date(),
    };
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

  readonly shares: FileShare[] = [];

  async share(
    _businessId: string,
    fileId: string,
    grantee: FileGrantee,
    grantedBy: string
  ): Promise<void> {
    if (
      this.shares.some((s) => s.fileId === fileId && s.kind === grantee.kind && s.id === grantee.id)
    ) {
      return;
    }
    this.shares.push({ fileId, ...grantee, grantedBy, createdAt: new Date() });
  }

  async unshare(_businessId: string, fileId: string, grantee: FileGrantee): Promise<boolean> {
    const index = this.shares.findIndex(
      (s) => s.fileId === fileId && s.kind === grantee.kind && s.id === grantee.id
    );
    if (index === -1) return false;
    this.shares.splice(index, 1);
    return true;
  }

  async countShares(_businessId: string, fileIds: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const id of fileIds) {
      const grants = this.shares.filter((share) => share.fileId === id).length;
      if (grants > 0) counts.set(id, grants);
    }
    return counts;
  }

  async listShares(_businessId: string, fileId: string): Promise<FileShare[]> {
    return this.shares.filter((s) => s.fileId === fileId);
  }

  async listSharedWith(
    businessId: string,
    ownerPrincipalId: string,
    grantees: readonly FileGrantee[],
    limit: number
  ): Promise<FileRecord[]> {
    const shared = new Set(
      this.shares
        .filter((s) => grantees.some((g) => g.kind === s.kind && g.id === s.id))
        .map((s) => s.fileId)
    );
    return this.rows
      .filter(
        (r) =>
          r.businessId === businessId && r.ownerPrincipalId !== ownerPrincipalId && shared.has(r.id)
      )
      .slice(0, limit);
  }

  async recordFirstConversation(
    businessId: string,
    fileIds: readonly string[],
    conversationId: string
  ): Promise<void> {
    for (const [index, row] of this.rows.entries()) {
      if (row.businessId !== businessId) continue;
      if (!fileIds.includes(row.id) || row.sourceConversationId !== null) continue;
      this.rows[index] = { ...row, sourceConversationId: conversationId };
    }
  }

  async delete(businessId: string, id: string): Promise<boolean> {
    const index = this.rows.findIndex((r) => r.businessId === businessId && r.id === id);
    if (index === -1) return false;
    this.rows.splice(index, 1);
    // Mirrors `file_shares.file_id ... ON DELETE CASCADE`. A memory repo that kept the shares
    // would be a repo in which revocation-by-deletion appears to work and does not.
    for (let i = this.shares.length - 1; i >= 0; i--) {
      if (this.shares[i]?.fileId === id) this.shares.splice(i, 1);
    }
    return true;
  }

  async readableIds(
    businessId: string,
    principalId: string,
    grantees: readonly FileGrantee[],
    ids: readonly string[]
  ): Promise<readonly string[]> {
    return this.rows
      .filter(
        (r) =>
          r.businessId === businessId &&
          ids.includes(r.id) &&
          (r.ownerPrincipalId === principalId ||
            this.shares.some(
              (s) => s.fileId === r.id && grantees.some((g) => g.kind === s.kind && g.id === s.id)
            ))
      )
      .map((r) => r.id);
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

  // The identical message is only half the defence. If a hidden File costs more queries than a
  // missing one, the difference is measurable and the oracle is back, just in the timing.
  it("does the same work for a File that is hidden as for one that is not there", async () => {
    const file = await seed();
    const counted: string[] = [];
    const repo = service as unknown as {
      deps: { repo: { listShares: (...a: never[]) => unknown }; rolesOf?: unknown };
    };
    const realListShares = repo.deps.repo.listShares.bind(repo.deps.repo);
    repo.deps.repo.listShares = (...args: never[]) => {
      counted.push("listShares");
      return realListShares(...args);
    };
    repo.deps.rolesOf = async () => {
      counted.push("rolesOf");
      return [];
    };

    await service.read(BUSINESS, file.id, STRANGER).catch(() => undefined);
    const hidden = [...counted];
    counted.length = 0;
    await service.read(BUSINESS, randomUUID(), STRANGER).catch(() => undefined);

    expect(counted).toEqual(hidden);
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

describe("FileService.upload — image bounding", () => {
  let root: string;
  let blobs: FileSystemBlobPort;
  let repo: MemoryFileRepo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tulip-bound-"));
    blobs = new FileSystemBlobPort(root);
    repo = new MemoryFileRepo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function realPng(width: number, height: number): Promise<Uint8Array> {
    const image = new Jimp({ width, height, color: 0x336699ff });
    return new Uint8Array(await image.getBuffer("image/png"));
  }

  function serviceWith(policy?: () => { maxImageDimension?: number; downscaleImages?: boolean }) {
    return new FileService({
      repo,
      blobs,
      newId: () => randomUUID(),
      ...(policy === undefined ? {} : { imagePolicy: policy }),
    });
  }

  function put(service: FileService, bytes: Uint8Array) {
    return service.upload({
      businessId: BUSINESS,
      ownerPrincipalId: OWNER,
      filename: "shot.png",
      claimedMediaType: "image/png",
      declaredBytes: bytes.byteLength,
      body: once(bytes),
    });
  }

  it("accepts an image inside the pixel limit", async () => {
    const file = await put(serviceWith(), await realPng(320, 200));

    expect(file.mediaType).toBe("image/png");
  });

  it("refuses an oversized image at upload, when the person is present to be told", async () => {
    const service = serviceWith();

    await expect(put(service, await realPng(2_400, 400))).rejects.toMatchObject({
      reason: "image_too_large",
    });
  });

  it("leaves no row behind for a refused image", async () => {
    await expect(put(serviceWith(), await realPng(2_400, 400))).rejects.toThrow(FileError);

    expect(repo.rows).toHaveLength(0);
  });

  it("names the actual size in the refusal, so the person knows what to change", async () => {
    await expect(put(serviceWith(), await realPng(2_400, 400))).rejects.toThrow(/2400×400/);
  });

  it("downscales instead of refusing when the operator turned it on", async () => {
    const service = serviceWith(() => ({ downscaleImages: true }));

    const file = await put(service, await realPng(2_400, 1_200));

    expect(file.mediaType).toBe("image/png");
    expect(file.sizeBytes).toBeGreaterThan(0);
  });

  it("stores the downscaled bytes, so what is served back is what the model was given", async () => {
    const service = serviceWith(() => ({ downscaleImages: true }));

    const file = await put(service, await realPng(2_400, 1_200));
    const { body } = await service.content(BUSINESS, file.id, OWNER);
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);

    expect(imageSize(new Uint8Array(Buffer.concat(chunks)), "image/png")).toEqual({
      width: DEFAULT_MAX_IMAGE_DIMENSION,
      height: DEFAULT_MAX_IMAGE_DIMENSION / 2,
    });
  });

  it("records the downscaled byte length, not the length that was uploaded", async () => {
    const original = await realPng(2_400, 1_200);
    const service = serviceWith(() => ({ downscaleImages: true }));

    const file = await put(service, original);

    expect(file.sizeBytes).not.toBe(original.byteLength);
  });

  it("honours the business's own pixel limit over the default", async () => {
    const service = serviceWith(() => ({ maxImageDimension: 100 }));

    await expect(put(service, await realPng(320, 200))).rejects.toMatchObject({
      reason: "image_too_large",
    });
  });

  it("does not bound a PDF, whose cost the byte cap already governs", async () => {
    const pdf = new Uint8Array(64);
    pdf.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0);
    const service = serviceWith(() => ({ maxImageDimension: 1 }));

    const file = await service.upload({
      businessId: BUSINESS,
      ownerPrincipalId: OWNER,
      filename: "doc.pdf",
      claimedMediaType: "application/pdf",
      declaredBytes: pdf.byteLength,
      body: once(pdf),
    });

    expect(file.mediaType).toBe("application/pdf");
  });

  it("reads a JPEG's dimensions from behind its metadata, not just its first bytes", async () => {
    const image = new Jimp({ width: 2_000, height: 600, color: 0x336699ff });
    const jpeg = new Uint8Array(await image.getBuffer("image/jpeg"));
    const service = serviceWith();

    await expect(
      service.upload({
        businessId: BUSINESS,
        ownerPrincipalId: OWNER,
        filename: "photo.jpg",
        claimedMediaType: "image/jpeg",
        declaredBytes: jpeg.byteLength,
        body: once(jpeg),
      })
    ).rejects.toMatchObject({ reason: "image_too_large" });
  });
});

describe("sharing a File", () => {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  let root: string;
  let repo: MemoryFileRepo;
  let service: FileService;
  let roles: Map<string, string[]>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tulip-files-share-"));
    repo = new MemoryFileRepo();
    roles = new Map();
    service = new FileService({
      repo,
      blobs: new FileSystemBlobPort(root),
      newId: () => randomUUID(),
      rolesOf: async (_business, principalId) => roles.get(principalId) ?? [],
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function uploaded() {
    return await service.upload({
      businessId: BUSINESS,
      ownerPrincipalId: OWNER,
      filename: "shot.png",
      claimedMediaType: "image/png",
      declaredBytes: PNG_BYTES.byteLength,
      body: (async function* () {
        yield PNG_BYTES;
      })(),
    });
  }

  it("is private to its owner until someone shares it", async () => {
    const file = await uploaded();

    await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("lets a named person read it once shared", async () => {
    const file = await uploaded();

    await service.share(BUSINESS, file.id, OWNER, { kind: "user", id: STRANGER });

    expect((await service.read(BUSINESS, file.id, STRANGER)).id).toBe(file.id);
  });

  it("stops working on the very next read once revoked", async () => {
    const file = await uploaded();
    await service.share(BUSINESS, file.id, OWNER, { kind: "user", id: STRANGER });

    expect(await service.unshare(BUSINESS, file.id, OWNER, { kind: "user", id: STRANGER })).toBe(
      true
    );

    await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("resolves a Role share against the reader's Roles as they are right now", async () => {
    const file = await uploaded();
    await service.share(BUSINESS, file.id, OWNER, { kind: "role", id: "support" });

    // Not yet in the Role.
    await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });

    roles.set(STRANGER, ["support"]);
    expect((await service.read(BUSINESS, file.id, STRANGER)).id).toBe(file.id);

    // Leaving the Role revokes the File, with no share row touched and nothing to invalidate.
    roles.set(STRANGER, []);
    await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("refuses to let a recipient re-share, which is what keeps a revoke final", async () => {
    const file = await uploaded();
    await service.share(BUSINESS, file.id, OWNER, { kind: "user", id: STRANGER });

    await expect(
      service.share(BUSINESS, file.id, STRANGER, { kind: "user", id: "principal-c" })
    ).rejects.toMatchObject({ reason: "not_found" });
    await expect(
      service.unshare(BUSINESS, file.id, STRANGER, { kind: "user", id: STRANGER })
    ).rejects.toMatchObject({ reason: "not_found" });
    await expect(service.shares(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("refuses a stranger who shares nothing with the File, without saying it exists", async () => {
    const file = await uploaded();
    await service.share(BUSINESS, file.id, OWNER, { kind: "user", id: "principal-c" });

    await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("lists what has been shared with the reader, and never what they already own", async () => {
    const mine = await uploaded();
    const theirs = await service.upload({
      businessId: BUSINESS,
      ownerPrincipalId: STRANGER,
      filename: "theirs.png",
      claimedMediaType: "image/png",
      declaredBytes: PNG_BYTES.byteLength,
      body: (async function* () {
        yield PNG_BYTES;
      })(),
    });
    await service.share(BUSINESS, theirs.id, STRANGER, { kind: "user", id: OWNER });

    const page = await service.listSharedWithMe(BUSINESS, OWNER, 10);

    expect(page.files.map((f) => f.id)).toEqual([theirs.id]);
    expect(page.files.map((f) => f.id)).not.toContain(mine.id);
  });

  it("treats sharing twice as one share, so a revoke is not half a revoke", async () => {
    const file = await uploaded();

    await service.share(BUSINESS, file.id, OWNER, { kind: "user", id: STRANGER });
    await service.share(BUSINESS, file.id, OWNER, { kind: "user", id: STRANGER });

    expect(await service.shares(BUSINESS, file.id, OWNER)).toHaveLength(1);
    await service.unshare(BUSINESS, file.id, OWNER, { kind: "user", id: STRANGER });
    await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("refuses to share a File with its own owner rather than storing a no-op row", async () => {
    const file = await uploaded();

    await expect(
      service.share(BUSINESS, file.id, OWNER, { kind: "user", id: OWNER })
    ).rejects.toMatchObject({ reason: "invalid_share" });
  });

  it("never lets a Role named like a person stand in for that person, or the reverse", async () => {
    const file = await uploaded();
    // A Role whose id happens to equal the stranger's principal id. Matching on the id alone would
    // silently hand every Role-holder a File shared with one person, and vice versa.
    await service.share(BUSINESS, file.id, OWNER, { kind: "role", id: STRANGER });

    await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });

    const second = await uploaded();
    await service.share(BUSINESS, second.id, OWNER, { kind: "user", id: "support" });
    roles.set(STRANGER, ["support"]);

    await expect(service.read(BUSINESS, second.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("shares nothing when no Role port is wired, rather than everything", async () => {
    const withoutRoles = new FileService({
      repo,
      blobs: new FileSystemBlobPort(root),
      newId: () => randomUUID(),
    });
    const file = await uploaded();
    await service.share(BUSINESS, file.id, OWNER, { kind: "role", id: "support" });
    roles.set(STRANGER, ["support"]);

    await expect(withoutRoles.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });
});

describe("deleting a File", () => {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  let root: string;
  let blobs: FileSystemBlobPort;
  let repo: MemoryFileRepo;
  let service: FileService;
  let roles: Map<string, string[]>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tulip-files-delete-"));
    blobs = new FileSystemBlobPort(root);
    repo = new MemoryFileRepo();
    roles = new Map();
    service = new FileService({
      repo,
      blobs,
      newId: () => randomUUID(),
      rolesOf: async (_business, principalId) => roles.get(principalId) ?? [],
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function uploaded(owner = OWNER, filename = "shot.png") {
    return await service.upload({
      businessId: BUSINESS,
      ownerPrincipalId: owner,
      filename,
      claimedMediaType: "image/png",
      declaredBytes: PNG_BYTES.byteLength,
      body: (async function* () {
        yield PNG_BYTES;
      })(),
    });
  }

  it("removes the row and the bytes together", async () => {
    const file = await uploaded();
    expect((await blobs.head(file.blob)) !== null).toBe(true);

    await service.delete(BUSINESS, file.id, OWNER);

    expect(await repo.get(BUSINESS, file.id)).toBeNull();
    expect((await blobs.head(file.blob)) !== null).toBe(false);
  });

  it("hands back what was destroyed, so the deletion can be audited", async () => {
    const file = await uploaded(OWNER, "invoice.png");

    const destroyed = await service.delete(BUSINESS, file.id, OWNER);

    expect(destroyed.filename).toBe("invoice.png");
    expect(destroyed.sizeBytes).toBe(PNG_BYTES.byteLength);
    expect(destroyed.blob.hash).toBe(file.blob.hash);
  });

  it("refuses a stranger, and leaves the File intact", async () => {
    const file = await uploaded();

    await expect(service.delete(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
    expect(await repo.get(BUSINESS, file.id)).not.toBeNull();
  });

  it("refuses someone the File was shared with", async () => {
    const file = await uploaded();
    await service.share(BUSINESS, file.id, OWNER, { kind: "user", id: STRANGER });
    expect((await service.read(BUSINESS, file.id, STRANGER)).id).toBe(file.id);

    await expect(service.delete(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
    expect((await blobs.head(file.blob)) !== null).toBe(true);
  });

  it("takes every share with it, so a recipient loses access immediately", async () => {
    const file = await uploaded();
    await service.share(BUSINESS, file.id, OWNER, { kind: "user", id: STRANGER });

    await service.delete(BUSINESS, file.id, OWNER);

    await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
    expect(await repo.listShares(BUSINESS, file.id)).toHaveLength(0);
  });

  it("keeps the bytes of a byte-identical File someone else still owns", async () => {
    const mine = await uploaded(OWNER);
    const theirs = await uploaded(STRANGER);
    expect(theirs.blob.hash).toBe(mine.blob.hash);

    await service.delete(BUSINESS, mine.id, OWNER);

    expect((await blobs.head(theirs.blob)) !== null).toBe(true);
    expect((await service.read(BUSINESS, theirs.id, STRANGER)).id).toBe(theirs.id);
  });

  it("is idempotent enough to refuse a second attempt rather than delete twice", async () => {
    const file = await uploaded();
    await service.delete(BUSINESS, file.id, OWNER);

    await expect(service.delete(BUSINESS, file.id, OWNER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("raises when the bytes cannot be erased, rather than reporting a silent success", async () => {
    const file = await uploaded();
    const failing = new FileService({
      repo,
      blobs: {
        put: (body, type) => blobs.put(body, type),
        get: (ref, range) => blobs.get(ref, range),
        head: (ref) => blobs.head(ref),
        delete: async () => {
          throw new Error("bucket said no");
        },
      },
      newId: () => randomUUID(),
    });

    await expect(failing.delete(BUSINESS, file.id, OWNER)).rejects.toThrow("bucket said no");
  });
});

describe("FileService.presentFor", () => {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  let root: string;
  let repo: MemoryFileRepo;
  let service: FileService;
  let roles: Map<string, string[]>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tulip-files-present-"));
    repo = new MemoryFileRepo();
    roles = new Map();
    service = new FileService({
      repo,
      blobs: new FileSystemBlobPort(root),
      newId: () => randomUUID(),
      rolesOf: async (_business, principalId) => roles.get(principalId) ?? [],
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function uploaded(owner = OWNER) {
    return await service.upload({
      businessId: BUSINESS,
      ownerPrincipalId: owner,
      filename: "shot.png",
      claimedMediaType: "image/png",
      declaredBytes: PNG_BYTES.byteLength,
      body: (async function* () {
        yield PNG_BYTES;
      })(),
    });
  }

  it("reports the caller's own Files as present and a destroyed one as absent", async () => {
    const kept = await uploaded();
    const gone = await uploaded();
    await service.delete(BUSINESS, gone.id, OWNER);

    const present = await service.presentFor(BUSINESS, OWNER, [kept.id, gone.id]);

    expect(present.has(kept.id)).toBe(true);
    expect(present.has(gone.id)).toBe(false);
  });

  it("reports a File that exists but is not shared with the caller as absent", async () => {
    const file = await uploaded();

    expect((await service.presentFor(BUSINESS, STRANGER, [file.id])).has(file.id)).toBe(false);

    await service.share(BUSINESS, file.id, OWNER, { kind: "user", id: STRANGER });

    expect((await service.presentFor(BUSINESS, STRANGER, [file.id])).has(file.id)).toBe(true);
  });

  it("honours a Role share, so a transcript matches what the reader may open", async () => {
    const file = await uploaded();
    roles.set(STRANGER, ["role-support"]);
    await service.share(BUSINESS, file.id, OWNER, { kind: "role", id: "role-support" });

    expect((await service.presentFor(BUSINESS, STRANGER, [file.id])).has(file.id)).toBe(true);

    roles.set(STRANGER, []);

    expect((await service.presentFor(BUSINESS, STRANGER, [file.id])).has(file.id)).toBe(false);
  });

  it("asks nothing at all for an empty list", async () => {
    let asked = 0;
    const counting = new FileService({
      repo: {
        ...repo,
        readableIds: async (
          ...args: Parameters<MemoryFileRepo["readableIds"]>
        ): Promise<readonly string[]> => {
          asked += 1;
          return await repo.readableIds(...args);
        },
      } as unknown as MemoryFileRepo,
      blobs: new FileSystemBlobPort(root),
      newId: () => randomUUID(),
    });

    expect((await counting.presentFor(BUSINESS, OWNER, [])).size).toBe(0);
    expect(asked).toBe(0);
  });
});

describe("FileService.generate", () => {
  let root: string;
  let repo: MemoryFileRepo;
  let service: FileService;

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

  const generate = (overrides: Partial<Parameters<FileService["generate"]>[0]> = {}) =>
    service.generate({
      businessId: BUSINESS,
      filename: "quarterly-summary",
      format: "pdf",
      content: "# Quarterly\n\nRevenue rose.",
      readableBy: { kind: "user", id: OWNER },
      ...overrides,
    });

  it("writes a real document and marks it machine-made", async () => {
    const file = await generate();
    expect(file.origin).toBe("generated");
    expect(file.mediaType).toBe("application/pdf");
    expect(file.filename).toBe("quarterly-summary.pdf");
    expect(file.sizeBytes).toBeGreaterThan(0);
    const stored = await service.content(BUSINESS, file.id, OWNER);
    let total = 0;
    for await (const chunk of stored.body) total += chunk.byteLength;
    expect(total).toBe(file.sizeBytes);
  });

  it("belongs to the business, not to whoever asked for it", async () => {
    // This is what makes a Routine's monthly report survive the offboarding of the person who
    // scheduled it. Owning it as that person would orphan the Run's output with their account.
    const file = await generate();
    expect(file.ownerPrincipalId).toBe(BUSINESS_PRINCIPAL_ID);
    expect(file.ownerPrincipalId).not.toBe(OWNER);
  });

  it("lets the person who asked read it, and nobody else", async () => {
    const file = await generate();
    await expect(service.read(BUSINESS, file.id, OWNER)).resolves.toMatchObject({ id: file.id });
    await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("makes a File nobody can read when nobody is named, rather than one everybody can", async () => {
    const file = await generate({ readableBy: undefined });
    expect(repo.shares.filter((share) => share.fileId === file.id)).toEqual([]);
    await expect(service.read(BUSINESS, file.id, OWNER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("does not double an extension the Agent already got right", async () => {
    const file = await generate({ filename: "report.pdf" });
    expect(file.filename).toBe("report.pdf");
  });

  it("stores the plain formats byte for byte", async () => {
    const file = await generate({ format: "csv", filename: "rows", content: "a,b\n1,2\n" });
    expect(file.mediaType).toBe("text/csv");
    expect(file.filename).toBe("rows.csv");
    const { body } = await service.content(BUSINESS, file.id, OWNER);
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("a,b\n1,2\n");
  });

  it("refuses before writing anything when the render refuses", async () => {
    await expect(generate({ content: "   " })).rejects.toMatchObject({ reason: "empty" });
    // The row is what makes a File exist. Nothing reached storage, so nothing needs compensating.
    expect(repo.rows).toEqual([]);
  });
});
