import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { link, mkdir, open, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { BlobBody, BlobMetadata, BlobPort, BlobRange, BlobRef } from "./blob";

const HASH = /^[0-9a-f]{64}$/;

export type FileSystemBlobErrorCode = "blob_invalid_ref" | "blob_invalid_range" | "blob_tampered";

export class FileSystemBlobError extends Error {
  constructor(readonly code: FileSystemBlobErrorCode) {
    super(code);
    this.name = "FileSystemBlobError";
  }
}

/** Development/local content-addressed blob provider. Managed deployments can bind the same port. */
export class FileSystemBlobPort implements BlobPort {
  constructor(private readonly root: string) {
    if (root.length === 0) throw new FileSystemBlobError("blob_invalid_ref");
  }

  private path(hash: string): string {
    if (!HASH.test(hash)) throw new FileSystemBlobError("blob_invalid_ref");
    return join(this.root, hash.slice(0, 2), hash);
  }

  private resolve(ref: BlobRef): string {
    if (ref.key !== ref.hash) throw new FileSystemBlobError("blob_invalid_ref");
    return this.path(ref.hash);
  }

  async put(body: BlobBody, _contentType?: string): Promise<BlobRef> {
    await mkdir(this.root, { recursive: true });
    const temporary = join(this.root, `.${randomUUID()}.tmp`);
    try {
      const hash = await writeHashed(temporary, body);
      const target = this.path(hash);
      await mkdir(join(this.root, hash.slice(0, 2)), { recursive: true });
      try {
        await link(temporary, target);
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        // Only this path adopts bytes the call did not write. Bytes streamed in above were
        // hashed as they went, so re-reading those would double the I/O to prove nothing.
        await verifyHash(target, hash);
      }
      return { key: hash, hash };
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async get(ref: BlobRef, range?: BlobRange): Promise<AsyncIterable<Uint8Array>> {
    const path = this.resolve(ref);
    assertValidRange(range);
    // Opening before returning means an absent object rejects the call, rather than failing
    // partway through a stream the caller has already started consuming.
    const handle = await open(path, "r");
    return readChunks(handle, range, range === undefined ? ref.hash : undefined);
  }

  async head(ref: BlobRef): Promise<BlobMetadata | null> {
    try {
      const stats = await stat(this.resolve(ref));
      return { size: stats.size };
    } catch (error) {
      if (isCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  async delete(ref: BlobRef): Promise<void> {
    try {
      await unlink(this.resolve(ref));
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }
}

/** Streams `body` to `path`, returning the sha256 it computed on the way past. */
async function writeHashed(path: string, body: BlobBody): Promise<string> {
  const hasher = createHash("sha256");
  const handle = await open(path, "wx", 0o600);
  try {
    for await (const chunk of chunksOf(body)) {
      hasher.update(chunk);
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
  return hasher.digest("hex");
}

async function verifyHash(path: string, hash: string): Promise<void> {
  const handle = await open(path, "r");
  const hasher = createHash("sha256");
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hasher.update(chunk);
    }
  } finally {
    await handle.close();
  }
  if (hasher.digest("hex") !== hash) throw new FileSystemBlobError("blob_tampered");
}

function assertValidRange(range: BlobRange | undefined): void {
  if (range === undefined) return;
  const startValid = Number.isInteger(range.start) && range.start >= 0;
  const endValid =
    range.end === undefined || (Number.isInteger(range.end) && range.end >= range.start);
  if (!startValid || !endValid) throw new FileSystemBlobError("blob_invalid_range");
}

async function* chunksOf(body: BlobBody): AsyncIterable<Uint8Array> {
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }
  yield* body;
}

async function* readChunks(
  handle: FileHandle,
  range: BlobRange | undefined,
  verifyAgainst: string | undefined
): AsyncIterable<Uint8Array> {
  const hasher = verifyAgainst === undefined ? undefined : createHash("sha256");
  try {
    const stream = handle.createReadStream({
      autoClose: false,
      ...(range === undefined ? {} : { start: range.start, end: range.end }),
    });
    for await (const chunk of stream) {
      hasher?.update(chunk);
      yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
  } finally {
    await handle.close();
  }
  if (hasher !== undefined && hasher.digest("hex") !== verifyAgainst) {
    throw new FileSystemBlobError("blob_tampered");
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
