import { createHash, randomUUID } from "node:crypto";
import type { BlobBody, BlobMetadata, BlobPort, BlobRange, BlobRef } from "./blob";
import type { S3Api, S3UploadedPart } from "./s3-api";

const HASH = /^[0-9a-f]{64}$/;

/**
 * S3's own floor for every part but the last. Also this driver's memory ceiling per upload: an
 * object of any size costs one part in RAM, because a part is written out as soon as it fills.
 */
export const S3_PART_BYTES = 5 * 1024 * 1024;

export type S3BlobErrorCode = "blob_invalid_ref" | "blob_invalid_range" | "blob_tampered";

export class S3BlobError extends Error {
  constructor(readonly code: S3BlobErrorCode) {
    super(code);
    this.name = "S3BlobError";
  }
}

export interface S3BlobOptions {
  /**
   * Prepended to every key. Lets one bucket hold more than this store without the two colliding,
   * which is the normal shape of a managed deployment.
   */
  readonly prefix?: string;
  readonly newStagingId?: () => string;
}

/**
 * Content-addressed blob storage on any S3-compatible provider.
 *
 * Behaviourally identical to `FileSystemBlobPort`, including that a whole-object read verifies its
 * hash on the way past and a ranged read cannot. The one structural difference is staging: a
 * filesystem can write to a temporary path and link it into place once the hash is known, and S3
 * cannot rename, so a streamed upload lands under a staging key and is server-side copied to its
 * content address. An upload small enough to fit one part skips staging entirely — by then the
 * bytes and the hash are both in hand, so it is written straight to its final key.
 */
export class S3BlobPort implements BlobPort {
  private readonly prefix: string;
  private readonly newStagingId: () => string;

  constructor(
    private readonly s3: S3Api,
    options: S3BlobOptions = {}
  ) {
    this.prefix = options.prefix ?? "";
    this.newStagingId = options.newStagingId ?? randomUUID;
  }

  private key(hash: string): string {
    if (!HASH.test(hash)) throw new S3BlobError("blob_invalid_ref");
    return `${this.prefix}${hash.slice(0, 2)}/${hash}`;
  }

  private resolve(ref: BlobRef): string {
    if (ref.key !== ref.hash) throw new S3BlobError("blob_invalid_ref");
    return this.key(ref.hash);
  }

  async put(body: BlobBody, contentType?: string): Promise<BlobRef> {
    const hasher = createHash("sha256");
    const buffered: Uint8Array[] = [];
    let bufferedBytes = 0;
    let staging: { key: string; uploadId: string } | undefined;
    const parts: S3UploadedPart[] = [];

    try {
      for await (const chunk of chunksOf(body)) {
        hasher.update(chunk);
        buffered.push(chunk);
        bufferedBytes += chunk.byteLength;
        if (bufferedBytes < S3_PART_BYTES) continue;

        // Past one part, so this upload can no longer be a single request. Open the multipart
        // once and keep flushing whole parts, which is what bounds memory at `S3_PART_BYTES`.
        if (staging === undefined) {
          const key = `${this.prefix}staging/${this.newStagingId()}`;
          staging = { key, uploadId: await this.s3.createMultipartUpload(key, contentType) };
        }
        const part = concat(buffered, bufferedBytes);
        buffered.length = 0;
        bufferedBytes = 0;
        parts.push(await this.s3.uploadPart(staging.key, staging.uploadId, parts.length + 1, part));
      }

      const hash = hasher.digest("hex");
      const target = this.key(hash);

      if (staging === undefined) {
        await this.s3.put({
          key: target,
          body: concat(buffered, bufferedBytes),
          ...(contentType === undefined ? {} : { contentType }),
        });
        return { key: hash, hash };
      }

      // A trailing remainder is the last part, which S3 exempts from the size floor. A stream
      // that ended exactly on a boundary leaves none, and a multipart with zero parts is invalid,
      // so an empty remainder is only skipped when something was already written.
      if (bufferedBytes > 0 || parts.length === 0) {
        const part = concat(buffered, bufferedBytes);
        parts.push(await this.s3.uploadPart(staging.key, staging.uploadId, parts.length + 1, part));
      }
      await this.s3.completeMultipartUpload(staging.key, staging.uploadId, parts);
      const settled = staging;
      staging = undefined;
      try {
        await this.s3.copy(settled.key, target);
      } finally {
        await this.s3.delete(settled.key).catch(() => undefined);
      }
      return { key: hash, hash };
    } catch (error) {
      // An abandoned multipart keeps billing for its parts until a lifecycle rule reaps it, and a
      // provider may have none configured, so the failing call owns the cleanup.
      if (staging !== undefined) {
        await this.s3.abortMultipartUpload(staging.key, staging.uploadId).catch(() => undefined);
      }
      throw error;
    }
  }

  async get(ref: BlobRef, range?: BlobRange): Promise<AsyncIterable<Uint8Array>> {
    const key = this.resolve(ref);
    assertValidRange(range);
    // Opening before returning means an absent object rejects the call, rather than failing
    // partway through a stream the caller has already started consuming.
    const body = await this.s3.get({ key, ...(range === undefined ? {} : { range }) });
    return verified(body, range === undefined ? ref.hash : undefined);
  }

  async head(ref: BlobRef): Promise<BlobMetadata | null> {
    const head = await this.s3.head(this.resolve(ref));
    if (head === null) return null;
    return {
      size: head.size,
      ...(head.contentType === undefined ? {} : { contentType: head.contentType }),
    };
  }

  async delete(ref: BlobRef): Promise<void> {
    await this.s3.delete(this.resolve(ref));
  }
}

async function* verified(
  body: AsyncIterable<Uint8Array>,
  verifyAgainst: string | undefined
): AsyncIterable<Uint8Array> {
  const hasher = verifyAgainst === undefined ? undefined : createHash("sha256");
  for await (const chunk of body) {
    hasher?.update(chunk);
    yield chunk;
  }
  if (hasher !== undefined && hasher.digest("hex") !== verifyAgainst) {
    throw new S3BlobError("blob_tampered");
  }
}

function assertValidRange(range: BlobRange | undefined): void {
  if (range === undefined) return;
  const startValid = Number.isInteger(range.start) && range.start >= 0;
  const endValid =
    range.end === undefined || (Number.isInteger(range.end) && range.end >= range.start);
  if (!startValid || !endValid) throw new S3BlobError("blob_invalid_range");
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1 && chunks[0].byteLength === total) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function* chunksOf(body: BlobBody): AsyncIterable<Uint8Array> {
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }
  yield* body;
}
