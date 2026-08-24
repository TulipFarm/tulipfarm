import { createHash, randomUUID } from "node:crypto";
import type { AzureBlobApi } from "./azure-blob-api";
import type { BlobBody, BlobMetadata, BlobPort, BlobRange, BlobRef } from "./blob";

const HASH = /^[0-9a-f]{64}$/;

/**
 * How much this driver buffers before staging a block, and so its memory ceiling per upload: an
 * object of any size costs one block in RAM, because a block is staged as soon as it fills. Azure
 * imposes no minimum block size, so the value is ours to pick; it only has to be small enough that
 * a large upload is staged in pieces rather than held whole.
 */
export const AZURE_BLOCK_BYTES = 4 * 1024 * 1024;

export type AzureBlobErrorCode = "blob_invalid_ref" | "blob_invalid_range" | "blob_tampered";

export class AzureBlobError extends Error {
  constructor(readonly code: AzureBlobErrorCode) {
    super(code);
    this.name = "AzureBlobError";
  }
}

export interface AzureBlobOptions {
  /**
   * Prepended to every key. Lets one container hold more than this store without the two
   * colliding, which is the normal shape of a managed deployment.
   */
  readonly prefix?: string;
  readonly newStagingId?: () => string;
}

/**
 * Content-addressed blob storage on Azure Blob Storage.
 *
 * Behaviourally identical to `FileSystemBlobPort` and `S3BlobPort`, including that a whole-object
 * read verifies its hash on the way past and a ranged read cannot. Like S3, the content address is
 * unknown until the last byte, and Azure cannot rename a blob, so a streamed upload is staged as
 * block-blob blocks under a staging key, committed there, and server-side copied to its content
 * address. An upload small enough to fit one block skips staging entirely — by then the bytes and
 * the hash are both in hand, so it is written straight to its final key.
 */
export class AzureBlobPort implements BlobPort {
  private readonly prefix: string;
  private readonly newStagingId: () => string;

  constructor(
    private readonly azure: AzureBlobApi,
    options: AzureBlobOptions = {}
  ) {
    this.prefix = options.prefix ?? "";
    this.newStagingId = options.newStagingId ?? randomUUID;
  }

  private key(hash: string): string {
    if (!HASH.test(hash)) throw new AzureBlobError("blob_invalid_ref");
    return `${this.prefix}${hash.slice(0, 2)}/${hash}`;
  }

  private resolve(ref: BlobRef): string {
    if (ref.key !== ref.hash) throw new AzureBlobError("blob_invalid_ref");
    return this.key(ref.hash);
  }

  async put(body: BlobBody, contentType?: string): Promise<BlobRef> {
    const hasher = createHash("sha256");
    const buffered: Uint8Array[] = [];
    let bufferedBytes = 0;
    let staging: { key: string; blockIds: string[] } | undefined;

    for await (const chunk of chunksOf(body)) {
      hasher.update(chunk);
      buffered.push(chunk);
      bufferedBytes += chunk.byteLength;
      if (bufferedBytes < AZURE_BLOCK_BYTES) continue;

      // Past one block, so this upload can no longer be a single request. Stage whole blocks under
      // a staging key and keep flushing, which is what bounds memory at `AZURE_BLOCK_BYTES`.
      if (staging === undefined) {
        staging = { key: `${this.prefix}staging/${this.newStagingId()}`, blockIds: [] };
      }
      await this.stage(staging, concat(buffered, bufferedBytes));
      buffered.length = 0;
      bufferedBytes = 0;
    }

    const hash = hasher.digest("hex");
    const target = this.key(hash);

    if (staging === undefined) {
      await this.azure.put({
        key: target,
        body: concat(buffered, bufferedBytes),
        ...(contentType === undefined ? {} : { contentType }),
      });
      return { key: hash, hash };
    }

    if (bufferedBytes > 0) await this.stage(staging, concat(buffered, bufferedBytes));
    await this.azure.commitBlockList(staging.key, staging.blockIds, contentType);
    // A body that fails before the commit leaves only uncommitted blocks, which Azure garbage
    // collects on its own — there is nothing to abort, unlike an S3 multipart. Only a committed
    // staging blob has to be cleaned up, and only once the copy to its content address is done.
    try {
      await this.azure.copy(staging.key, target);
    } finally {
      await this.azure.delete(staging.key).catch(() => undefined);
    }
    return { key: hash, hash };
  }

  private async stage(
    staging: { key: string; blockIds: string[] },
    block: Uint8Array
  ): Promise<void> {
    const id = blockId(staging.blockIds.length);
    await this.azure.stageBlock(staging.key, id, block);
    staging.blockIds.push(id);
  }

  async get(ref: BlobRef, range?: BlobRange): Promise<AsyncIterable<Uint8Array>> {
    const key = this.resolve(ref);
    assertValidRange(range);
    // Opening before returning means an absent object rejects the call, rather than failing
    // partway through a stream the caller has already started consuming.
    const body = await this.azure.get({ key, ...(range === undefined ? {} : { range }) });
    return verified(body, range === undefined ? ref.hash : undefined);
  }

  async head(ref: BlobRef): Promise<BlobMetadata | null> {
    const head = await this.azure.head(this.resolve(ref));
    if (head === null) return null;
    return {
      size: head.size,
      ...(head.contentType === undefined ? {} : { contentType: head.contentType }),
    };
  }

  async delete(ref: BlobRef): Promise<void> {
    await this.azure.delete(this.resolve(ref));
  }
}

/** Block IDs a blob commits must all be one length and base64; a zero-padded counter is both. */
function blockId(index: number): string {
  return Buffer.from(index.toString().padStart(12, "0")).toString("base64");
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
    throw new AzureBlobError("blob_tampered");
  }
}

function assertValidRange(range: BlobRange | undefined): void {
  if (range === undefined) return;
  const startValid = Number.isInteger(range.start) && range.start >= 0;
  const endValid =
    range.end === undefined || (Number.isInteger(range.end) && range.end >= range.start);
  if (!startValid || !endValid) throw new AzureBlobError("blob_invalid_range");
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
