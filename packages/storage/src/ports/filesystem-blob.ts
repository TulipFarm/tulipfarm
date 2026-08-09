import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BlobPort, BlobRef } from "./blob";

const HASH = /^[0-9a-f]{64}$/;

export type FileSystemBlobErrorCode = "blob_invalid_ref" | "blob_tampered";

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

  async put(bytes: Uint8Array, _contentType?: string): Promise<BlobRef> {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const directory = join(this.root, hash.slice(0, 2));
    const target = this.path(hash);
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `.${hash}.${randomUUID()}.tmp`);
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    try {
      try {
        await link(temporary, target);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    const stored = await readFile(target);
    if (createHash("sha256").update(stored).digest("hex") !== hash) {
      throw new FileSystemBlobError("blob_tampered");
    }
    return { key: hash, hash };
  }

  async get(ref: BlobRef): Promise<Uint8Array> {
    if (ref.key !== ref.hash) throw new FileSystemBlobError("blob_invalid_ref");
    const bytes = await readFile(this.path(ref.hash));
    if (createHash("sha256").update(bytes).digest("hex") !== ref.hash) {
      throw new FileSystemBlobError("blob_tampered");
    }
    return new Uint8Array(bytes);
  }

  async delete(ref: BlobRef): Promise<void> {
    if (ref.key !== ref.hash) throw new FileSystemBlobError("blob_invalid_ref");
    await unlink(this.path(ref.hash));
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
