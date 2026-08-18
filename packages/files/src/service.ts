/**
 * The ordered upload pipeline, and the read that pairs with it.
 *
 * The order is the design, not an implementation detail:
 *
 *   authorize → reject on declared length → stream to storage → sniff the real type →
 *   reject if disallowed → write the row
 *
 * Checking the declared length *before* the stream opens is the difference between a rejected
 * upload costing a header and costing a full storage write plus a compensating delete. Sniffing
 * after the write is unavoidable — the bytes are the evidence, and buffering the whole object to
 * sniff first would defeat streaming — so the write is compensated when the sniff refuses. The
 * row lands last, which is what makes "a File row implies its bytes are present" true.
 */

import type { BlobPort, BlobRef } from "@tulipfarm/storage";
import { normalizeFilename } from "./filename";
import { isAllowedMediaType, MAX_FILE_BYTES } from "./limits";
import type { FileRecord, FileRepo } from "./repo";
import { resolveMediaType, SNIFF_BYTES } from "./sniff";

export type UploadRejection =
  | "too_large"
  | "empty"
  | "disallowed_type"
  | "not_authorized"
  | "not_found";

export class FileError extends Error {
  constructor(
    readonly reason: UploadRejection,
    message: string
  ) {
    super(message);
    this.name = "FileError";
  }
}

export interface UploadRequest {
  readonly businessId: string;
  readonly ownerPrincipalId: string;
  readonly filename: string;
  readonly claimedMediaType: string;
  /** What the client says the body weighs. Refused here before any byte is written. */
  readonly declaredBytes: number;
  readonly body: AsyncIterable<Uint8Array>;
}

export interface FileServiceDeps {
  readonly repo: FileRepo;
  readonly blobs: BlobPort;
  readonly newId: () => string;
}

/**
 * Reads the first {@link SNIFF_BYTES} while passing every chunk through unchanged.
 *
 * The sniff sample has to be taken from the same pass that writes, because the body is a stream
 * that can only be consumed once. Enforcing the byte ceiling here too is what makes the limit
 * real: a client can declare any length it likes, so the declared check is a courtesy and this
 * one is the control.
 */
function tee(
  body: AsyncIterable<Uint8Array>,
  sample: { bytes: Uint8Array; size: number }
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const head: Uint8Array[] = [];
      let headLength = 0;
      for await (const chunk of body) {
        sample.size += chunk.byteLength;
        if (sample.size > MAX_FILE_BYTES) {
          throw new FileError("too_large", `upload exceeds ${MAX_FILE_BYTES} bytes`);
        }
        if (headLength < SNIFF_BYTES) {
          head.push(chunk);
          headLength += chunk.byteLength;
          sample.bytes = concat(head, Math.min(headLength, SNIFF_BYTES));
        }
        yield chunk;
      }
    },
  };
}

function concat(chunks: readonly Uint8Array[], limit: number): Uint8Array {
  const out = new Uint8Array(limit);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= limit) break;
    const slice = chunk.subarray(0, limit - offset);
    out.set(slice, offset);
    offset += slice.byteLength;
  }
  return out;
}

export class FileService {
  constructor(private readonly deps: FileServiceDeps) {}

  async upload(request: UploadRequest): Promise<FileRecord> {
    if (request.declaredBytes > MAX_FILE_BYTES) {
      throw new FileError("too_large", `upload exceeds ${MAX_FILE_BYTES} bytes`);
    }

    const sample = { bytes: new Uint8Array(0), size: 0 };
    // A mid-stream refusal from `tee` propagates out of `put`, which leaves nothing behind: the
    // store only publishes an object once the whole body has been written.
    const ref = await this.deps.blobs.put(tee(request.body, sample), request.claimedMediaType);

    if (sample.size === 0) {
      await this.discard(ref);
      throw new FileError("empty", "upload carried no bytes");
    }

    const mediaType = resolveMediaType(sample.bytes, request.claimedMediaType);
    if (mediaType === null || !isAllowedMediaType(mediaType)) {
      await this.discard(ref);
      throw new FileError(
        "disallowed_type",
        `${request.claimedMediaType} is not a type this instance accepts`
      );
    }

    return await this.deps.repo.create({
      id: this.deps.newId(),
      businessId: request.businessId,
      ownerPrincipalId: request.ownerPrincipalId,
      filename: normalizeFilename(request.filename),
      mediaType,
      claimedMediaType: request.claimedMediaType,
      sizeBytes: sample.size,
      blob: ref,
    });
  }

  /**
   * Reads a File's metadata, refusing a Principal that does not own it.
   *
   * Ownership is the whole ACL in this slice — sharing arrives at slice 07 — and this is checked
   * freshly on every request rather than cached, so that when sharing does arrive a revocation
   * takes effect on the next read with nothing to invalidate.
   */
  async read(businessId: string, id: string, principalId: string): Promise<FileRecord> {
    const file = await this.deps.repo.get(businessId, id);
    if (file === null) throw new FileError("not_found", `file ${id} does not exist`);
    if (file.ownerPrincipalId !== principalId) {
      // Deliberately the same shape as a missing File: telling a stranger that an id exists but
      // is not theirs turns the route into an existence oracle.
      throw new FileError("not_found", `file ${id} does not exist`);
    }
    return file;
  }

  async content(
    businessId: string,
    id: string,
    principalId: string
  ): Promise<{ file: FileRecord; body: AsyncIterable<Uint8Array> }> {
    const file = await this.read(businessId, id, principalId);
    const body = await this.deps.blobs.get(file.blob);
    return { file, body };
  }

  async list(businessId: string, principalId: string, limit: number): Promise<FileRecord[]> {
    return await this.deps.repo.listByOwner(businessId, principalId, limit);
  }

  /**
   * Removes bytes written for an upload that was then refused.
   *
   * A failure here is swallowed: the caller is already returning a rejection, and a leaked object
   * with no row pointing at it is strictly less harmful than replacing a clear "your file was
   * refused" with a storage error the client cannot act on.
   */
  private async discard(ref: BlobRef): Promise<void> {
    try {
      // Identical bytes share one object, so refusing this upload must not delete the bytes of an
      // accepted File that happens to match it.
      if (await this.deps.repo.anyReferencesBlob(ref.hash)) return;

      await this.deps.blobs.delete(ref);
    } catch {
      // Intentionally ignored; see above.
    }
  }
}
