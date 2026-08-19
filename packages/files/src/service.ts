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
import { boundImage, type ImageBoundPolicy } from "./bound";
import { normalizeFilename } from "./filename";
import { BUSINESS_PRINCIPAL_ID, isAllowedMediaType, MAX_FILE_BYTES } from "./limits";
import { extensionForFormat, type RenderFormat, renderDocument } from "./render";
import {
  encodeFileCursor,
  type FileCursor,
  type FileGrantee,
  type FileRecord,
  type FileRepo,
  type FileShare,
} from "./repo";
import { resolveMediaType, SNIFF_BYTES } from "./sniff";

export type UploadRejection =
  | "too_large"
  | "empty"
  | "disallowed_type"
  | "image_too_large"
  | "not_authorized"
  | "not_found"
  | "invalid_share";

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

export interface GenerateRequest {
  readonly businessId: string;
  readonly filename: string;
  readonly format: RenderFormat;
  /** Markdown for `pdf`, taken verbatim otherwise. Rendered before anything is written. */
  readonly content: string;
  readonly title?: string;
  /**
   * Given read access as the File lands.
   *
   * Passed rather than inferred because the service does not know who asked — and a machine-made
   * File that nobody can read is the same as one that was never made.
   */
  readonly readableBy?: FileGrantee;
}

export interface FileServiceDeps {
  readonly repo: FileRepo;
  readonly blobs: BlobPort;
  readonly newId: () => string;
  /**
   * The business's image-bounding policy, read per upload rather than held.
   *
   * Read fresh so that turning downscaling on in `soul.yaml` takes effect on the next upload
   * without restarting anything. Absent means the default policy.
   */
  readonly imagePolicy?: () => ImageBoundPolicy | Promise<ImageBoundPolicy>;
  /**
   * Which Roles a reader currently holds, asked on every read a share has to justify.
   *
   * A port rather than a dependency because the one correct answer — direct assignments plus
   * group-held Roles, minus anything expired — already exists in the authority resolver, and a
   * second implementation of it here is precisely how a File would stay readable to someone the
   * Role no longer contains. Absent means no Role-based sharing, never "all Roles".
   */
  readonly rolesOf?: (businessId: string, principalId: string) => Promise<readonly string[]>;
}

/**
 * Reads the first {@link SNIFF_BYTES} while passing every chunk through unchanged.
 *
 * The sniff sample has to be taken from the same pass that writes, because the body is a stream
 * that can only be consumed once. Enforcing the byte ceiling here too is what makes the limit
 * real: a client can declare any length it likes, so the declared check is a courtesy and this
 * one is the control.
 */
/**
 * How much of the body is buffered for inspection.
 *
 * A single JPEG APP1 EXIF segment is spec-capped at 64 KiB, and a JPEG states its dimensions in a
 * frame header sitting behind however much of it the camera wrote — routinely past the first 512
 * bytes. Reading the size from the head is what lets an oversized image be refused without
 * decoding the whole bitmap.
 *
 * Taken as a maximum rather than written as one number so this can only ever widen the sniffer's
 * own minimum, never silently undercut it if that minimum grows.
 */
const HEAD_BYTES = Math.max(SNIFF_BYTES, 65_536);

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
        if (headLength < HEAD_BYTES) {
          head.push(chunk);
          headLength += chunk.byteLength;
          sample.bytes = concat(head, Math.min(headLength, HEAD_BYTES));
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

/** Keeps the name honest about what the bytes are, without doubling a suffix the Agent got right. */
function withExtension(filename: string, format: RenderFormat): string {
  const extension = extensionForFormat(format);
  return filename.toLowerCase().endsWith(extension) ? filename : `${filename}${extension}`;
}

function once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
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

    const bounded = await this.bound(ref, mediaType, sample);

    return await this.deps.repo.create({
      id: this.deps.newId(),
      businessId: request.businessId,
      ownerPrincipalId: request.ownerPrincipalId,
      filename: normalizeFilename(request.filename),
      mediaType,
      claimedMediaType: request.claimedMediaType,
      sizeBytes: bounded.sizeBytes,
      blob: bounded.ref,
    });
  }

  /**
   * Writes a File an Agent authored: render first, then store, then share.
   *
   * The order matters for the same reason the upload pipeline's does. Rendering is the step that
   * can refuse — over the input cap, over the page cap, past the deadline — and doing it before
   * any byte reaches storage means a refusal costs nothing to compensate. The share lands last so
   * that a File is never readable before its bytes are.
   *
   * The media type is not sniffed. Unlike an upload, the bytes were produced here from a format
   * this service chose, so the claim and the content have the same author and a sniff would be
   * asking this process to confirm its own output.
   */
  async generate(request: GenerateRequest): Promise<FileRecord> {
    const rendered = await renderDocument({
      format: request.format,
      content: request.content,
      ...(request.title === undefined ? {} : { title: request.title }),
    });
    if (rendered.bytes.byteLength > MAX_FILE_BYTES) {
      throw new FileError("too_large", `rendered document exceeds ${MAX_FILE_BYTES} bytes`);
    }

    const filename = withExtension(normalizeFilename(request.filename), request.format);
    const ref = await this.deps.blobs.put(once(rendered.bytes), rendered.mediaType);
    const file = await this.deps.repo.create({
      id: this.deps.newId(),
      businessId: request.businessId,
      ownerPrincipalId: BUSINESS_PRINCIPAL_ID,
      filename,
      mediaType: rendered.mediaType,
      claimedMediaType: rendered.mediaType,
      sizeBytes: rendered.bytes.byteLength,
      blob: ref,
      origin: "generated",
    });

    const grantee = request.readableBy;
    if (
      grantee !== undefined &&
      !(grantee.kind === "user" && grantee.id === BUSINESS_PRINCIPAL_ID)
    ) {
      await this.deps.repo.share(request.businessId, file.id, grantee, BUSINESS_PRINCIPAL_ID);
    }
    return file;
  }

  /**
   * Applies the business's image-bounding policy before the row lands.
   *
   * Bounding happens at upload rather than when a File is put into a prompt because this is the
   * only moment the person who chose the file is present to be told. Refusing mid-Turn would
   * report a limit about a file they picked minutes ago, and only after they had already asked a
   * question about it.
   *
   * The stored bytes are the bounded ones, so a File is within the limit once and stays that way
   * — and what the person sees back in the message is exactly what the model was given.
   */
  private async bound(
    ref: BlobRef,
    mediaType: string,
    sample: { bytes: Uint8Array; size: number }
  ): Promise<{ ref: BlobRef; sizeBytes: number }> {
    if (!mediaType.startsWith("image/")) return { ref, sizeBytes: sample.size };

    const policy = (await this.deps.imagePolicy?.()) ?? {};
    // The head carries the dimensions, so the common cases — inside the limit, or refused —
    // decide without reading the object back.
    const headOutcome = await boundImage(sample.bytes, mediaType, {
      ...policy,
      downscaleImages: false,
    });
    if (headOutcome.kind === "accepted") return { ref, sizeBytes: sample.size };
    if (policy.downscaleImages !== true) {
      await this.discard(ref);
      throw new FileError("image_too_large", headOutcome.reason);
    }

    const outcome = await boundImage(await this.readAll(ref), mediaType, policy);
    if (outcome.kind === "refused") {
      await this.discard(ref);
      throw new FileError("image_too_large", outcome.reason);
    }
    const replacement = await this.deps.blobs.put(once(outcome.data), mediaType);
    await this.discard(ref);
    return { ref: replacement, sizeBytes: outcome.data.byteLength };
  }

  private async readAll(ref: BlobRef): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of await this.deps.blobs.get(ref)) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    return concat(chunks, total);
  }

  /**
   * The identities a read can be justified by: the reader, and every Role they hold right now.
   *
   * Resolved per read, never cached. That is the entire mechanism behind immediate revocation —
   * there is no derived state to invalidate, so removing a share or removing someone from a Role
   * is felt by the very next request.
   */
  private async granteesFor(
    businessId: string,
    principalId: string
  ): Promise<readonly FileGrantee[]> {
    const grantees: FileGrantee[] = [{ kind: "user", id: principalId }];
    const roles = await this.deps.rolesOf?.(businessId, principalId);
    for (const roleId of roles ?? []) grantees.push({ kind: "role", id: roleId });
    return grantees;
  }

  /**
   * Reads a File's metadata, refusing a Principal who neither owns it nor has been shared it.
   *
   * The ACL is consulted freshly on every request rather than cached, which is why this feature
   * has no presigned URLs: a presigned URL is an unrevocable bearer capability, and revocation
   * here has to take effect on the very next read.
   */
  async read(businessId: string, id: string, principalId: string): Promise<FileRecord> {
    const file = await this.deps.repo.get(businessId, id);
    if (file !== null && file.ownerPrincipalId === principalId) return file;

    // Both remaining outcomes are a 404, so both must cost the same. Short-circuiting on a missing
    // File would make "exists but not yours" the slower of two identical answers, and a caller
    // that can time the difference has the existence oracle the identical message denies them.
    // The owner's own read is above this and unaffected: its answer already differs.
    const [shares, grantees] = await Promise.all([
      this.deps.repo.listShares(businessId, id),
      this.granteesFor(businessId, principalId),
    ]);
    const permitted = shares.some((share) =>
      grantees.some((held) => held.kind === share.kind && held.id === share.id)
    );
    if (file !== null && permitted) return file;

    throw new FileError("not_found", `file ${id} does not exist`);
  }

  /**
   * Shares a File. Only its owner may, and a recipient is never given that power — which is what
   * stops a share from propagating past the one person who chose to grant it.
   */
  async share(
    businessId: string,
    id: string,
    ownerPrincipalId: string,
    grantee: FileGrantee
  ): Promise<void> {
    const file = await this.readAsOwner(businessId, id, ownerPrincipalId);
    if (grantee.kind === "user" && grantee.id === file.ownerPrincipalId) {
      throw new FileError("invalid_share", "a File is already readable by its owner");
    }
    await this.deps.repo.share(businessId, id, grantee, ownerPrincipalId);
  }

  /** Revokes a share. Answers whether one existed, so a caller can tell a revoke from a no-op. */
  async unshare(
    businessId: string,
    id: string,
    ownerPrincipalId: string,
    grantee: FileGrantee
  ): Promise<boolean> {
    await this.readAsOwner(businessId, id, ownerPrincipalId);
    return await this.deps.repo.unshare(businessId, id, grantee);
  }

  /** Who a File is shared with. Only its owner may ask; a recipient cannot enumerate the others. */
  async shares(businessId: string, id: string, ownerPrincipalId: string): Promise<FileShare[]> {
    await this.readAsOwner(businessId, id, ownerPrincipalId);
    return await this.deps.repo.listShares(businessId, id);
  }

  /** One page of Files shared with the caller, excluding the ones they already own. */
  async listSharedWithMe(
    businessId: string,
    principalId: string,
    limit: number,
    after?: FileCursor
  ): Promise<{ files: FileRecord[]; nextCursor: string | null }> {
    const grantees = await this.granteesFor(businessId, principalId);
    const page = await this.deps.repo.listSharedWith(
      businessId,
      principalId,
      grantees,
      limit + 1,
      after
    );
    const files = page.slice(0, limit);
    const last = files.at(-1);
    return { files, nextCursor: page.length > limit && last ? encodeFileCursor(last) : null };
  }

  /**
   * The File, if this Principal owns it.
   *
   * Every act of sharing goes through here rather than through `read`, because `read` now also
   * admits recipients — and a recipient who could re-share would make revocation meaningless.
   */
  private async readAsOwner(
    businessId: string,
    id: string,
    principalId: string
  ): Promise<FileRecord> {
    const file = await this.deps.repo.get(businessId, id);
    if (file === null || file.ownerPrincipalId !== principalId) {
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

  /**
   * Destroys a File: the row, every share of it, and the bytes themselves.
   *
   * Permanent by design, and that is the whole point — an instruction to erase something can only
   * be honoured truthfully if there is no copy left to produce later. There is no soft delete, no
   * tombstone row and no object versioning behind it to undo this.
   *
   * Returns what was destroyed so the caller can audit it. A sealed audit chain cannot be
   * rewritten, so an event naming only the vanished id would be evidence of nothing; the facts
   * that outlive the object have to be captured at the moment it stops existing.
   *
   * Only the owner may. A recipient of a share explicitly may not — destroying someone else's
   * File is a strictly larger power than reading it, and `read` now admits recipients.
   */
  async delete(businessId: string, id: string, ownerPrincipalId: string): Promise<FileRecord> {
    const file = await this.readAsOwner(businessId, id, ownerPrincipalId);
    // The row goes first, and the bytes only once nothing points at them. Reversing this would
    // leave a window where a row promises bytes that are already gone — and the dedup check would
    // answer "yes, this one still references them" if the row were still there.
    // Shares die with the row: `file_shares.file_id` cascades, so a recipient loses access here
    // rather than by a sweep that might not run.
    const deleted = await this.deps.repo.delete(businessId, id);
    if (deleted) await this.eraseBytes(file.blob);
    return file;
  }

  /**
   * Removes the object a destroyed File pointed at, unless another File still points at it.
   *
   * Unlike `discard`, a failure here is raised rather than swallowed. The row is already gone, so
   * the library is truthful either way and there is nothing left to retry against — but the caller
   * asked for erasure, and silence is precisely the failure mode that would let a misconfigured
   * bucket quietly retain everything anyone ever asked to erase.
   */
  private async eraseBytes(ref: BlobRef): Promise<void> {
    if (await this.deps.repo.anyReferencesBlob(ref.hash)) return;
    await this.deps.blobs.delete(ref);
  }

  /**
   * Which of `ids` this Principal can still read, for a caller rendering references it did not
   * fetch — a transcript, most of all.
   *
   * "Still there" and "still mine to see" are deliberately one answer. A File whose share was
   * revoked is as absent to this reader as one that was destroyed, and reporting them differently
   * would hand back the existence oracle the identical 404 in `read` is there to deny.
   */
  async presentFor(
    businessId: string,
    principalId: string,
    ids: readonly string[]
  ): Promise<ReadonlySet<string>> {
    if (ids.length === 0) return new Set();
    const grantees = await this.granteesFor(businessId, principalId);
    return new Set(await this.deps.repo.readableIds(businessId, principalId, grantees, ids));
  }

  async list(
    businessId: string,
    principalId: string,
    limit: number,
    after?: FileCursor
  ): Promise<FileRecord[]> {
    return await this.deps.repo.listByOwner(businessId, principalId, limit, after);
  }

  /**
   * One page of the caller's own Files, with the cursor that resumes after it.
   *
   * Reads one row past the page so "is there more" costs nothing extra, and hands back the cursor
   * already encoded — a caller should never have to know that the sort key is `(created_at, id)`.
   */
  async listPage(
    businessId: string,
    principalId: string,
    limit: number,
    after?: FileCursor
  ): Promise<{ files: FileRecord[]; nextCursor: string | null; shareCounts: Map<string, number> }> {
    const page = await this.list(businessId, principalId, limit + 1, after);
    const files = page.slice(0, limit);
    const last = files.at(-1);
    return {
      files,
      nextCursor: page.length > limit && last ? encodeFileCursor(last) : null,
      shareCounts: await this.deps.repo.countShares(
        businessId,
        files.map((file) => file.id)
      ),
    };
  }

  /**
   * Note that these Files were sent in a Conversation, so the library can say where one came from.
   *
   * Best-effort and deliberately not awaited into the send path's success: a message that was
   * accepted must not be reported as failed because a provenance note could not be written.
   */
  async noteSentIn(
    businessId: string,
    fileIds: readonly string[],
    conversationId: string
  ): Promise<void> {
    await this.deps.repo.recordFirstConversation(businessId, fileIds, conversationId);
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
